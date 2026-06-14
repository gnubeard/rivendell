import { test } from "node:test";
import assert from "node:assert/strict";
import { isNearBottom, NEAR_BOTTOM_PX } from "../static/history.js";

test("isNearBottom is true at the exact bottom", () => {
  // scrollTop maxed out: scrollHeight - scrollTop - clientHeight === 0.
  assert.equal(isNearBottom(1000, 800, 200), true);
});

test("isNearBottom is true within the default threshold", () => {
  // 79px from the bottom (< 80) still counts as pinned.
  assert.equal(isNearBottom(1000, 721, 200), true);
});

test("isNearBottom is false exactly at the threshold (exclusive boundary)", () => {
  // 80px away: matches the prior inline `< NEAR_BOTTOM_PX` — not near.
  assert.equal(isNearBottom(1000, 720, 200), false);
});

test("isNearBottom is false when scrolled well up", () => {
  assert.equal(isNearBottom(2000, 100, 200), false);
});

test("isNearBottom honours a custom threshold", () => {
  // 150px away: outside the default 80 but inside a 200 threshold.
  assert.equal(isNearBottom(1000, 650, 200), false);
  assert.equal(isNearBottom(1000, 650, 200, 200), true);
});

test("NEAR_BOTTOM_PX is the documented 80px default", () => {
  assert.equal(NEAR_BOTTOM_PX, 80);
  // The default-arg path agrees with passing it explicitly.
  assert.equal(isNearBottom(1000, 721, 200), isNearBottom(1000, 721, 200, NEAR_BOTTOM_PX));
});
