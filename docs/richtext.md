# Composer rich text — live markdown decoration

Type `**bold**`, `*italic*`/`_italic_`, `~~strike~~`, `` `code` ``, `||spoiler||`,
` ```fenced code blocks``` `, and known `@mentions` / `#channels` / `:emoji:`, and
they render with their effect **while you type** — without ever hiding the
markers. The markers stay in the text, just de-emphasized (`.md-mk`, dimmed); the
delimited run gets the semantic style. `Ctrl/Cmd-B` and `Ctrl/Cmd-I` wrap (and
toggle) the selection. Zero new dependencies — it's one frontend module.

It's a **decoration layer over the plain-text composer**, not a rich-text editor:
the composer still holds and sends plain markdown. A profile checkbox ("Live
markdown formatting", default on) turns the *rendering* off; the markdown source
and the shortcuts are unaffected by it.

Lives in `web/static/composer-richtext.js`; wired into `wireComposer` in `app.js`.

---

## The load-bearing invariant

`decorate(text)` only ever **wraps** runs in spans whose text content equals the
input — it never adds or removes a character. So `el.value` (what gets sent) is
byte-identical to the markdown source, and the contenteditable facade's
text-offset caret math (`composer-field.js`) keeps working unchanged. Everything
else rides on this:

- **Markers are kept, just dimmed.** Hiding them would make displayed-length ≠
  logical-length and force the caret to be mapped across vanished characters on
  every keystroke — the thing that made this hard the first time we looked at it.
  Keeping them collapses that whole class of bug.
- **Emoji are tinted in place** (`:fire:` stays as text), never swapped for the
  glyph — a glyph would change the character count and break the invariant.
- The fidelity test in `web/test/composer-richtext.test.js` pins it: strip the
  decoration from `decorate(x)` and you get `x` back, exactly. Add cases there for
  any new construct.

## Parity with `format.js`

The composer must not lie about the result, so `decorate`'s inline rules **mirror
`format.js`'s** (bold before italic, code pulled out first via a placeholder,
mentions/channels/emoji validated against live state). What shows bold in the
composer is what `format.js` renders bold in the sent message. The parity test
guards bold runs; **if `format.js`'s inline rules change, change `decorate`'s in
lockstep.**

## Module API (all pure except `createComposerRichText`)

- `decorate(text, {markup, ctx})` → HTML. `markup:false` = escaped plain (used to
  strip the field when the toggle is off). `ctx` (from `richContext()` in app.js)
  enables mention/channel/emoji tinting.
- `toggleMarker(value, start, end, marker)` → `{value, start, end}` — the Ctrl-B/I
  wrap / unwrap / exit logic. Shared by the composer and the plain inline message
  editor. Cases: EXIT (collapsed caret just left of a closing marker steps out),
  UNWRAP-OUTSIDE (selection is the inner of a pair), UNWRAP-INSIDE (selection
  includes the markers — the Ctrl-A case; without it, repeated select-all + Ctrl-I
  piled asterisks on the outside), WRAP.
- `flankedDelete(value, start, end)` → `{…}` or null — deleting a selection that
  is the whole inner of a pair takes the markers too (fixes "Ctrl-A, Ctrl-I,
  Backspace leaves orphan `**`").
- `createUndoHistory({limit, coalesceMs})` — see Undo below.
- `createComposerRichText({el, enabled, getContext})` — the DOM glue:
  `onInput`/`highlight`/`commit`/`resetHistory`/`handleKeydown`/`setEnabled`.

## Undo/redo is ours, always-on

Both the live decoration and Ctrl-B/I rewrite the field programmatically
(`innerHTML` / `.value`), which desyncs the browser's native history — so native
Ctrl-Z is unreliable here and we replace it wholesale with `createUndoHistory`,
**independent of the decoration toggle**. Cmd-Z / Cmd-Shift-Z / Ctrl-Y /
Ctrl-Shift-Z all work (keyed on `ctrlKey || metaKey`, so macOS Cmd is covered). A
continuous typing burst coalesces into one step; deletions, mid-string edits,
pauses, and Ctrl-B/I are discrete steps. Any out-of-band `.value` set (channel
switch, send, error-restore, URL-wrap paste) calls `resetHistory()` so undo can't
bridge that boundary.

## Caret restoration

After each edit the caret is resolved from the state captured at `beforeinput`
(`prevEnd + lengthΔ`), not from the browser's post-edit selection — editing at the
edge of a decorated span leaves the live Selection in a degenerate spot (it was
jumping to the field start when backspacing one of a `` `code` `` pair). `rebuild`
rewrites `innerHTML` only when the decoration changed, but always re-asserts the
caret.

## Gecko (Firefox) lessons — the expensive ones

These cost the most to find; don't re-introduce them.

- **No `textContent` flatten of the field.** The old input handler flattened
  smuggled rich nodes via `textContent`, which silently drops `<br>` — and Gecko
  nests the Shift+Enter line-break `<br>` *inside* a decorated span, so the flatten
  ate newlines (code blocks collapsed onto one line). `highlight()` already
  rebuilds from `textOf` (which counts nested `<br>` correctly) and sanitizes
  smuggled content, so no separate flatten is needed.
- **Stranded-`<br>` normalization is gated to delete inputTypes.** Gecko inserts a
  lone `<br>` for Shift+Enter on an empty composer; the placeholder-restoring
  normalize must not eat that — only a *deletion* that empties the field should
  collapse the stray break.
- **Empty code-block lines render bare** (`""`), not as an empty
  `<span class="md-codeblock"></span>`: an empty inline span occupies a visible
  line box, so a fresh empty code line showed as an extra line that dropped the
  caret a row until you typed.
- The transient `\n\n` you can observe on a just-created empty line is Gecko's
  filler `<br>`; it's absorbed the moment you type, so the sent value is correct.

## Tests

- `web/test/composer-richtext.test.js` — `decorate` fidelity + decoration +
  `format.js` parity, the `createUndoHistory` model, `toggleMarker`,
  `flankedDelete`. Pure, run under Node.
- `web/e2e/composer-richtext.spec.js` — the DOM behaviors (live decoration, caret,
  Ctrl-B/I, undo/redo, toggle, code blocks) against a real engine.
- **Gap:** the suite is Chromium-only; several bugs here were Gecko-specific and
  were caught by an ad-hoc Firefox Playwright run, not CI. If this feature grows, a
  small Firefox composer smoke (mirroring `webkit-smoke`) is the honest follow-up.
