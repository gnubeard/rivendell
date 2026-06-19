import { test } from "node:test";
import assert from "node:assert/strict";
import { stripMetadata, stripJpeg, stripPng, stripWebp } from "../static/exif.js";

// --- helpers ----------------------------------------------------------------

const u8 = (arr) => new Uint8Array(arr);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

// A JPEG marker segment: FF <marker> <2-byte length incl. itself> <payload>.
function seg(marker, payload) {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}

// A PNG chunk: length(4 BE) + type(4) + data + CRC(4). CRC is irrelevant here since
// the stripper copies or drops whole chunks; we use zeros.
function pngChunk(type, data) {
  const len = data.length;
  return [
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...ascii(type), ...data, 0, 0, 0, 0,
  ];
}

// A WebP RIFF chunk: fourcc(4) + size(4 LE) + data. Sizes here are kept even so no
// pad byte is needed.
function webpChunk(fourcc, data) {
  const n = data.length;
  return [...ascii(fourcc), n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff, ...data];
}

function indexOfSeq(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
const contains = (hay, needle) => indexOfSeq(hay, needle) !== -1;
const containsStr = (hay, s) => contains(hay, ascii(s));

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]); // 1x1 RGBA
const IDAT = pngChunk("IDAT", [0x78, 0x9c, 0x62, 0x00, 0x01]);
const IEND = pngChunk("IEND", []);

// Exif IFD0 with Orientation=`o`, plus a trailing private "GPSLEAK!" sentinel that
// must not survive the strip.
function exifPayload(o) {
  return [
    ...ascii("Exif"), 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, IFD0 @ 8
    0x01, 0x00, // one entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, o & 0xff, (o >> 8) & 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // next IFD = 0
    ...ascii("GPSLEAK!"),
  ];
}

