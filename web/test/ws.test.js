import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReconnectOnResume } from "../static/ws.js";

const OPEN = 1;
const CLOSED = 3;
const CONNECTING = 0;

test("a healthy open socket after a brief hide is left alone", () => {
  assert.equal(shouldReconnectOnResume(OPEN, 2_000), false);
});

test("an open socket hidden long enough is treated as a zombie and rebuilt", () => {
  // A sleeping phone silently drops the TCP connection while readyState lies OPEN.
  assert.equal(shouldReconnectOnResume(OPEN, 60_000), true);
});

test("a non-open socket always reconnects regardless of hidden duration", () => {
  assert.equal(shouldReconnectOnResume(CLOSED, 0), true);
  assert.equal(shouldReconnectOnResume(CONNECTING, 0), true);
});

test("threshold boundary: strictly greater than threshold reconnects", () => {
  assert.equal(shouldReconnectOnResume(OPEN, 15_000, 15_000), false);
  assert.equal(shouldReconnectOnResume(OPEN, 15_001, 15_000), true);
});
