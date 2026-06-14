# Frontend decomposition

Breaking `web/static/app.js` (the client orchestrator — 6.1k lines at the start
of this effort, shrinking with each slice) into small, well-understood,
well-tested, well-documented modules — incrementally, one cohesive chunk per
commit, each shippable on its own.

This is a living document. Update the status table as chunks land.

## Why

`app.js` is the highest-churn file in the repo and by far the largest module
without its own test. The focused modules — `format`, `state`, `voice`, `secret`,
… — are each small and have a `web/test/*.test.js` suite (the DOM-carrying ones
carved off later, like `search`/`emoji`/`channeldrag`, are covered by e2e instead;
`api.js`, a thin fetch wrapper, is the only one with no test of either kind). The
goal is to bring `app.js` to that same standard without a rewrite: peel off one
concern at a time, behind a documented seam, with the appropriate kind of test.

## Test strategy — the spine

The hard constraint: **the frontend has zero runtime deps, and `node:test` has no
DOM.** So how a chunk gets tested depends on what it touches.

1. **Pure logic → `node:test` unit tests.** Data transforms, decision rules,
   serialization — anything that doesn't touch `document`/`window`/`Range`/etc.
   Fast, exhaustive, zero deps. This is the preferred target; when a chunk has a
   pure core, factor it out and test it here.

2. **DOM-bound logic → Playwright e2e** (`web/e2e/`, dev-only tooling, run via
   `make test-e2e`). Real browser, real engine, real layout. This is the net for
   anything that depends on the DOM, selection/caret behavior, layout geometry,
   or browser-engine quirks — which is where rivendell's actual bugs have lived
   (the FF-Android contenteditable fix; WebRTC glare/renegotiation; autoplay
   freezes). A real browser is the only thing that reproduces those.

**We deliberately do NOT use jsdom.** It would let DOM code run under `node:test`,
but it's a *reimplementation* of the DOM: its `Selection`/`Range` support is
partial, it has no layout (`getBoundingClientRect` returns zeros), and — most
importantly — it would not reproduce the engine quirks our DOM code exists to
handle, so it offers false-green confidence exactly where we need real confidence.
The pure stuff already tests for free; the engine/layout stuff already needs e2e;
jsdom only serves a narrow middle band that isn't worth a second dev-dep and the
prime-directive exception. (If a future chunk is *all* fiddly DOM-structure math
with no layout/engine dependence, revisit this — scoped to that chunk.)

### Decision rule per chunk

```
Does the chunk have a pure core that's worth testing on its own?
  yes -> extract the core to its own module, unit-test it (node:test).
         leave a thin DOM adapter behind; e2e it if it carries real behavior.
  no  -> is it already e2e-covered?
           yes -> extract verbatim as an organizational module; e2e is the net.
           no  -> extract verbatim AND add an e2e spec for the seam's contract.
Never rewrite hardened DOM code just to make it unit-testable. Reorganize; let
the existing e2e (or a new one) hold the line.
```

### Two methods, and where we are now

The early slices took the **pure-core** path: a data transform or decision rule
lifted out and exhaustively unit-tested, with a thin DOM adapter left behind
(`unread`, `channelorder`, `drafts`, `prefs`, `previews`, `util`, the
`autocomplete`/`attachments` filters). That well is now largely dry — what
remains in `app.js` is overwhelmingly DOM construction and stateful
orchestration with little extractable pure logic.

So the current method is the **feature module** (the `no` branch above): lift a
whole feature that *carries its own DOM* — it owns its state, renders itself, and
talks to the rest of the app through a small `createX(deps)` surface — and let an
e2e spec be the net. `search.js` is the pilot: it owns its racy state (generation
token, query, keyset cursor, debounce), and `web/e2e/search.spec.js` (written
*before* the extraction, run green against the old code first) pins the contract.
Conventions specific to this kind of module:

- **Pass `el`/`$` and read state through a getter.** A DOM-carrying module takes
  the element builder and querySelector helper as deps, and `getState: () => state`
  (not the value — `state` is reassigned on every update). Navigation/side-effect
  hooks (`jumpToMessage`, `closeDrawers`) are passed in; already-modular helpers
  (`formatMessage`, `formatTime`, `dmDisplayName`) are imported directly.
