# File uploads — content-addressed blob store

**Status: shipped (migration `0014`).** Paste, drop, or attach an image and have it
appear inline in a message, without standing up object storage or pulling in a
dependency. Uploads land as
content-addressed blobs on a local volume, with metadata in Postgres, hidden
behind a small `BlobStore` interface. Everything is Go stdlib — `crypto/sha256`,
`io`, `os`, `http.DetectContentType` — consistent with the prime directive: one
backend dependency, zero transitive.

---

## Storage model

Content-addressing: the SHA-256 of the bytes *is* the name. `FSStore`
(`internal/blobs/blobs.go`) writes each blob to `blobs/<2-hex-prefix>/<sha256>`
under `RIVENDELL_BLOBS_DIR`, and a row in Postgres (migration `0014_blobs.sql`)
holds the metadata:

```sql
CREATE TABLE blobs (
    hash         TEXT        PRIMARY KEY,   -- 64-char lowercase sha256 hex
    uploader_id  BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    content_type TEXT        NOT NULL,      -- sniffed, never the client's header
    size         BIGINT      NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Naming by hash buys three things for free:

- **Dedup.** The same meme pasted ten times is one file and one row — `ON CONFLICT (hash) DO NOTHING` on the metadata, and a same-hash write is a no-op on disk.
- **Immutability.** Bytes never change under a hash, so reads carry an `immutable` cache header and an `ETag` and the app touches an image once.
- **Path-traversal immunity.** The filename is a hash, never user input. The read path still re-validates it as 64-char lowercase hex (`isValidBlobHash`) before touching disk.

---

## The interface

`BlobStore` hides the filesystem so swapping in object storage later is an
afternoon, not a rewrite:

```go
type BlobStore interface {
    Put(ctx context.Context, r io.Reader) (hash string, size int64, err error)
    Open(ctx context.Context, hash string) (io.ReadCloser, error)
    Exists(ctx context.Context, hash string) (bool, error)
}
```

`Put` tees the reader through SHA-256 while buffering, then writes
**atomically** — tmp file plus `rename` — so a concurrent reader never sees a
partial blob. `FSStore` is the only implementation today.

---

## Upload path — `POST /api/uploads`

`handleUploadBlob` is the whole server side, and its guardrails are the
load-bearing safety, not polish:

- **Hard size cap.** The body is wrapped in `http.MaxBytesReader(w, r.Body, MaxImageBytes)` *before* a byte is read — the one thing standing between the volume and someone filling it. `RIVENDELL_MAX_IMAGE_BYTES` defaults to 5 MiB.
- **Sniff, don't trust.** `http.DetectContentType` runs on the bytes and the result is allowlisted to `image/png|jpeg|webp|gif` (`isImageContentType`). Without this, "image uploads" silently becomes anonymous file hosting with our domain on it. The client's `Content-Type` header is never trusted.
- **Idempotent.** `FSStore.Put` dedups on disk and `CreateBlob` dedups the row, so the same bytes always return the same hash.

On success the handler returns `{hash, url, content_type, size}`, where `url` is
`/api/blobs/<hash>`. The client drops that into the message — the same
round-trip the avatar upload already does, no new client deps.

---

## Read path — `GET /api/blobs/{hash}`

`handleGetBlob` is **session-gated**. A SHA-256 URL is effectively unguessable,
but gating reads behind auth keeps an image as private as the channel it was
posted in — otherwise a leaked URL is a leaked image forever. Because the blob
is immutable, the response is aggressively cacheable:

- `Cache-Control: private, max-age=31536000, immutable` — `private`, not `public`, so a shared proxy never caches a gated image.
- `ETag: "<hash>"`, with an `If-None-Match` fast path returning `304`.

A malformed hash, a missing row, or a missing file all return a bare `404`.

---

## Frontend

All of it stays inside the no-framework ethos — no new client deps. The composer
picks up images from paste, drop, and an `<input type="file" accept="image/*">`
attach button, queues them in an attachment tray (`attachments.js`), and uploads
each via `api.uploadBlob(file)`, which POSTs the raw bytes to `/api/uploads` and
gets back the `{hash, url, …}`. The reference is then woven into the message body
on send (`composeMessageBody`). Display is plain CSS `max-width` — no
thumbnailing.

---

## Metadata stripping (EXIF/GPS) — client side, before upload

**Status: shipped (2.1.0).** Phone photos carry GPS; screenshots carry capture
timestamps. The store is content-addressed (the server hashes the raw bytes), so a
strip that *changes the bytes* has to happen **before** the hash — strip-then-hash,
never hash-then-strip. The only place that holds is the browser, before the POST.

`web/static/exif.js` does it, called from `attachments.js`'s one upload choke point
(`uploadAndInsert`), so every channel — paste, drop, file-picker, native-img — is
covered without `app.js` learning about it. The pure core, `stripMetadata(bytes) ->
Uint8Array`, sniffs the format by magic bytes (never the declared type, mirroring the
server's `http.DetectContentType`) and dispatches.

The strip is **surgical and lossless** — we walk the container structure and drop only
the metadata blocks; pixel data is copied byte-for-byte, so there's no re-compression,
bloat, or colour shift (the reason we did *not* take the easy canvas re-encode route):

- **JPEG** — walk marker segments; drop `APP1` (Exif/XMP), `APP13` (IPTC), `COM`, and
  every other `APPn` maker-note; keep `APP0`/JFIF and `APP2`/ICC; copy the scan data
  (`SOS`→EOF) verbatim. **Orientation** lives inside the deleted Exif, so it's read out
  and re-emitted as a minimal Exif segment carrying only that one tag — otherwise phone
  photos display sideways. GPS, capture time, thumbnail, XMP all vanish.
- **PNG** — drop `tEXt`/`zTXt`/`iTXt`/`eXIf`/`tIME`; keep everything else (IHDR, IDAT,
  colour chunks…) with its CRC untouched.
- **WebP** — drop `EXIF`/`XMP ` chunks, clear the matching `VP8X` feature flags, fix the
  RIFF size.
- **GIF / anything else** — returned untouched (no GPS to worry about; canvas re-encode
  would destroy animation).

Timestamps are **deleted, not fuzzed** — there's nothing left to correlate, and the
message already carries a server send-time. Unconditional, no UI toggle. Unit-tested in
`web/test/exif.test.js` (pure byte fixtures); the end-to-end privacy guarantee — GPS
never crosses the wire — is pinned by `web/e2e/exif-strip.spec.js`.

---

## Deliberately skipped

- **Thumbnails.** CSS `max-width` handles display; stdlib image resizing is crude enough that adding it now is effort against a problem we don't have. Easy to bolt on later.
- **Object storage.** The `BlobStore` interface is the seam for the day an OCI bucket is worth it. Until then a local volume is free on hardware we already run.
