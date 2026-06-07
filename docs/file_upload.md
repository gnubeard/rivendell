**The recommendation: content-addressed files on a local volume, metadata in Postgres, hidden behind a tiny interface.** This is the sweet spot for "cheapest, no cliff, philosophically harmonious." Everything is Go stdlib — `crypto/sha256`, `io`, `os`, `http.DetectContentType`, `mime`. No new dependency, which matters given the repo's whole identity is "one dependency, zero transitive."

The shape:

```go
type BlobStore interface {
    Put(ctx context.Context, r io.Reader) (hash string, size int64, err error)
    Open(ctx context.Context, hash string) (io.ReadCloser, error)
    Exists(ctx context.Context, hash string) (bool, error)
}
```

Implement `FSStore` now — hash the upload, write to `blobs/ab/cd/<full-sha256>`, return the hash. Postgres holds a row per image (`hash`, `uploader_id`, `content_type`, `size`, `created_at`, maybe `message_id`). Content-addressing buys you a lot for free: automatic dedup (the same meme pasted ten times is one file), immutable blobs (so you serve `Cache-Control: public, max-age=31536000, immutable` and let nginx or a CDN carry every read — your app touches an image once), and safe filenames with no path-traversal surface because the name is a hash, never user input.

The guardrails that keep this from becoming an infrastructure nightmare or an open file host are not optional, and they're all small:

- **A hard size cap**, mirroring what you did for avatars — `RIVENDELL_MAX_IMAGE_BYTES`, enforced by wrapping the request body in `http.MaxBytesReader` *before* you read a byte. This is the single thing standing between you and someone filling your volume.
- **Sniff, don't trust.** Run `http.DetectContentType` on the first 512 bytes and allowlist `image/png|jpeg|webp|gif`. Reject everything else. Without this, "image uploads" silently becomes "anonymous file hosting / malware CDN with my domain on it."
- **Decide read auth.** A sha256 URL is effectively unguessable, so capability-by-hash is probably fine for a private server — but it does mean a leaked URL is a leaked image forever. Gating reads behind the session is a few lines more and keeps images as private as the channels they live in. For a friends server I'd gate them; it matches the "small private room" framing.
- **EXIF is worth a thought** given phone uploads carry GPS. Stripping it means decoding and re-encoding, which changes the bytes — so do it *before* hashing, or you break content-addressing. Easy to skip for v1, easy to bolt on later, just don't hash-then-strip.

On the frontend, all of this stays inside your no-framework ethos. Clipboard paste is a `paste` listener reading `clipboardData.items`; phone upload is `<input type="file" accept="image/*">` plus a `drop` handler. Roughly:

```js
editor.addEventListener('paste', e => {
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) uploadBlob(item.getAsFile());
  }
});
```

`uploadBlob` POSTs to your new endpoint, gets back a hash/URL, and inserts a reference into the message — same round-trip your avatar upload already does, no new client deps.

I'd deliberately skip thumbnails for v1. CSS `max-width` handles display fine, and stdlib image resizing is crude enough that adding it now is effort spent against a problem you don't have yet.

Net: filesystem + content-addressing + Postgres metadata, behind a `BlobStore` interface, with a size cap and content sniffing as the load-bearing safety. It's all stdlib, it's free on hardware you already run, and the interface means the day you want OCI's bucket you've already paid for, it's an afternoon, not a rewrite.
