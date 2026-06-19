// exif.js — strip identifying metadata from images before they leave the browser.
//
// Phone photos carry GPS in EXIF; screenshots carry capture timestamps. The blob
// store is content-addressed (the server hashes the raw bytes), so stripping has
// to happen client-side, BEFORE upload — strip-then-hash, never hash-then-strip
// (see docs/design/uploads.md). attachments.js calls stripImageFile() at the one
// upload choke point; app.js stays out of it.
//
// The strip is SURGICAL and LOSSLESS: we walk the container structure (JPEG marker
// segments, PNG/WebP chunks) and drop only the metadata blocks — the pixel data is
// copied through byte-for-byte, so there is no re-compression, no bloat, no colour
// shift. The one exception is JPEG orientation: it lives inside the Exif block we
// delete, so we read it out and re-emit a minimal Exif segment carrying only that
// one tag, otherwise phone photos would display sideways.
//
// What goes: JPEG APP1(Exif/XMP)/APP13(IPTC)/COM + all other APPn maker-notes;
// PNG tEXt/zTXt/iTXt/eXIf/tIME; WebP EXIF/XMP chunks. What stays: JFIF, ICC colour
// profiles, and every byte of actual image data.
//
// stripMetadata(bytes) is pure (Uint8Array -> Uint8Array) and unit-tested in
// web/test/exif.test.js; stripImageFile(file) is the browser File adapter, covered
// by web/e2e.

// JPEG markers.
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const COM = 0xfe;
const APP1 = 0xe1;
const ORIENTATION_TAG = 0x0112;

// PNG chunk types we delete (everything else — IHDR, PLTE, IDAT, IEND, gAMA, cHRM,
// iCCP, sRGB, sBIT, pHYs, tRNS, bKGD … — is copied verbatim, CRC and all).
const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

// stripMetadata sniffs the format by its magic bytes (like the server's
// http.DetectContentType — the declared type is never trusted) and dispatches to a
// surgical stripper. Formats without a stripper (GIF, anything unknown) are returned
// unchanged. Returns the SAME reference when nothing was removed, so callers can cheaply
// detect a no-op.
export function stripMetadata(bytes) {
  if (isJpeg(bytes)) return stripJpeg(bytes);
  if (isPng(bytes)) return stripPng(bytes);
  if (isWebp(bytes)) return stripWebp(bytes);
  return bytes;
}

function isJpeg(b) {
  return b.length >= 3 && b[0] === 0xff && b[1] === SOI && b[2] === 0xff;
}

function isPng(b) {
  return (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  );
}

function isWebp(b) {
  return (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // "WEBP"
  );
}

// stripJpeg walks the marker segments from SOI up to SOS, dropping the metadata-
// carrying ones and copying the rest. From SOS onward (the entropy-coded scan data,
// which has no length field) the file is copied verbatim. The deleted Exif block is
// scanned for an Orientation tag first; if found (and not the default 1), a minimal
// Exif segment carrying only that tag is re-emitted so the image still displays
// right-side-up.
export function stripJpeg(bytes) {
  const kept = []; // {marker, seg: Uint8Array} for segments before SOS we keep
  let orientation = 0;
  let dropped = false;
  let tail = null; // bytes from SOS to EOF, copied verbatim

  let i = 2; // past SOI
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) break; // not at a marker — bail, copy the remainder below
    const marker = bytes[i + 1];

    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === EOI) { tail = bytes.subarray(i); break; }
    if (marker === SOS) { tail = bytes.subarray(i); break; }
    // Standalone markers (TEM 0x01, RST 0xD0–0xD7) have no payload; none legitimately
    // appear before SOS, but skip defensively rather than misread a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }

    if (i + 3 >= bytes.length) break;
    const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
    const segEnd = i + 2 + segLen;
    if (segLen < 2 || segEnd > bytes.length) break; // malformed — stop, copy remainder

    const isApp = marker >= 0xe0 && marker <= 0xef;
    // Keep JFIF (APP0) and ICC colour profiles (APP2); drop every other APPn and COM.
    const keep = !(marker === COM || (isApp && marker !== 0xe0 && marker !== 0xe2));

    if (marker === APP1) {
      const o = readExifOrientation(bytes.subarray(i + 4, segEnd));
      if (o) orientation = o;
    }
    if (keep) kept.push({ marker, seg: bytes.subarray(i, segEnd) });
    else dropped = true;
    i = segEnd;
  }

  if (tail === null) tail = bytes.subarray(i); // ran off the end without hitting SOS
  const wantExif = orientation && orientation !== 1;
  if (!dropped && !wantExif) return bytes; // nothing to do

  const parts = [bytes.subarray(0, 2)]; // SOI
  let k = 0;
  // JFIF (APP0) must lead; slot our synthetic Exif right after it (or after SOI).
  if (kept.length && kept[0].marker === 0xe0) { parts.push(kept[0].seg); k = 1; }
  if (wantExif) parts.push(buildExifOrientation(orientation));
  for (; k < kept.length; k++) parts.push(kept[k].seg);
  parts.push(tail);
  return concat(parts);
}