// The exact minimal Exif segment the stripper re-emits for a given orientation.
function expectedExif(o) {
  return [
    0xff, 0xe1, 0x00, 0x22,
    ...ascii("Exif"), 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, o & 0xff, (o >> 8) & 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
}

const JFIF = seg(0xe0, [...ascii("JFIF"), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
const ICC = seg(0xe2, ascii("ICC_PROFILE\0ICCKEEP!"));
const COM = seg(0xfe, ascii("COMLEAK!"));
const DQT = seg(0xdb, [0x00, 0x01, 0x02, 0x03]);
const SCAN_TAIL = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xab, 0xcd, 0xef, 0xff, 0xd9];

// --- JPEG -------------------------------------------------------------------

test("stripJpeg drops Exif/GPS, XMP-style COM and keeps JFIF, ICC, pixels", () => {
  const input = u8([0xff, 0xd8, ...JFIF, ...seg(0xe1, exifPayload(6)), ...ICC, ...COM, ...DQT, ...SCAN_TAIL]);
  const out = stripJpeg(input);

  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xd8);
  assert.ok(!containsStr(out, "GPSLEAK!"), "GPS data must be gone");
  assert.ok(!containsStr(out, "COMLEAK!"), "COM comment must be gone");
  assert.ok(containsStr(out, "JFIF"), "JFIF APP0 kept");
  assert.ok(containsStr(out, "ICCKEEP!"), "ICC colour profile kept");

  // Orientation 6 is re-emitted as a fresh minimal Exif segment, right after APP0.
  assert.ok(contains(out, expectedExif(6)), "orientation re-emitted");

  // The DQT and the entire scan from SOS onward are copied byte-for-byte.
  assert.ok(contains(out, DQT), "quantisation table preserved");
  const sos = indexOfSeq(out, SCAN_TAIL);
  assert.ok(sos !== -1, "scan data preserved verbatim");
  assert.deepEqual([...out.subarray(sos)], SCAN_TAIL);
});

test("stripJpeg does not re-emit Exif when orientation is the default (1)", () => {
  const input = u8([0xff, 0xd8, ...JFIF, ...seg(0xe1, exifPayload(1)), ...SCAN_TAIL]);
  const out = stripJpeg(input);
  assert.ok(!containsStr(out, "GPSLEAK!"));
  assert.ok(!containsStr(out, "Exif"), "no Exif segment when orientation is 1");
});

test("stripJpeg is a no-op (same reference) when there's nothing to strip", () => {
  const input = u8([0xff, 0xd8, ...JFIF, ...DQT, ...SCAN_TAIL]);
  assert.equal(stripJpeg(input), input);
});

// --- PNG --------------------------------------------------------------------

test("stripPng drops tEXt/tIME/eXIf and keeps IHDR/IDAT/IEND verbatim", () => {
  const tEXt = pngChunk("tEXt", ascii("Comment\0PNGLEAK!"));
  const tIME = pngChunk("tIME", [0x07, 0xe9, 0x06, 0x13, 0x0e, 0x20, 0x07]);
  const eXIf = pngChunk("eXIf", ascii("II*\0EXIFLEAK!"));
  const input = u8([...PNG_SIG, ...IHDR, ...tEXt, ...tIME, ...eXIf, ...IDAT, ...IEND]);
  const out = stripPng(input);

  assert.ok(!containsStr(out, "PNGLEAK!"), "tEXt removed");
  assert.ok(!containsStr(out, "EXIFLEAK!"), "eXIf removed");
  assert.ok(!contains(out, tIME), "tIME removed");
  assert.ok(contains(out, IHDR), "IHDR preserved");
  assert.ok(contains(out, IDAT), "image data preserved");
  assert.ok(contains(out, IEND), "IEND preserved");
  // Exactly the four dropped-chunk bytes were removed.
  assert.equal(out.length, input.length - tEXt.length - tIME.length - eXIf.length);
});

test("stripPng is a no-op (same reference) for a clean screenshot", () => {
  const input = u8([...PNG_SIG, ...IHDR, ...IDAT, ...IEND]);
  assert.equal(stripPng(input), input);
});

// --- WebP -------------------------------------------------------------------

test("stripWebp drops EXIF/XMP chunks, clears VP8X flags, fixes RIFF size", () => {
  // VP8X payload: flags byte (EXIF+XMP set) + 3 reserved + 6 canvas-size bytes.
  const vp8x = webpChunk("VP8X", [0x08 | 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const exif = webpChunk("EXIF", ascii("II*\0WEBPLEAK!!"));
  const vp8 = webpChunk("VP8 ", [0x10, 0x20, 0x30, 0x40]);
  const body = [...vp8x, ...exif, ...vp8];
  const size = body.length + 4; // + "WEBP"
  const input = u8([
    ...ascii("RIFF"), size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff,
    ...ascii("WEBP"), ...body,
  ]);
  const out = stripWebp(input);

  assert.ok(!containsStr(out, "WEBPLEAK!!"), "EXIF chunk removed");
  assert.ok(contains(out, vp8), "image bitstream preserved");
  // VP8X is the first chunk after the 12-byte RIFF/WEBP header; flag byte at +8.
  const flags = out[12 + 8];
  assert.equal(flags & (0x08 | 0x04), 0, "EXIF/XMP feature flags cleared");
  const riffSize = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
  assert.equal(riffSize, out.length - 8, "RIFF size fixed up");
});

// --- dispatch / passthrough -------------------------------------------------

test("stripMetadata dispatches on magic bytes, not the declared type", () => {
  const png = u8([...PNG_SIG, ...IHDR, ...pngChunk("tEXt", ascii("X\0LEAK")), ...IDAT, ...IEND]);
  assert.ok(!containsStr(stripMetadata(png), "LEAK"));
});

test("stripMetadata returns GIF and unknown formats untouched (same reference)", () => {
  const gif = u8([...ascii("GIF89a"), 1, 2, 3, 4]);
  const other = u8([1, 2, 3, 4, 5]);
  assert.equal(stripMetadata(gif), gif);
  assert.equal(stripMetadata(other), other);
});
