# Rivendell: render-cluster decoupling — Claude Code handoff

## Goal

Make the message-render cluster in `web/static/app.js` extractable into a
`createMessageList({...})` module **with a small deps object**, by first removing
the thing that has made every prior attempt "not worth it": the ~10 per-row
`onclick` closures that bind the renderers directly to app.js action functions.

This is a **pure refactor**. No feature, UX, markup-class, or wire-format change.
If a test starts failing because behavior changed, you changed behavior — stop and
reconsider; do **not** edit the test to make it pass.

The work is two phases. **Phase 1 is independently shippable and carries most of the
risk-reduction value on its own.** Do not start Phase 2 until Phase 1 is committed and
green. Treat Phase 2 as optional-on-the-day if Phase 1 surfaces surprises.

---

## Phase 0 — Orient and establish a green baseline

This plan was written against a snapshot; **line numbers will have drifted, verify by
name, not by line.** Do not trust any claim below without confirming it in the live tree.

1. Read these in `web/static/app.js` and confirm they exist roughly as described:
   - `messageActions(m, {...})` — builds the hover action button row; today each button
     is `el("button", { onclick: () => <appFn>(m) }, ...)`.
   - `messageRow(m, {...})` — builds a row; contains the avatar/author **profile-open**
     closures (`openUserCard`) and the **permalink time** closure (`jumpToMessage`).
   - `reactionsRow(m)` — the existing-reaction pills; clicking one calls `toggleReaction`.
   - `embedRemoveButton(m, url)` / `removeEmbed(m, url)` — the author-only "remove embed" ×.
   - `wireDelegatedClicks()` — the **existing** document-level delegated click handler
     (spoilers, `a.channel-link`, `a.msg-image-link` lightbox, permalink hashes). This is
     the pattern you will extend. Every row already carries `data-msg-id`.
   - `findMessage(messageId)` — already exists; use it for id → message resolution.

