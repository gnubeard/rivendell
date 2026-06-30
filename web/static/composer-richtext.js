// composer-richtext.js — live markdown decoration for the message composer.
//
// The composer is a contenteditable div with a textarea facade
// (composer-field.js). This module makes **bold**, *italic*/_italic_,
// ~~strike~~, `code`, ||spoiler||, ```fenced code blocks```, and known
// @mentions / #channels / :emoji: render with their effect WHILE you type —
// without ever hiding the markers. The markers stay in the text, just
// de-emphasized (`.md-mk`, dimmed); the delimited run gets the semantic style.
//
// Keeping the markers visible is the whole trick: every character the user typed
// stays in the DOM as a text character, so `el.value` (what gets sent) is
// byte-identical to the markdown source and the facade's offset math survives
// untouched. `decorate` only ever WRAPS runs in spans whose text content equals
// the input — it never adds or removes a character. That is the invariant the
// caret preservation rides on; the fidelity test in
// web/test/composer-richtext.test.js pins it (strip the tags → get the source
// back, exactly).
//
// `decorate` is pure (string in, HTML string out) and unit-tested under Node.
// createComposerRichText carries the DOM (innerHTML rewrite + caret restore +
// Ctrl-B/I); its net is web/e2e/composer-richtext.spec.js, because the offset
// math rides on real Range/Selection which only a real engine reproduces.
//
// Parity: the rules below MIRROR format.js's inline pass (same regexes, code
// pulled out first via a placeholder, bold before italic). What shows bold in
// the composer must be what format.js renders bold in the message — the parity
// test guards that. If format.js's inline rules change, change these in lockstep.

import { escapeHtml } from "./format.js";

// Wrap a literal marker run in the dimmed-marker span. The marker text is
// re-emitted verbatim (already HTML-escaped by the caller) so it stays in place.
const mk = (s) => `<span class="md-mk">${s}</span>`;

// Apply the emphasis rules to an already-escaped, code-free string. Each rule
// wraps its match (markers included) rather than stripping the markers. Order
// matches format.js: bold before italic so `**` isn't eaten by `*`.
function emphasize(s) {
  // Bold body may hold a lone `*` (a nested *italic* marker) but never `**`; the
  // later italic pass decorates that nested run. Mirrors format.js's bold regex.
  s = s.replace(/\*\*((?:\*(?!\*)|[^*])+?)\*\*/g, (_, x) => `<span class="md-strong">${mk("**")}${x}${mk("**")}</span>`);
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, (_, pre, x) => `${pre}<span class="md-em">${mk("*")}${x}${mk("*")}</span>`);
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, (_, pre, x) => `${pre}<span class="md-em">${mk("_")}${x}${mk("_")}</span>`);
  s = s.replace(/~~([^~]+)~~/g, (_, x) => `<span class="md-del">${mk("~~")}${x}${mk("~~")}</span>`);
  s = s.replace(/\|\|([^|]+)\|\|/g, (_, x) => `<span class="md-spoiler">${mk("||")}${x}${mk("||")}</span>`);
  return s;
}

// Mention / channel / emoji recognizers — the SAME shapes format.js uses, so the
// composer tints exactly the tokens the rendered message will treat specially.
// Unlike emphasis these are validated against live state (a `ctx` of known
// usernames / channel names / emoji shortcodes): an unknown @typo or #nope stays
// plain, matching the message. The token text (incl. the `@`/`#`/`:`) is kept
// verbatim — we only wrap — so the fidelity invariant holds (emoji can't render
// as a glyph here without changing the character count, so the `:shortcode:` is
// tinted in place instead).
const MENTION_RE = /(^|[^A-Za-z0-9_/])@([A-Za-z0-9_]{2,32})/g;
const CHANNEL_RE = /(^|[^A-Za-z0-9_/])#([a-z][a-z0-9_-]{0,31})/g;
const EMOJI_RE = /:([+a-z0-9_]{2,32}):/g;

function annotate(s, ctx) {
  if (!ctx) return s;
  if (ctx.usernames) {
    s = s.replace(MENTION_RE, (full, pre, name) => {
      const lower = name.toLowerCase();
      if (!ctx.usernames.has(lower)) return full;
      const cls = ctx.meLower && lower === ctx.meLower ? "md-mention md-mention-me" : "md-mention";
      return `${pre}<span class="${cls}">@${name}</span>`;
    });
  }
  if (ctx.channels) {
    s = s.replace(CHANNEL_RE, (full, pre, name) =>
      ctx.channels.has(name) ? `${pre}<span class="md-channel">#${name}</span>` : full);
  }
  if (ctx.emojis) {
    s = s.replace(EMOJI_RE, (full, name) =>
      ctx.emojis.has(name) ? `<span class="md-emoji">:${name}:</span>` : full);
  }
  return s;
}

