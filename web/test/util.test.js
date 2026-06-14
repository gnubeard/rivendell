import { test } from "node:test";
import assert from "node:assert/strict";
import { humanBytes, formatTime, overSizeLimit } from "../static/util.js";

test("humanBytes shows whole bytes below 1 KB", () => {
  assert.equal(humanBytes(0), "0 B");
  assert.equal(humanBytes(1), "1 B");
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(1023), "1023 B");
});

test("humanBytes promotes to KB/MB/GB at the 1024 boundaries", () => {
  assert.equal(humanBytes(1024), "1 KB");
  assert.equal(humanBytes(1024 * 1024), "1 MB");
  assert.equal(humanBytes(1024 * 1024 * 1024), "1 GB");
});

test("humanBytes drops the decimal for whole-number values", () => {
  assert.equal(humanBytes(2048), "2 KB");
  assert.equal(humanBytes(5 * 1024 * 1024), "5 MB");
});

test("humanBytes keeps one decimal for non-whole values under 10", () => {
  assert.equal(humanBytes(1536), "1.5 KB"); // 1.5
  assert.equal(humanBytes(1024 * 2.5), "2.5 KB");
});

test("humanBytes rounds to a whole number once the value reaches 10", () => {
  assert.equal(humanBytes(1024 * 10.5), "11 KB"); // ≥10 → rounded, no decimal
  assert.equal(humanBytes(1024 * 15), "15 KB");
});

test("humanBytes caps the unit at GB rather than going to TB", () => {
  // 2048 GB stays in GB (the unit table stops at GB).
  assert.equal(humanBytes(2048 * 1024 * 1024 * 1024), "2048 GB");
});

// ---- overSizeLimit ----

test("overSizeLimit rejects a file strictly over the limit", () => {
  assert.equal(overSizeLimit(1025, 1024), true);
});

test("overSizeLimit allows a file at or under the limit (inclusive boundary)", () => {
  assert.equal(overSizeLimit(1024, 1024), false);
  assert.equal(overSizeLimit(1, 1024), false);
});

test("overSizeLimit skips the check for an unknown (0/falsy) limit", () => {
  assert.equal(overSizeLimit(999999, 0), false);
  assert.equal(overSizeLimit(999999, undefined), false);
});

// formatTime is locale-driven (toLocaleTimeString/DateString), so we assert on
// its same-day-vs-other-day *shape* rather than exact punctuation, which varies
// by the runtime's locale.

test("formatTime shows time only for a same-day timestamp", () => {
  const now = new Date();
  const sameDay = new Date(now);
  sameDay.setHours(9, 5, 0, 0); // 09:05 today, regardless of when the test runs
  const expected = sameDay.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  assert.equal(formatTime(sameDay.toISOString()), expected);
});

test("formatTime prefixes the date for an other-day timestamp", () => {
  const then = new Date("2000-01-02T09:05:00"); // local time, definitely not today
  const time = then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const expected = `${then.toLocaleDateString()} ${time}`;
  assert.equal(formatTime(then), expected);
  // and the other-day form is strictly longer than the bare time
  assert.ok(formatTime(then).length > time.length);
});
