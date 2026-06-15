import { test } from "node:test";
import assert from "node:assert/strict";
import { filterEmoji } from "../static/emoji.js";

const COMMON = [
  { name: "fire", glyph: "🔥" },
  { name: "tada", glyph: "🎉" },
  { name: "thumbsdown", glyph: "👎" },
];
const CUSTOM = ["blobcat", "firewall", "shipit"];

test("empty query passes both sections through unchanged (copies, not aliases)", () => {
  const { common, custom } = filterEmoji("", COMMON, CUSTOM);
  assert.deepEqual(common, COMMON);
  assert.deepEqual(custom, CUSTOM);
  assert.notEqual(common, COMMON); // a slice, so the caller can't mutate the source
  assert.notEqual(custom, CUSTOM);
});

test("query matches the quick palette by shortcode name and custom by shortcode", () => {
  // "fire" matches the builtin :fire: AND the custom :firewall: — both sections filter.
  const { common, custom } = filterEmoji("fire", COMMON, CUSTOM);
  assert.deepEqual(common.map((e) => e.name), ["fire"]);
  assert.deepEqual(custom, ["firewall"]);
});

test("query is a plain substring match; a miss yields empty sections", () => {
  assert.deepEqual(filterEmoji("ship", COMMON, CUSTOM), { common: [], custom: ["shipit"] });
  assert.deepEqual(filterEmoji("nope", COMMON, CUSTOM), { common: [], custom: [] });
});