// Decorate one line. Escape first (the escape-first invariant from format.js),
// then pull out `code` spans into sentinels so emphasis never runs inside code,
// then emphasize, then annotate mentions/channels/emoji (after emphasis, as
// format.js does), then restore the code spans. With markup:false it stops after
// escaping — the plain (un-decorated) form, used to strip the field back to text
// when the feature is turned off.
function decorateLine(line, markup, ctx) {
  const escaped = escapeHtml(line);
  if (!markup) return escaped;
  const tokens = [];
  const substituted = escaped.replace(/`([^`]*)`/g, (_, inner) => {
    const i = tokens.length;
    tokens.push(`<span class="md-code">${mk("`")}${inner}${mk("`")}</span>`);
    return `\x00${i}\x00`;
  });
  return annotate(emphasize(substituted), ctx).replace(/\x00(\d+)\x00/g, (_, i) => tokens[+i]);
}

// Fenced code blocks. A ``` line (optional language hint) opens a block that runs
// to the next ``` line, or to the end of the text if unclosed — matching
// format.js's renderBlocks. The fences and language survive verbatim (dimmed),
// and the content lines are literal (no inline markdown inside code).
const FENCE = "```";
const FENCE_OPEN_RE = /^```([a-zA-Z0-9+_-]*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;

// fenceLineHtml renders a ``` line: the three backticks dimmed like any marker,
// the language hint (and any trailing whitespace) kept verbatim and tinted.
function fenceLineHtml(line) {
  const after = line.slice(FENCE.length); // lang + trailing ws — kept exactly for fidelity
  const lang = after ? `<span class="md-cb-lang">${escapeHtml(after)}</span>` : "";
  return `<span class="md-codeblock md-cb-fence">${mk(FENCE)}${lang}</span>`;
}

// decorate turns the composer's plain text into HTML whose text content (with
// <br> ⟷ "\n") is byte-identical to the input. With { markup:false } it emits
// the escaped plain text (no spans). `ctx` (optional) enables mention/channel/
// emoji tinting. Empty → "" so the :empty placeholder still shows.
//
// Each source line becomes one entry in `out`, joined by <br>, so the newline
// count is preserved exactly — a fenced block contributes one entry per line
// too, never collapsing newlines (the caret math depends on it).
export function decorate(text, { markup = true, ctx = null } = {}) {
  if (text == null || text === "") return "";
  const lines = String(text).split("\n");
  if (!markup) return lines.map(escapeHtml).join("<br>");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_OPEN_RE.test(lines[i])) {
      out.push(fenceLineHtml(lines[i])); // opening fence
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (FENCE_CLOSE_RE.test(lines[j])) { out.push(fenceLineHtml(lines[j])); break; } // closing fence
        // An EMPTY code line is emitted bare (no span): an empty inline span gives
        // a collapsed caret zero geometry, so Gecko draws the caret in a degenerate
        // spot until you type. A bare empty line (between <br>s) positions like any
        // plain blank line. Non-empty lines get the code-block strip.
        out.push(lines[j] === "" ? "" : `<span class="md-codeblock">${escapeHtml(lines[j])}</span>`);
      }
      i = j; // skip past the block (closing fence, or end-of-text if unclosed)
      continue;
    }
    out.push(decorateLine(lines[i], true, ctx));
  }
  return out.join("<br>");
}

// toggleMarker maps a Ctrl-B/I press to a new { value, start, end }. Three cases:
//   - EXIT: a collapsed caret sitting just left of a marker run (e.g. `*italic|*`)
//     steps the caret out past the marker — finishing the formatted region —
//     changing nothing else. This is what lets you "press the shortcut again to
//     get out" after typing inside fresh markers.
//   - UNWRAP: a selection already flanked by the marker drops it (toggle off).
//   - WRAP: otherwise, surround the selection (empty selection → markers with the
//     caret parked between them).
// Pure — shared by the composer's live applyWrap and the plain inline message
// editor (no decoration there, but the same shortcut).
export function toggleMarker(value, start, end, marker) {
  const n = marker.length;
  if (start === end && value.slice(start, start + n) === marker) {
    return { value, start: start + n, end: start + n };
  }
  if (start >= n && value.slice(start - n, start) === marker && value.slice(end, end + n) === marker) {
    return { value: value.slice(0, start - n) + value.slice(start, end) + value.slice(end + n), start: start - n, end: end - n };
  }
  // UNWRAP-INSIDE: the selection itself begins AND ends with the marker (you
  // selected the whole thing, markers included — the Ctrl-A case). Strip the edge
  // markers so the shortcut toggles OFF instead of piling more onto the outside.
  if (end - start >= 2 * n && value.slice(start, start + n) === marker && value.slice(end - n, end) === marker) {
    return { value: value.slice(0, start) + value.slice(start + n, end - n) + value.slice(end), start, end: end - 2 * n };
  }
  return { value: value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end), start: start + n, end: end + n };
}

