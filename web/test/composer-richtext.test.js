import { test } from "node:test";
import assert from "node:assert/strict";
import { decorate, createUndoHistory, toggleMarker, flankedDelete } from "../static/composer-richtext.js";
import { formatMessage } from "../static/format.js";

// Reverse of escapeHtml + tag stripping: recover the plain source text that the
// browser would expose as the field's text content from a decorate() result.
// <br> becomes "\n" (matching composer-field's textOf); all spans drop away
// leaving their text; entities decode. This is exactly the round-trip the caret
// math depends on.
function sourceOf(html) {
  return html
    .replace(/<br>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ---- fidelity: the load-bearing invariant ----
// decorate must NEVER add or remove a character. Strip the decoration and you
// get the exact source back — otherwise the facade's text-offset caret math
// drifts and the caret jumps as you type.

const FIDELITY_CASES = [
  "",
  "plain text",
  "**bold**",
  "*italic* and _also_",
  "~~strike~~ and `code`",
  "||spoiler||",
  "nested **bold _and italic_ together**",
  "trailing marker **",
  "lone * star and _ underscore",
  "multi\nline\n**bold** on line 2",
  "html-ish <b>&'\" chars & *bold*",
  "code keeps *its* `**stars**` literal",
  "a\n\nb", // blank line preserved
  "ends with newline\n",
  "```js\nconst x = 1;\n```",      // fenced code block
  "```\nplain block\nline two\n```",
  "before\n```py\ncode\n```\nafter", // block between prose
  "```\nunclosed block\nstill code", // unclosed fence runs to the end
  "```\n\n```",                    // empty line inside a block
  "text with ``` mid-line backticks", // not a fence (not its own line)
];

for (const input of FIDELITY_CASES) {
  test(`fidelity: decorate preserves every character — ${JSON.stringify(input)}`, () => {
    assert.equal(sourceOf(decorate(input)), input);
  });
}

// ---- decoration: the right runs light up, markers stay ----

test("bold wraps the run and keeps both ** markers dimmed", () => {
  const out = decorate("a **b** c");
  assert.match(out, /<span class="md-strong"><span class="md-mk">\*\*<\/span>b<span class="md-mk">\*\*<\/span><\/span>/);
});

test("italic with * and with _ both produce md-em", () => {
  assert.match(decorate("*x*"), /<span class="md-em"><span class="md-mk">\*<\/span>x<span class="md-mk">\*<\/span><\/span>/);
  assert.match(decorate("_y_"), /<span class="md-em"><span class="md-mk">_<\/span>y<span class="md-mk">_<\/span><\/span>/);
});

test("strike and code and spoiler decorate", () => {
  assert.match(decorate("~~s~~"), /<span class="md-del">/);
  assert.match(decorate("`c`"), /<span class="md-code">/);
  assert.match(decorate("||sp||"), /<span class="md-spoiler">/);
});

test("markdown inside `code` is NOT decorated", () => {
  const out = decorate("`**not bold**`");
  assert.doesNotMatch(out, /md-strong/);
  assert.match(out, /<span class="md-code">/);
});

test("a fenced ``` block styles its lines, dims the fences, and tints the language", () => {
  const out = decorate("```js\ncode\n```");
  // both fence lines are code-block fence spans, with the ``` as a dimmed marker
  assert.equal((out.match(/md-cb-fence/g) || []).length, 2);
  assert.match(out, /<span class="md-cb-lang">js<\/span>/);
  // the content line is a code-block strip
  assert.match(out, /<span class="md-codeblock">code<\/span>/);
});

test("markdown inside a fenced block is literal (not decorated)", () => {
  const out = decorate("```\n**not bold** and *not italic*\n```");
  assert.doesNotMatch(out, /md-strong|md-em/);
});

test("an unclosed fence runs to the end as code", () => {
  const out = decorate("```\nstill code");
  assert.equal((out.match(/md-cb-fence/g) || []).length, 1); // only the opening fence
  assert.match(out, /<span class="md-codeblock">still code<\/span>/);
});

test("``` mid-line is NOT a fence (only a whole ``` line opens one)", () => {
  const out = decorate("see ``` here");
  assert.doesNotMatch(out, /md-codeblock/);
});

test("incomplete pair is left plain (no flicker until closed)", () => {
  assert.doesNotMatch(decorate("**half"), /md-strong/);
  assert.doesNotMatch(decorate("*half"), /md-em/);
});

test("HTML-special characters are escaped, not interpreted", () => {
  const out = decorate("<script>&");
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;&amp;/);
});

test("newlines become <br> and are counted as one character each", () => {
  assert.equal(decorate("a\nb"), "a<br>b");
});

// ---- parity with format.js: the composer must not lie about the result ----
// What decorate marks bold/italic must match what format.js renders bold/italic,
// or the live preview disagrees with the sent message.

function strongRuns(html) {
  // Strip the dimmed marker spans first, then the md-strong inner text is the
  // bare run — matching what format.js puts between <strong>…</strong>.
  const stripped = html.replace(/<span class="md-mk">.*?<\/span>/g, "");
  const runs = [];
  const re = /<span class="md-strong">(.*?)<\/span>/g;
  let m;
  while ((m = re.exec(stripped)) !== null) runs.push(m[1]);
  return runs;
}
function fmtStrongRuns(html) {
  const runs = [];
  const re = /<strong>(.*?)<\/strong>/g;
  let m;
  while ((m = re.exec(html)) !== null) runs.push(m[1]);
  return runs;
}

for (const input of ["**bold**", "say **hi** and **bye**", "no bold here", "**a** *b*"]) {
  test(`parity: decorate & format.js agree on bold runs — ${JSON.stringify(input)}`, () => {
    assert.deepEqual(strongRuns(decorate(input)), fmtStrongRuns(formatMessage(input, null, {})));
  });
}

// ---- createUndoHistory: the pure undo/redo model ----
// `now` is injected so coalescing is deterministic (no real clock).

test("undo: starts empty, first edit pushes a step", () => {
  const h = createUndoHistory();
  assert.equal(h.canUndo(), false);
  assert.equal(h.current().value, "");
  h.record("a", 1, 1, { now: 1000 });
  assert.equal(h.canUndo(), true);
  assert.equal(h.current().value, "a");
});

test("undo: consecutive typing within the window coalesces into one step", () => {
  const h = createUndoHistory({ coalesceMs: 400 });
  h.record("h", 1, 1, { now: 1000 });
  h.record("he", 2, 2, { now: 1100 });
  h.record("hel", 3, 3, { now: 1200 });
  assert.equal(h._depth(), 2); // baseline "" + one coalesced run
  assert.equal(h.current().value, "hel");
  assert.equal(h.undo().value, ""); // the whole run undoes as one
});

test("undo: a gap longer than the window starts a fresh step", () => {
  const h = createUndoHistory({ coalesceMs: 400 });
  h.record("a", 1, 1, { now: 1000 });
  h.record("ab", 2, 2, { now: 2000 }); // gap 1000 > 400
  assert.equal(h._depth(), 3);
  assert.equal(h.undo().value, "a");
  assert.equal(h.undo().value, "");
});

test("undo: force makes a discrete step even within the window (Ctrl-B)", () => {
  const h = createUndoHistory();
  h.record("a", 1, 1, { now: 1000 });
  h.record("**a**", 3, 3, { now: 1050, force: true });
  assert.equal(h._depth(), 3);
  assert.equal(h.undo().value, "a"); // undo the wrap, keep the text
});

test("undo: a newline typed within the burst still coalesces (it's a tail append)", () => {
  const h = createUndoHistory();
  h.record("a", 1, 1, { now: 1000 });
  h.record("a\n", 2, 2, { now: 1050 });
  h.record("a\nb", 3, 3, { now: 1100 });
  assert.equal(h._depth(), 2);
  assert.equal(h.undo().value, "");
});

test("undo: a continuous typing burst (spaces included) coalesces into one step", () => {
  const h = createUndoHistory();
  h.record("foo", 3, 3, { now: 1000 });
  h.record("foo ", 4, 4, { now: 1050 });
  h.record("foo bar", 7, 7, { now: 1100 });
  assert.equal(h._depth(), 2);             // baseline + the whole burst
  assert.equal(h.undo().value, "");        // undo removes the burst at once
});

test("undo: a deletion is its own step, never merged into a typing run", () => {
  const h = createUndoHistory();
  h.record("ab", 2, 2, { now: 1000 });
  h.record("abc", 3, 3, { now: 1050 }); // append → coalesces into "ab" step
  assert.equal(h._depth(), 2);
  h.record("ab", 2, 2, { now: 1100 });  // backspace within window → new step (shrank)
  assert.equal(h._depth(), 3);
});

test("undo: a mid-string insertion is not coalesced (not a tail append)", () => {
  const h = createUndoHistory();
  h.record("ac", 1, 1, { now: 1000 });
  h.record("abc", 2, 2, { now: 1050 }); // inserted in the middle, not appended
  assert.equal(h._depth(), 3);
});

test("undo: a caret-only change updates selection without adding a step", () => {
  const h = createUndoHistory();
  h.record("ab", 2, 2, { now: 1000 });
  const depth = h._depth();
  h.record("ab", 0, 1, { now: 1010 });
  assert.equal(h._depth(), depth);
  assert.deepEqual([h.current().start, h.current().end], [0, 1]);
});

test("undo: recording after an undo truncates the redo branch", () => {
  const h = createUndoHistory();
  h.record("a", 1, 1, { now: 1000 });
  h.record("ab", 2, 2, { now: 2000 });
  h.undo();
  assert.equal(h.canRedo(), true);
  h.record("aX", 2, 2, { now: 3000 });
  assert.equal(h.canRedo(), false);
  assert.equal(h.current().value, "aX");
});

test("undo/redo walk the stack and clamp at both ends", () => {
  const h = createUndoHistory();
  h.record("a", 1, 1, { now: 1000 });
  h.record("ab", 2, 2, { now: 2000 });
  assert.equal(h.undo().value, "a");
  assert.equal(h.undo().value, "");
  assert.equal(h.undo(), null); // clamp low
  assert.equal(h.redo().value, "a");
  assert.equal(h.redo().value, "ab");
  assert.equal(h.redo(), null); // clamp high
});

test("undo: history is bounded to `limit` (oldest dropped)", () => {
  const h = createUndoHistory({ limit: 3, coalesceMs: 0 });
  for (let i = 1; i <= 5; i++) h.record("v" + i, 0, 0, { now: i * 1000 });
  assert.equal(h._depth(), 3);
  assert.equal(h.current().value, "v5");
});

test("undo: reset rebaselines to the given value with no undo available", () => {
  const h = createUndoHistory();
  h.record("a", 1, 1, { now: 1000 });
  h.reset("draft", 5, 5);
  assert.equal(h.canUndo(), false);
  assert.equal(h.current().value, "draft");
});

// ---- toggleMarker: the shared Ctrl-B/I wrap/unwrap (composer + edit box) ----

test("toggleMarker wraps a selection and shifts the selection past the markers", () => {
  assert.deepEqual(toggleMarker("make bold", 5, 9, "**"), { value: "make **bold**", start: 7, end: 11 });
});

test("toggleMarker on a collapsed caret inserts empty markers, caret between them", () => {
  assert.deepEqual(toggleMarker("", 0, 0, "*"), { value: "**", start: 1, end: 1 });
});

test("toggleMarker unwraps when the selection is already flanked (toggle)", () => {
  assert.deepEqual(toggleMarker("**bold**", 2, 6, "**"), { value: "bold", start: 0, end: 4 });
});

test("toggleMarker unwraps when the selection INCLUDES the markers (Ctrl-A case, no pile-up)", () => {
  assert.deepEqual(toggleMarker("**", 0, 2, "*"), { value: "", start: 0, end: 0 });        // empty italic
  assert.deepEqual(toggleMarker("*hi*", 0, 4, "*"), { value: "hi", start: 0, end: 2 });     // select-all italic
  assert.deepEqual(toggleMarker("****", 0, 4, "**"), { value: "", start: 0, end: 0 });      // empty bold
  assert.deepEqual(toggleMarker("**hi**", 0, 6, "**"), { value: "hi", start: 0, end: 2 });  // select-all bold
});

test("toggleMarker steps the caret OUT past a closing marker (exit), value unchanged", () => {
  // caret just before the closing * of "*italic*"
  assert.deepEqual(toggleMarker("*italic*", 7, 7, "*"), { value: "*italic*", start: 8, end: 8 });
  // caret just before the closing ** of "**bold**"
  assert.deepEqual(toggleMarker("**bold**", 6, 6, "**"), { value: "**bold**", start: 8, end: 8 });
});

// ---- flankedDelete: don't orphan markers when the inner content is deleted ----

test("flankedDelete takes the markers when the selection is the whole inner of a pair", () => {
  // "*hello*" with "hello" [1,6] selected → deleting clears the markers too
  assert.deepEqual(flankedDelete("*hello*", 1, 6), { value: "", start: 0, end: 0 });
  // longest-first: "**bold**" inner [2,6] → removes the ** pair
  assert.deepEqual(flankedDelete("**bold**", 2, 6), { value: "", start: 0, end: 0 });
});

test("flankedDelete keeps surrounding text outside the pair", () => {
  assert.deepEqual(flankedDelete("hi *x* yo", 4, 5), { value: "hi  yo", start: 3, end: 3 });
});

test("flankedDelete returns null when the selection isn't flanked by a marker", () => {
  assert.equal(flankedDelete("hello", 0, 5), null);
  assert.equal(flankedDelete("*hello* x", 1, 5), null); // partial inner, not flanked on the right
});

// ---- mention / channel / emoji tinting (validated against ctx) ----

const CTX = {
  meLower: "me",
  usernames: new Set(["alice", "me"]),
  channels: new Set(["general"]),
  emojis: new Set(["fire", "tada"]),
};

test("decorate tints known @mention, #channel, :emoji: when given ctx", () => {
  const out = decorate("hi @alice in #general :fire:", { ctx: CTX });
  assert.match(out, /<span class="md-mention">@alice<\/span>/);
  assert.match(out, /<span class="md-channel">#general<\/span>/);
  assert.match(out, /<span class="md-emoji">:fire:<\/span>/);
});

test("decorate leaves UNKNOWN @/#/: tokens plain (parity with format.js validation)", () => {
  const out = decorate("@nobody #nope :madeupemoji:", { ctx: CTX });
  assert.doesNotMatch(out, /md-mention|md-channel|md-emoji/);
});

test("decorate marks a self-mention with md-mention-me", () => {
  assert.match(decorate("ping @me", { ctx: CTX }), /class="md-mention md-mention-me">@me</);
});

test("ctx annotation never changes the text (fidelity holds with tinting)", () => {
  const src = "yo @alice in #general :fire: and **bold** _x_";
  assert.equal(sourceOf(decorate(src, { ctx: CTX })), src);
});

test("without ctx there is no mention/channel/emoji tinting", () => {
  assert.doesNotMatch(decorate("@alice #general :fire:"), /md-mention|md-channel|md-emoji/);
});
