import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBlobUrls } from "../static/imagewarm.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const blob = (h) => `/api/blobs/${h}`;
const img = (h, alt = "") => `![${alt}](${blob(h)})`;

test("extractBlobUrls: pulls blob paths out of image markdown", () => {
  const msgs = [{ content: `look ${img(HASH_A)} ok` }];
  assert.deepEqual(extractBlobUrls(msgs, 5), [blob(HASH_A)]);
});

test("extractBlobUrls: walks messages newest-first (array order) and flattens", () => {
  const msgs = [
    { content: `${img(HASH_A)} ${img(HASH_B)}` },
    { content: img(HASH_C) },
  ];
  assert.deepEqual(extractBlobUrls(msgs, 5), [blob(HASH_A), blob(HASH_B), blob(HASH_C)]);
});

test("extractBlobUrls: stops at the limit mid-message", () => {
  const msgs = [{ content: `${img(HASH_A)} ${img(HASH_B)} ${img(HASH_C)}` }];
  assert.deepEqual(extractBlobUrls(msgs, 2), [blob(HASH_A), blob(HASH_B)]);
});

test("extractBlobUrls: stops at the limit across messages", () => {
  const msgs = [{ content: img(HASH_A) }, { content: img(HASH_B) }, { content: img(HASH_C) }];
  assert.deepEqual(extractBlobUrls(msgs, 2), [blob(HASH_A), blob(HASH_B)]);
});

test("extractBlobUrls: a zero limit yields nothing", () => {
  assert.deepEqual(extractBlobUrls([{ content: img(HASH_A) }], 0), []);
});

test("extractBlobUrls: messages with no images contribute nothing", () => {
  const msgs = [{ content: "just text, https://example.com not an embed" }, { content: img(HASH_A) }];
  assert.deepEqual(extractBlobUrls(msgs, 5), [blob(HASH_A)]);
});

test("extractBlobUrls: alt text (including brackets-free) is ignored, only the path is taken", () => {
  const msgs = [{ content: img(HASH_A, "a cat") }];
  assert.deepEqual(extractBlobUrls(msgs, 5), [blob(HASH_A)]);
});

test("extractBlobUrls: ignores non-blob image URLs and malformed hashes", () => {
  const msgs = [
    { content: "![x](https://cdn.example.com/pic.png)" },   // external, not /api/blobs
    { content: "![x](/api/blobs/short)" },                   // hash too short
    { content: `![x](/api/blobs/${"g".repeat(64)})` },       // non-hex chars
    { content: img(HASH_A) },                                // the one real hit
  ];
  assert.deepEqual(extractBlobUrls(msgs, 5), [blob(HASH_A)]);
});

test("extractBlobUrls: the same url appearing twice is returned twice (no dedupe here)", () => {
  const msgs = [{ content: `${img(HASH_A)} and again ${img(HASH_A)}` }];
  assert.deepEqual(extractBlobUrls(msgs, 5), [blob(HASH_A), blob(HASH_A)]);
});

test("extractBlobUrls: an empty message list yields nothing", () => {
  assert.deepEqual(extractBlobUrls([], 5), []);
});