2. Confirm the project's test entry points (check `web/package.json` and the `Makefile`):
   - Unit: `npm test` (node's built-in runner over `web/test/*.test.js`).
   - E2E: `npx playwright test` (or the Make target). Confirm browsers are installed.

3. Run both. Record a **green baseline**. If anything is red before you start, surface it
   and stop — you need a clean baseline to trust the safety net.

4. Map the click paths you're about to touch to the specs that guard them, so you know
   which to run after each step:
   - `react` (add) + popup placement → `web/e2e/emoji-picker.spec.js`
   - `react-toggle` (pill) → `web/test/reactions.test.js`, `emoji-picker.spec.js`
   - `forward` → `web/e2e/forward.spec.js`
   - `pin` → `web/e2e/pins.spec.js`, `web/e2e/image-pin.spec.js`
   - `edit` / send reconciliation → `web/e2e/optimistic-send.spec.js`,
     `web/e2e/composer-richtext.spec.js`
   - `profile` open → covered indirectly by modal/admin specs; grep for `openUserCard`/user
     card assertions
   - permalink time + lightbox → `web/e2e/lightbox-gallery.spec.js`, `history.spec.js`

---

## Phase 1 — Convert per-row action closures to delegated `data-act` dispatch

**The demolition step.** When this phase is done, the render functions call **zero** app.js
action functions; all actions route through the document-level handler, which stays in
app.js where it has the state and modal references it needs.

Work **one action group at a time**, testing between each. Commit per group if practical,
so a bisect can localize any regression.

### 1a. Add the dispatch branch to `wireDelegatedClicks`

Add an action-button branch **before** the existing modifier-key / link-oriented bail
(action buttons are not links — a modified click on "delete" must still resolve). Match the
file's existing style in `wireDelegatedClicks`; the shape is roughly:

```js
const actBtn = e.target.closest?.("[data-act]");
if (actBtn) {
  const act = actBtn.dataset.act;
  const row = actBtn.closest("[data-msg-id]");
  const mid = row ? Number(row.dataset.msgId) : null;
  const m = mid != null ? findMessage(mid) : null;
  switch (act) {
    case "reply":       if (m) startReply(m); break;
    case "forward":     if (m) openForwardModal(m); break;
    case "read-toggle": if (m) toggleMessageRead(m); break;
    case "edit":        if (m) startEdit(m); break;
    case "pin":         if (m) togglePin(m); break;
    case "delete":      if (m) deleteMessage(m); break;
    case "react":       if (m) emojiPicker.openForReaction(m.id, actBtn); break;
    case "react-toggle":
      if (m) toggleReaction(m.id, actBtn.dataset.emoji); break;
    case "remove-embed":
      if (m) removeEmbed(m, actBtn.dataset.url); break;
    case "profile": {
      const uid = Number(actBtn.dataset.userId);
      if (uid) openUserCard(uid);
      break;
    }
  }
  return;
}
```

Notes that matter:
- `react` (add) previously received `e.currentTarget` as the popup anchor; now pass
  `actBtn`. Verify the popup still anchors to the button.
- `react-toggle`: the old call was `toggleReaction(messageId, emoji, knownMine)`. Drop the
  `knownMine` optimization and let `toggleReaction` derive mine-ness from state (it already
  can), **or** carry `data-mine` on the pill. Prefer deriving — keep the DOM minimal.
- `profile` resolves a **user id** (`data-user-id`), not the message — it's on the
  avatar/author elements, which carry their own user id.

### 1b. **CRITICAL GOTCHA — emoji popup self-close.**

The current `react` closure calls `e.stopPropagation()`. That is very likely there to stop
the open-click from bubbling to a "close popup on outside click" listener (in `emoji.js` or
wired near it). **Under delegation the click reaches `document` by design** — that's how
delegation works — so a close-on-outside-click listener will now see the same click that
opened the popup and may close it immediately.

Before declaring Phase 1 done:
- Find the popup's outside-click-close handler.
- Ensure it ignores the originating trigger — the standard guard is
  `!popup.contains(target) && !target.closest('[data-act="react"]')`.
- `emoji-picker.spec.js` is the proof. If the picker opens-then-vanishes, this is why.

### 1c. Rewrite the renderers to emit data, not closures

- `messageActions`: each button becomes `el("button", { class: "...", "data-act": "...",
  title: "..." }, "<glyph>")`. No `onclick`. Keep the conditional inclusion logic
  (`isOwn`, `canPin`, `canDelete`) exactly as is — only the handler attachment changes.
- `reactionsRow`: each pill gets `"data-act": "react-toggle"`, `"data-emoji": <emoji>`.
- `embedRemoveButton`: `"data-act": "remove-embed"`, `"data-url": hideUrl`.
- `messageRow` avatar + author spans: `"data-act": "profile"`, `"data-user-id": author.id`
  on the clickable variants; leave the non-clickable (`author == null`) variants alone.
- `messageRow` permalink time: **first check** whether the existing permalink branch in
  `wireDelegatedClicks` already catches it — the time element is an `<a>` whose `href` is
  `permalinkHash(channelId, id)`, and the handler already routes same-origin permalink
  hashes through `jumpToMessage`. If it does, simply drop the inline `onclick` and the keep
  `href`; the existing branch handles it. If it does **not** (e.g. it's not an anchor, or
  the href shape differs), give it `data-act` and a case. Confirm, don't assume.

### 1d. Verify Phase 1

- Re-run `npm test` and the full Playwright suite. **Green is the gate.**
- Manually sanity-check the subtle ones in a browser: open emoji picker (does it stay
  open?), toggle a reaction, ctrl/cmd-click a permalink (should still open a new tab, not
  jump), click an author to open their card.
- Confirm by grep that the render functions no longer reference action functions directly:
  `grep -nE 'onclick' web/static/app.js` inside the render cluster should come back empty
  for message rows (the composer/profile/modal wiring elsewhere still uses handlers — that's
  fine; you're only clearing the **render cluster**).
- **Commit.** This phase stands on its own: app.js's render surface is now closure-free, and
  the incremental-patch path (`appendMessageRow` / `patchMessageRow`, which re-run
  `messageRow`) no longer creates and discards per-row listeners on every patch.

---

## Phase 2 — Extract the now-pure cluster into `createMessageList`

Only after Phase 1 is committed and green.

### 2a. Identify the cluster to move

Display/render and incremental-patch functions, which now depend only on `state`-reads and
pure helpers:
`renderMessages`, `messageRow`, `messageActions`, `reactionsRow`, `renderDeletedRun`,
`renderSystemMessage`, `buildReplyQuote`, `embedRemoveButton`, `decorateImageEmbeds`,
`embedURLFor`, the grouping helpers (`groupingAnchor`, `insertionPointFor`, `rowContextFor`),
the incremental patch helpers (`appendMessageRow`, `patchMessageRow`, `refreshReadMarks`),
and `renderTypingIndicator`.

**Leave in app.js** (do not move): the inline editor (`editorFor`, `startEdit`,
`commitEdit`, `cancelEdit`, `autoGrowEdit` and the `editingMessageId`/`editDraft` state) —
it's genuinely interactive and app-stateful. `messageRow` will reach it via a single
`editorFor` callback in the deps object. Also leave `renderSecretView` routing as-is unless
it falls out cleanly; `secret.js` owns that DOM and it's a separate coupling not in scope here.

### 2b. Define the module interface explicitly

Create `web/static/messagelist.js` exporting `createMessageList(deps)`, matching the
existing `createX` factory convention. Target deps object (keep it this small — that's the
whole point):

```js
createMessageList({
  getState,          // () => state
  getViewFlags,      // () => ({ editingMessageId, flashMessageId })  (read-only)
  editorFor,         // (m) => Element  — inline editor, stays in app.js
  buildLinkPreview,  // from linkPreviews (already created in app.js)
  avatarSrc,         // (userId) => string
})
// returns:
// { renderMessages, appendMessageRow, patchMessageRow,
//   refreshReadMarks, renderTypingIndicator }
```

Everything else the cluster uses — `formatMessage`, `formatTime`, `permalinkHash`,
`mentionsUser`, `initials`, `classifyReaction`, `shouldGroupMessage`, `el`, `$` — is already
a pure import or a trivial DOM helper; import those directly into the new module rather than
threading them through deps.

### 2c. Move, wire, verify

- Move the functions, carrying their explanatory comments **verbatim** — those comments are
  load-bearing (e.g. the optimistic-row reconcile notes, the incremental-patch rationale).
- Replace `state` reads with `getState()` and the two view flags with `getViewFlags()`. The
  module must stay **read-only** on state and flags — it renders, app.js mutates.
- In app.js: `import { createMessageList } from "./messagelist.js"`, build it in the same
  region as the other factories, and replace the old call sites with the returned methods
  (same names, so call sites barely change).
- Add JSDoc `@param` typedefs to `createMessageList`'s deps so the contract is documented at
  the boundary.
- Re-run `npm test` + full Playwright suite. **Green is the gate.** Commit.

---

## Phase 3 — Guard the contract (optional follow-on, separate task)

Not required for the refactor to land; do it as its own change so a tooling decision can't
block the refactor. Add `tsc --noEmit --checkJs` as a **dev-only** check (devDependency
alongside Playwright — never ships, never runs in prod), with a `jsconfig.json` or
`tsconfig.json` scoped to `web/static`. With JSDoc on the factory deps, this is what keeps the
new narrow interface from silently re-widening back into closures the next time an action is
added. This belongs to the broader "type-check-as-lint" thread, not this refactor.

---

## Do not touch

- `wireComposer` and the three image-paste channels — out of scope, and the comment that
  says *do not "simplify" by removing channels 1 or 2* is correct; leave it.
- Any comment that explains *why* (glare avoidance, `callGen` teardown race, optimistic
  reconcile, the FF-Android paste harvest). Move comments with their code; never drop them.
- Markup classes, server wire format, WS event shapes — this is a pure client-side refactor.

## Discipline checklist

- [ ] Green baseline recorded before any edit.
- [ ] One action group converted at a time in Phase 1; suite green between groups.
- [ ] Emoji-popup self-close gotcha (1b) explicitly verified against `emoji-picker.spec.js`.
- [ ] Permalink-time path confirmed (reused existing branch, or given its own `data-act`).
- [ ] Render cluster confirmed closure-free before starting Phase 2.
- [ ] `createMessageList` deps object is ~5 fields, read-only on state.
- [ ] Comments carried verbatim.
- [ ] A failing test means behavior changed → fix the code, not the test.
- [ ] Phase 1 and Phase 2 are separate commits.