// The wrap markers, longest first so `**` is matched before `*`.
const WRAP_MARKERS = ["**", "~~", "||", "*", "_", "`"];

// flankedDelete handles the case where deleting the selection [start,end) would
// orphan a pair of emphasis markers: the selection is the ENTIRE inner content of
// a pair (so deleting it leaves a bare `**`), or — when collapsed — the caret
// sits between an empty pair (`*|*` from a fresh Ctrl-I you immediately undo by
// hand). In those cases we take the flanking markers too. Returns the new
// { value, start, end }, or null when the deletion isn't flanked (normal delete).
// Pure; the composer drives it from `beforeinput`. Guards against the reported
// "Ctrl-A, Ctrl-I, Backspace leaves orphan asterisks".
export function flankedDelete(value, start, end) {
  for (const m of WRAP_MARKERS) {
    const n = m.length;
    if (start >= n && value.slice(start - n, start) === m && value.slice(end, end + n) === m) {
      const caret = start - n;
      return { value: value.slice(0, caret) + value.slice(end + n), start: caret, end: caret };
    }
  }
  return null;
}

// createUndoHistory is a pure, DOM-free undo/redo stack over the composer's
// {value, start, end} state. We own undo/redo because BOTH the live decoration
// AND Ctrl-B/I rewrite the field programmatically (innerHTML / .value), which
// desyncs the browser's native history — so native Ctrl-Z is unreliable here
// and we replace it wholesale, always-on (independent of the decoration
// toggle). Behaviour:
//   - a continuous run of typing within `coalesceMs` of the last edit folds into
//     ONE step (so undo removes the whole burst, not one word or char at a time),
//     where "continuous" means a pure tail-append — the new value is the old
//     value plus more text at the end (spaces included);
//   - a `force` step (Ctrl-B/I, paste-wrap), a deletion or mid-string edit, or a
//     gap longer than `coalesceMs` (a pause) starts a fresh step;
//   - a caret-only change (same value) updates the current step's selection
//     without adding history;
//   - recording after an undo truncates the redo branch;
//   - bounded to `limit` entries (oldest dropped).
// Unit-tested in web/test/composer-richtext.test.js.
export function createUndoHistory({ limit = 250, coalesceMs = 400 } = {}) {
  let entries = [{ value: "", start: 0, end: 0 }];
  let index = 0;
  let lastTime = -Infinity;

  function record(value, start, end, { now = Date.now(), force = false } = {}) {
    const cur = entries[index];
    if (value === cur.value) { cur.start = start; cur.end = end; return; } // caret-only move
    // Coalesce only a continuous tail-append (typing forward); a deletion or a
    // mid-string edit (value isn't old+suffix) breaks the run into its own step.
    const isAppend = value.length > cur.value.length && value.startsWith(cur.value);
    const coalesce = !force && index === entries.length - 1 && now - lastTime < coalesceMs && isAppend;
    lastTime = now;
    if (coalesce) { entries[index] = { value, start, end }; return; }
    entries = entries.slice(0, index + 1);
    entries.push({ value, start, end });
    if (entries.length > limit) entries.shift();
    index = entries.length - 1;
  }

  // undo/redo return the state to apply, or null at the ends. They reset the
  // coalesce clock so the next keystroke can't fold into a step you navigated to.
  function undo() { if (index <= 0) return null; index--; lastTime = -Infinity; return entries[index]; }
  function redo() { if (index >= entries.length - 1) return null; index++; lastTime = -Infinity; return entries[index]; }
  function reset(value = "", start = 0, end = 0) { entries = [{ value, start, end }]; index = 0; lastTime = -Infinity; }

  return {
    record, undo, redo, reset,
    canUndo: () => index > 0,
    canRedo: () => index < entries.length - 1,
    current: () => entries[index],
    _depth: () => entries.length,
    _index: () => index,
  };
}

