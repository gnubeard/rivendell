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
`autocomplete`/`attachments` filters). The big modules' wells are now largely
dry — what remains in `app.js` is overwhelmingly DOM construction and stateful
orchestration — but smaller pure cores still surface from the orchestrator spine
and are worth lifting when they do: the unread/mention/ping decision matrix moved
to `classifyIncomingMessage` (in `unread.js`), and the role-hierarchy checks to
`S.isAdmin`/`S.canModerate` (in `state.js`), both with unit tests. These aren't
new modules — they're pure functions added to existing ones plus an in-place
dedup (the `guard()` error-alert helper is similar) — so they don't get a status
row below; they're part of tightening the spine, not carving it up.

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
| In-call video grid (DM 2-tile + group gallery, show/hide, fullscreen) | `videogrid.js` | e2e (video-grid, 3) | ✅ done |

### Candidate chunks (not yet scheduled)

Rough inventory of what still lives in `app.js`, for planning. Order TBD.

- **Composer wiring** — `wireComposer` is what's left after `composer-field.js`
  (facade) and `attachments.js` (upload tray) were carved out: the input event
  routing (3 paste channels, typing, the Enter send path) and the secret-session
  gate. Deeply wired to mutable module state (`state`, `replyingToId`, `socket`),
  so per the spine it stays in app.js rather than getting a getter/setter bag;
  e2e-covered (composer-paste). Only extract further if a clean pure core appears.
