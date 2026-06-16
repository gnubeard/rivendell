// Guards the app.js "atlas" (docs/atlas.md): the coarse REGION banners that map the
// file, and their cross-reference to the doc. These are prose-next-to-code, so they
// can silently drift; this test keeps them honest. It reads app.js as TEXT (never
// imports it — app.js is DOM-carrying and unimportable under node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appJs = readFileSync(join(here, "..", "static", "app.js"), "utf8");
const atlasMd = readFileSync(join(here, "..", "..", "docs", "atlas.md"), "utf8");

const regionNums = [...appJs.matchAll(/^\/\/ ▌ REGION (\d+) · /gm)].map((m) => Number(m[1]));

test("app.js REGION banners are present and numbered 1..N in file order", () => {
  assert.ok(regionNums.length >= 1, "expected at least one // ▌ REGION banner in app.js");
  assert.deepEqual(
    regionNums,
    regionNums.map((_, i) => i + 1),
    "REGION banners must be numbered 1..N with no gaps, in file order",
  );
});

test("each REGION banner sits under a heavy ━ rule (a tier above the // --- markers)", () => {
  const lines = appJs.split("\n");
  lines.forEach((line, i) => {
    if (/^\/\/ ▌ REGION /.test(line)) {
      assert.match(lines[i - 1] || "", /━━━/, `REGION banner at line ${i + 1} must sit directly under a ━ rule`);
    }
  });
});

test("docs/atlas.md stays in sync with app.js's regions", () => {
  const docHeads = [...atlasMd.matchAll(/^### R(\d+) · /gm)].map((m) => Number(m[1]));
  assert.deepEqual(
    docHeads,
    regionNums.map((_, i) => i + 1),
    "atlas.md must carry one `### R<n> ·` heading per app.js REGION banner, in order",
  );
  const tableRows = [...atlasMd.matchAll(/^\| (\d+) \| \*\*/gm)].length;
  assert.equal(tableRows, regionNums.length, "atlas.md's continents table must have one row per region");
});