- **Write the e2e first.** Prove the new spec passes against the *un-extracted*
  code, so a later failure means the extraction regressed — not that the spec was
  wrong.

## Module conventions

- **One module = one concern.** Name it for the concern (`unread`, `channelorder`).
- **Header comment states the contract** — what the module owns, what stays in
  the caller, and any invariant a test guards. This is the "well-documented" part.
- **Imports use the `?v=__RIVENDELL_VERSION__` cache-bust suffix**, matching
  app.js (the server rewrites the token in *every* served .js; `node --test`
  ignores the query). This is load-bearing, not just cache hygiene: ES modules
  are keyed by resolved URL, so the token MUST resolve identically everywhere or
  a module imported by both app.js and a sibling loads twice. Harmless for pure
  modules, but two instances of a *stateful* module (e.g. `secret.js`'s session
  map) silently don't share state. The server-side fix (template all .js) landed
  with the secretui.js extraction; `TestStaticTemplatesAllJSModules` guards it.
- **Pure modules export functions; stateful ephemeral bookkeeping exports a
  `createX()` factory** (closure-encapsulated, like `createUnreadTracker`) rather
  than module-level mutable globals.
- **Don't move the call sites' job into the module.** Selectors take `state` and
  return values; the module does not render or fetch. DOM/network side effects
  stay in `app.js` (or the chunk's thin adapter).
- **Inject side-effecting deps to make them unit-testable** without jsdom. A
  factory can default to the real global and accept a fake in tests — e.g.
  `createPrefs(storage = globalThis.localStorage)` is exercised with a Map-backed
  stub in `node:test`. Use this for `localStorage`-style globals; it's not a
  substitute for e2e where real browser/engine behavior is what matters.

## Status

| Chunk | Module | Test | Status |
|-------|--------|------|--------|
| Read tracking (divider, mark-unread suppression, POST dedupe) | `unread.js` | unit (15) | ✅ done |
| Sidebar ordering + drag-reorder diff | `channelorder.js` | unit (12) | ✅ done |
| Per-channel composer scratch (draft text + attachments) | `drafts.js` | unit (12) | ✅ done |
| Composer field facade (textarea-on-div) | `composer-field.js` | e2e (composer-paste) | ✅ done |
| Small pure helpers (`humanBytes`, `formatTime`, `overSizeLimit`) | `util.js` | unit (11) | ✅ done |
| Theme allow-list + browser-local prefs (notif, PTT) | `prefs.js` | unit (10) | ✅ done |
| Link/embed preview cache state machine | `previews.js` | unit (8) | ✅ done |
| Composer attachment-upload tray (+ pure message-body assembly) | `attachments.js` | unit (8) + e2e | ✅ done |
| @-mention / :emoji / #channel completion widget (+ pure filters) | `autocomplete.js` | unit (14) + e2e | ✅ done |
| Message-search modal controller (DOM-carrying feature module) | `search.js` | e2e (search, 5) | ✅ done |
| Shared emoji popup (composer / inline-edit insert + reactions) | `emoji.js` | e2e (emoji-picker, 3) | ✅ done |
| Moderator channel drag-reorder controller (DOM gesture) | `channeldrag.js` | e2e (channel-reorder, 1) | ✅ done |
| Presence dot color + debounce decision (pure logic) | `presence.js` | unit (8) | ✅ done |
| Image cache warming (avatars, viewport, bg blob sweep; pure URL scan) | `imagewarm.js` | unit (10) | ✅ done |
| Inline link/embed previews (msg-permalink embeds, YouTube, og: cards) | `linkpreview.js` | e2e (link-previews, 3) | ✅ done |
| Admin/moderator settings panel (stats, users, invites, tokens, emojis) | `admin.js` | e2e (admin, 5) | ✅ done |
| Secret-chat UX (request banner, 🔒 button, safety-number modal) | `secretui.js` | e2e (secret-chat, 2) | ✅ done |
| Forward-message modal (+ pure `forwardBody`/`forwardTargets`/`makeCanSee`) | `forward.js` | unit (9) + e2e (forward, 3) | ✅ done |
| Pinned-messages panel (list + jump + in-panel unpin; LWW refresh guard) | `pins.js` | e2e (pins, 2) | ✅ done |
| Modal cluster (new-channel, edit-profile, invite, read-only user card) | `modals.js` | e2e (modals, 4) | ✅ done |
| Mobile long-press action sheet (+ reactions sub-panel) | `mobilectx.js` | e2e (mobile-ctx, 5) | ✅ done |

### Candidate chunks (not yet scheduled)

Rough inventory of what still lives in `app.js`, for planning. Order TBD.

- **Composer wiring** — `wireComposer` is what's left after `composer-field.js`
  (facade) and `attachments.js` (upload tray) were carved out: the input event
  routing (3 paste channels, typing, the Enter send path) and the secret-session
  gate. Deeply wired to mutable module state (`state`, `replyingToId`, `socket`),
  so per the spine it stays in app.js rather than getting a getter/setter bag;
  e2e-covered (composer-paste). Only extract further if a clean pure core appears.
- **Video grid + call strip** — `renderVideoGrid`/`renderDMVideoGrid`/
  `renderGroupVideoGrid`, `videoAvatarTile`, `renderCallStrip` (~200 lines, now
  its own section). On close reading this is a wireComposer-class entanglement,
  not a clean widget: the renderers *write* shared mutable call state
  (`videoViewHidden`, also touched by `selectChannel`/`renderChannelHeader`/the
  header toggle/`onVoiceStateChange`) and *read* `voiceCallState`, `speakingIds`,
  and the PTT flags, plus ~5 `voice.js` functions. A clean extraction would need
  a ~12-entry deps bag including a `videoViewHidden` setter — exactly the
  getter/setter indirection into hardened, e2e-only DOM code the spine says not
  to add. So per our own rule it **stays in app.js** (honestly bannered and
  findable); revisit only if a pure core emerges. (The pure `formatTime` that
  used to sit under this banner was mis-filed and has moved to `util.js`.)
- **Inline message editing** — `editorFor`/`startEdit`/`cancelEdit`/`autoGrowEdit`
  (+ `commitEdit`), the other half of the old "emoji picker" section, now under
  its own banner. Stays in app.js: it calls `renderMessages` and owns
  `editingMessageId`/`editDraft`/`editFocusPending`, which are read in ~11 places
  (rendering, the Escape handler, composer wiring) — a wireComposer-class
  entanglement, not a clean widget.
- **Audio/tones** — `boop`/`playTones`/greet/farewell. Scouted: pure Web Audio
  scheduling against a shared `audioCtx`, no extractable pure core (the tone
  sequences are trivial data; unit-testing them is a tautology). Leave it.
- **Boot/auth flow** — `boot`, `wireLogin`, `bootSetPassword`, `bootSignup`,
  `enterApp`. Mostly DOM/network orchestration; e2e territory.
- **Realtime/sync** — `startRealtime`, `resync`, the WS event handler. Folds into
  `state.applyEvent` already; the handler's routing is DOM-heavy.

**Feature-module candidates: all extracted.** The 2026-06 re-audit catalogued the
DOM-carrying feature sections that write little or no shared state — forward, pins,
the modal cluster, and the mobile long-press sheet — and each has since been lifted
behind a `createX(deps)` surface with an e2e net (and the long-press extraction
also fixed a latent `activeCh` ReferenceError that only non-mod members hit). What
remains in `app.js` is the orchestrator proper.

Still deliberately retained in `app.js` (wireComposer-class entanglements or pure
orchestration): the video grid, reactions (woven into message rendering + the
`mine` invariant), control wiring, bootstrapping, realtime/sync, message
rendering/loading, channel header/selection. The next worthwhile work here is
different in kind — tightening that spine (e.g. leaning the realtime handler harder
on `state.applyEvent`), not carving out more modules.