- **Video grid** — ✅ **DONE** (this branch): lifted to `videogrid.js` behind
  `createVideoGrid(deps)`, e2e net `web/e2e/video-grid.spec.js` (3 specs: grid
  reveal + fullscreen + `body.video-active`, the mobile chat↔video toggle, and
  both-cameras-off hide), written and run GREEN against the un-extracted code
  first per the iron rule. The earlier "stays in app.js" verdict had rested on a
  stale deps-bag estimate that double-counted the `voice.js` imports
  (`getVideoEl`/`getLocalVideoEl`, which the module imports directly, not via the
  bag). The real surface came in at 9 deps — `el`, `$`, `getState`,
  `getVoiceCallState`, `getSpeakingIds`, `avatarSrc`, `initials`,
  `getVideoViewHidden` + `setVideoViewHidden` — on par with `mobilectx`. app.js
  keeps *owning* `videoViewHidden` (header label, channel selection, and call
  lifecycle still touch it directly; the module only gets the get/set pair, the
  one-boolean-setter precedent being `channeldrag`'s `setChannels`). Scoped to the
  grid: `renderCallStrip` stayed in app.js (it reads the PTT flags and is more
  coupled). (The pure `formatTime` that once sat under this banner was mis-filed
  and has moved to `util.js`.)
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
- **Realtime/sync** — `startRealtime`, `resync`, the WS event handler. The
  state-folding has been pulled fully into the pure layer: `state.applyEvent` is
  now total over state-mutating events (the `message.new` last_message_at bump and
  `member.remove` channel drop moved in), and the unread/mention/ping decision
  matrix is a tested pure function (`classifyIncomingMessage` in `unread.js`) the
  handler feeds three view booleans (active/focused/adminPanelOpen). The handler
  itself is now the top-level `handleRealtimeEvent(evt)` (with `onRealtimeConnChange`
  for the conn-status/resync side), so `startRealtime` is just socket lifecycle and
  the dispatch is named/navigable rather than an anonymous closure argument. What's
  left in it is genuinely DOM-heavy: per-event-type re-render routing, scroll-
  geometry marker placement, and `voice.*`/`secret.*` dispatch — e2e territory,
  not a further pure carve.

**Feature-module candidates: all extracted.** The 2026-06 re-audit catalogued the
DOM-carrying feature sections that write little or no shared state — forward, pins,
the modal cluster, and the mobile long-press sheet — and each was lifted behind a
`createX(deps)` surface with an e2e net (and the long-press extraction also fixed a
latent `activeCh` ReferenceError that only non-mod members hit). A later re-tally
(this branch) reopened **the video grid** — the earlier "stays in app.js" verdict
had rested on a stale deps-bag estimate that double-counted `voice.js` imports — and
it too has now been lifted to `videogrid.js` (see the Video grid bullet above),
e2e-first, scoped to the grid (not `renderCallStrip`). With that, the DOM-carrying
feature-module well is dry; the remaining work is spine-tightening, not carving.

Still deliberately retained in `app.js` (wireComposer-class entanglements or pure
orchestration): inline message editing (the edit-state capture/restore is interleaved
into the renderMessages loop — the realistic move is an in-file
`captureEditState`/`restoreEditState` split, NOT a module), `wireComposer` (the most
coupled surface in the file: `state`, `replyingToId`, `sendWS`, `composerTray`,
`drafts`, `editingMessageId`, the secret-session gate, autocomplete, attachments),
reactions (woven into message rendering + the `mine` invariant), the call strip (PTT
flags), control wiring, bootstrapping, realtime/sync, message rendering/loading,
channel header/selection. With the video grid lifted, the next worthwhile work is
different in kind — tightening that spine (in-file helper splits, leaning the realtime
handler harder on `state.applyEvent`), not carving out more modules.

That spine-tightening is ongoing and is a distinct axis from module extraction: it
splits oversized orchestrator functions into named in-file helpers (same file, no
`createX(deps)` surface, e2e stays the net) and lifts any pure fragment to its home
module. Done so far: the realtime handler named out (above); `renderMessages` split
into `renderSecretView` + `messageRow` + `messageActions`; the sidebar-row class
string deduped into `channelRowClass`; the roster presence word lifted to a pure,
unit-tested `presenceLabel` in `presence.js`; and the fire-and-alert API calls that
don't self-recover routed through the shared `guard()` helper. A later pass split
`renderChannelHeader` into `renderDMHeader` / `renderRegularHeader` (collapsing the
triplicated mobile video/chat-toggle label into `applyHeaderCamLabel`), deduped the
video-grid show/hide teardown into `showVideoGrid` / `hideVideoGrid`, and lifted the
reaction-pill tooltip string to a pure, unit-tested `reactionTooltip` in `format.js`
(the `isCustom`/`isOrphan`/`mine` computation stays in `reactionsRow`).

A further pass tightened five repeated idioms: the `renderChannels()` +
`renderDMs()` + `renderNotificationTotal()` trio that every count/membership change
fired (11 sites) collapsed into `renderSidebarBadges()` (distinct from
`rerenderSidebar`, which also paints the roster); the invite/leave/pins-button +
`dm-active` block duplicated by `loadChannel` and `jumpToMessage` into
`applyChannelAffordances(ch)`; the `80`px "pinned to the live tail" scroll threshold,
which three independent geometry checks must agree on, into a named `NEAR_BOTTOM_PX`
constant; the `state.users[id]?.display_name ?? "Someone"` lookup and the
`"<who> in #<channel>"` notification label into `displayNameOf()` / `pingLabel()`
(shared by the ping toast, the OS ping notification, and the ring banner); and the
`socket && socket.send(...)` send idiom (11 sites) into `sendWS(msg)` — a pure
null-guard, since `ws.js`'s own `send()` already drops non-OPEN frames and never
throws, which also let a now-redundant `try/catch` at the unload site go. The
single-function-local magic numbers (swipe/long-press thresholds) were deliberately
left inline: no cross-site sync hazard, and naming them is churn on hardened gesture
code. All five are e2e-net-covered (full suite green); the ping-toast/OS-notification
label paths have no e2e and rest on inspection (verbatim string moves).

A follow-on cleaned up the `localStorage` access for the last-open channel: the
repeated `try { … } catch` around `getItem`/`setItem` (3 sites) collapsed into
`safeLocalGet` / `safeLocalSet` (best-effort wrappers next to `guard`; read returns
null and write is a no-op when storage is blocked), and the `"rivendell.activeChannel"`
key literal into a single `ACTIVE_CHANNEL_KEY` constant so the two write sites and the
one read site can't silently disagree (a typo'd literal persists under one key and
reads from another, breaking channel restore with no error). This is the app-shell
analog of `prefs.js`'s injected-storage pattern — prefs owns the *preferences* subset
(unit-tested with a Map-backed stub), these cover the session keys app.js holds.