// readExifOrientation reads the IFD0 Orientation tag out of an APP1 payload (the bytes
// after the 2-byte segment length). Returns 0 when the payload isn't Exif or has no
// orientation. Handles both II (little-endian) and MM (big-endian) byte orders.
function readExifOrientation(p) {
  if (p.length < 14) return 0;
  // "Exif\0\0"
  if (!(p[0] === 0x45 && p[1] === 0x78 && p[2] === 0x69 && p[3] === 0x66 && p[4] === 0 && p[5] === 0)) {
    return 0;
  }
  const t = 6; // TIFF header start
  let le;
  if (p[t] === 0x49 && p[t + 1] === 0x49) le = true;
  else if (p[t] === 0x4d && p[t + 1] === 0x4d) le = false;
  else return 0;
  const u16 = (o) => (le ? p[o] | (p[o + 1] << 8) : (p[o] << 8) | p[o + 1]);
  const u32 = (o) =>
    (le
      ? p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)
      : (p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0;
  if (u16(t + 2) !== 42) return 0;
  const ifd0 = t + u32(t + 4);
  if (ifd0 + 2 > p.length) return 0;
  const n = u16(ifd0);
  for (let e = 0; e < n; e++) {
    const entry = ifd0 + 2 + e * 12;
    if (entry + 12 > p.length) break;
    if (u16(entry) === ORIENTATION_TAG) return u16(entry + 8); // SHORT value in-line
  }
  return 0;
}

// buildExifOrientation produces a minimal APP1/Exif segment carrying ONLY the
// Orientation tag (little-endian TIFF). Nothing else from the original Exif survives.
function buildExifOrientation(orientation) {
  const payload = [
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF: II, 42, IFD0 @ offset 8
    0x01, 0x00, // IFD0 entry count = 1
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, // tag 0x0112, type SHORT, count 1
    orientation & 0xff, (orientation >> 8) & 0xff, 0x00, 0x00, // value (+ pad)
    0x00, 0x00, 0x00, 0x00, // next IFD = 0
  ];
  const len = payload.length + 2; // segment length includes its own 2 bytes
  return new Uint8Array([0xff, APP1, (len >> 8) & 0xff, len & 0xff, ...payload]);
}

// stripPng copies the 8-byte signature then every chunk except the metadata ones.
// Each chunk is length(4) + type(4) + data(length) + CRC(4); kept chunks (and their
// CRCs) are copied untouched, so dropping whole chunks needs no CRC recompute.
export function stripPng(bytes) {
  const parts = [bytes.subarray(0, 8)];
  let dropped = false;
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const end = i + 12 + (len >>> 0);
    if (len < 0 || end > bytes.length) break; // malformed — keep what we have
    if (PNG_DROP.has(type)) dropped = true;
    else parts.push(bytes.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return dropped ? concat(parts) : bytes;
}

// WebP VP8X feature-flag bits (first byte of the VP8X chunk payload, MSB first:
// Rsv Rsv ICC Alpha EXIF XMP Anim Rsv).
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

// stripWebp walks the RIFF container, drops the EXIF and XMP chunks, clears the
// matching feature-flag bits in the VP8X header, and fixes the outer RIFF size.
export function stripWebp(bytes) {
  const parts = [bytes.subarray(0, 12)]; // "RIFF" + size + "WEBP"
  let dropped = false;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
    const end = i + 8 + size + (size & 1); // chunks are padded to an even length
    if (end > bytes.length) break; // malformed — keep what we have

    if (fourcc === "EXIF" || fourcc === "XMP ") {
      dropped = true;
    } else if (fourcc === "VP8X") {
      const seg = bytes.slice(i, end); // copy: we clear the EXIF/XMP flag bits
      seg[8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      parts.push(seg);
    } else {
      parts.push(bytes.subarray(i, end));
    }
    i = end;
  }
  if (!dropped) return bytes;
  const out = concat(parts);
  const riffSize = out.length - 8;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >> 24) & 0xff;
  return out;
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// stripImageFile is the browser adapter: read the File, strip, and re-wrap. Returns
// the original File untouched when nothing was removed (the common case for clean
// screenshots), avoiding a needless copy.
export async function stripImageFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const out = stripMetadata(bytes);
  if (out === bytes) return file;
  return new File([out], file.name, { type: file.type, lastModified: file.lastModified });
}