// createComposerRichText wires the live decoration + Ctrl-B/I onto a composer
// element already upgraded by upgradeComposerField. It does NOT add its own
// `input` listener — the caller's existing input handler (which first harvests
// pasted images and normalizes the field) calls `highlight()` at its end, so
// there is exactly one DOM-rewrite path. It owns only the composition guard.
export function createComposerRichText({ el, enabled = true, getContext = () => null }) {
  let on = !!enabled;          // decoration toggle (prefs-backed) — ORTHOGONAL to
                               // Ctrl-B/I and undo, which work either way.
  let composing = false;
  const history = createUndoHistory();

  // pendBefore: the field's {value, caret} captured at `beforeinput`, i.e. BEFORE
  // the browser applies the edit. We resolve the post-edit caret from this rather
  // than trusting the live Selection after the edit, because editing at the edge
  // of a decorated span (e.g. backspacing one of a `code` pair) leaves the
  // browser caret in a degenerate spot — it was jumping to the field start. The
  // edit is a single contiguous replace at the selection, so the new caret is
  // deterministic: prevEnd + (newLength - prevLength). Text offsets are immune to
  // the decoration, so this is exact regardless of the spans.
  //
  // EXCEPTION — forward delete (Delete key / word-delete-forward): the removed
  // range is AT/AFTER the caret, not before it, so the length delta is to the
  // RIGHT of the anchor and must NOT be applied. The caret stays at the original
  // selectionStart (true whether collapsed or a selection). We record that the
  // edit was a forward delete (`forward`) and the original `start` so onInput can
  // branch — applying the delta there dragged the caret one char left per Delete.
  let pendBefore = null;
  el.addEventListener("beforeinput", (e) => {
    if (composing) { pendBefore = null; return; }
    // Deleting a SELECTION that is the entire inner of an emphasis pair would
    // orphan its markers (Ctrl-A, Ctrl-I, Backspace → a bare `**`); take the
    // markers too. Restricted to selections so a collapsed backspace between
    // literal stars (e.g. `2**3`) is left alone.
    if ((e.inputType || "").startsWith("delete") && el.selectionStart !== el.selectionEnd) {
      const fd = flankedDelete(el.value, el.selectionStart, el.selectionEnd);
      if (fd) {
        e.preventDefault();
        el.value = fd.value;
        el.setSelectionRange(fd.start, fd.end);
        highlight(fd.start, fd.end);
        record(fd.start, fd.end, { force: true });
        pendBefore = null;
        return;
      }
    }
    // `*Forward` inputTypes (deleteContentForward, deleteWordForward,
    // delete{Soft,Hard}LineForward) delete to the right of the caret.
    const forward = (e.inputType || "").endsWith("Forward");
    pendBefore = { value: el.value, start: el.selectionStart, end: el.selectionEnd, forward };
  });

  el.addEventListener("compositionstart", () => { composing = true; });
  // After an IME commit, render + record once (input events fired mid-
  // composition were skipped by the composing guard).
  el.addEventListener("compositionend", () => { composing = false; onInput(); });

  // Rebuild the field's HTML from its text, preserving the caret/selection.
  // No-op while an IME composition is in flight (rewriting mid-composition
  // breaks CJK/mobile input) or when nothing would change.
  //
  // start/end may be passed explicitly: the input handler's earlier DOM
  // mutations (image harvest, the rich-paste flatten loop) physically destroy
  // the live Selection, but text OFFSETS survive them, so the caller captures
  // the offsets BEFORE those mutations and threads them through. Omitted → read
  // live (the draft-restore / Ctrl-B-I paths, where the caret is intact).
  function rebuild(markup, start, end) {
    if (composing || el.disabled) return;
    const focused = el.ownerDocument.activeElement === el;
    if (start == null) start = el.selectionStart;
    if (end == null) end = el.selectionEnd;
    const html = decorate(el.value, { markup, ctx: markup ? getContext() : null });
    // Rewrite only when the decoration actually changed, but ALWAYS re-assert the
    // caret: an edit can leave the HTML identical (e.g. a flatten pass already
    // produced the plain text) while the browser parked the caret somewhere wrong
    // — that was the backtick-backspace jump-to-start.
    if (el.innerHTML !== html) el.innerHTML = html;
    if (focused) el.setSelectionRange(start, end);
  }

  // highlight renders per the current decoration setting: decorate when ON,
  // strip to plain when OFF. (It does not record history — that's record()'s
  // job, so undo/redo and rendering stay separable.)
  function highlight(start, end) {
    rebuild(on, start, end);
  }

  // record snapshots the field's current {value, caret} into the undo history.
  // Skipped mid-composition (IME). `force` makes a discrete step (Ctrl-B/I).
  function record(start, end, opts) {
    if (composing) return;
    if (start == null) start = el.selectionStart;
    if (end == null) end = el.selectionEnd;
    history.record(el.value, start, end, opts);
  }

  // onInput is the one call the composer's input handler drives each keystroke:
  // resolve the caret, render, then record (coalesced). When a `beforeinput`
  // captured the pre-edit state (the normal typing/delete/paste path) the caret
  // is computed from the length delta; otherwise (a synthetic input event with
  // no beforeinput, e.g. autocomplete's pick) we fall back to the offsets the
  // caller captured live.
  function onInput(start, end) {
    if (pendBefore && !composing) {
      const len = el.value.length;
      // Forward delete removes at/after the caret → the caret holds at the
      // original selectionStart (don't apply the length delta, which is to the
      // right). Every other single-range edit (insert / backspace / selection
      // replace) happens at-or-before the caret, so prevEnd + lengthDelta is exact.
      const raw = pendBefore.forward ? pendBefore.start : pendBefore.end + (len - pendBefore.value.length);
      const caret = Math.max(0, Math.min(len, raw));
      start = caret; end = caret;
    }
    pendBefore = null;
    highlight(start, end);
    record(start, end);
  }

  // commit forces a discrete undo step for a programmatic edit that does NOT
  // fire `input` (the composer's URL-wrap paste sets .value directly).
  function commit() { record(undefined, undefined, { force: true }); }

  // resetHistory rebaselines undo to the field's current content — called when
  // the value is replaced out-of-band (channel switch restoring a draft, send
  // clearing the field) so undo can't bridge across those boundaries.
  function resetHistory() { history.reset(el.value, el.selectionStart, el.selectionEnd); }

  // applyState restores a history snapshot: set the text, the caret, then render.
  function applyState(s) {
    el.value = s.value;
    el.setSelectionRange(s.start, s.end);
    rebuild(on, s.start, s.end);
  }

  // setEnabled flips decoration live from the preferences toggle. It re-renders
  // (decorate / strip-to-plain) but does NOT touch the undo history or the
  // shortcuts — the toggle only changes what you SEE.
  function setEnabled(next) {
    next = !!next;
    if (next === on) return;
    on = next;
    rebuild(on);
  }

  // Wrap (or unwrap) the current selection in `marker`. With no selection the
  // markers are inserted empty and the caret lands between them. If the
  // selection is already flanked by the marker, the markers are removed
  // (toggle). Edits go through the facade `.value`/`.setSelectionRange`, then
  // highlight re-renders.
  function applyWrap(marker) {
    if (el.disabled) return;
    const r = toggleMarker(el.value, el.selectionStart, el.selectionEnd, marker);
    el.value = r.value;
    el.setSelectionRange(r.start, r.end);
    highlight(r.start, r.end);
    record(r.start, r.end, { force: true }); // a Ctrl-B/I wrap is its own undo step
  }

  // Undo/redo key combos. metaKey covers Cmd-Z / Cmd-Shift-Z on macOS; ctrlKey
  // covers Ctrl-Z / Ctrl-Y / Ctrl-Shift-Z on Windows/Linux.
  const isUndo = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key || "").toLowerCase() === "z";
  const isRedo = (e) => {
    if (e.altKey || !(e.ctrlKey || e.metaKey)) return false;
    const k = (e.key || "").toLowerCase();
    return (k === "z" && e.shiftKey) || (k === "y" && !e.shiftKey);
  };

  // handleKeydown intercepts undo/redo and Ctrl/Cmd-B/I. Returns true when
  // handled so the caller's keydown defers. Undo/redo and the formatting
  // shortcuts work REGARDLESS of the decoration toggle (the toggle only affects
  // rendering); preventDefault keeps the browser's desynced native history and
  // its bold/italic execCommand (which would inject <b>/<i>) from firing.
  function handleKeydown(e) {
    if (isRedo(e)) { e.preventDefault(); const s = history.redo(); if (s) applyState(s); return true; }
    if (isUndo(e)) { e.preventDefault(); const s = history.undo(); if (s) applyState(s); return true; }
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
    const k = (e.key || "").toLowerCase();
    if (k === "b") { e.preventDefault(); applyWrap("**"); return true; }
    if (k === "i") { e.preventDefault(); applyWrap("*"); return true; }
    return false;
  }

  return { onInput, highlight, commit, resetHistory, handleKeydown, setEnabled };
}
