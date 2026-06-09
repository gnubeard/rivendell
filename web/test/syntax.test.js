import { test } from "node:test";
import assert from "node:assert/strict";
import { highlight } from "../static/syntax.js";

// Regression for the ReDoS in the bash double-quoted-string rule (CWE-1333):
// the old regex's $varname branch overlapped the general-char branch, so an
// unterminated quote with many "$word" runs forced 2^n backtracking and hung
// the rendering tab. The rule is now the same linear `[^"\\]|\\.` form used by
// the other string rules, so this must complete near-instantly.
test("bash string highlighting does not catastrophically backtrack", () => {
  const evil = '"' + "$A0".repeat(50000); // no closing quote — the worst case
  const start = Date.now();
  const out = highlight(evil, "bash");
  const elapsed = Date.now() - start;
  assert.ok(typeof out === "string");
  assert.ok(elapsed < 2000, `highlight took ${elapsed}ms — possible ReDoS regression`);
});

// The new regex also fixes a latent gap: a bare `$` that isn't `${…}` or
// `$letter` (e.g. `$5`) is now consumed, so the whole string highlights. The
// old branches couldn't consume it and the string rule failed to match at all.
test("bash highlights a double-quoted string containing a bare $digit", () => {
  const out = highlight('"cost: $5"', "bash");
  assert.ok(
    out.includes('<span class="hl-str">&quot;cost: $5&quot;</span>'),
    `expected the whole string to be one hl-str span, got: ${out}`
  );
});

test("bash highlights ordinary and ${VAR}-bearing double-quoted strings", () => {
  assert.ok(highlight('"hello"', "bash").includes('<span class="hl-str">&quot;hello&quot;</span>'));
  assert.ok(highlight('"x${VAR}y"', "bash").includes('<span class="hl-str">&quot;x${VAR}y&quot;</span>'));
});
