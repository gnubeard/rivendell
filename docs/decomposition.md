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
carved off later, like `search`/`emoji`/`channeldrag`, are covered by e2e instead).
`api.js`, a thin fetch wrapper, was the last module with no test of either kind;
`api.test.js` now pins its load-bearing parts — the `req()` parse/empty-body/error
contract, the `messages`/`search` query-string assembly, `getLinkPreview`'s
status→shape mapping, `createBotToken`'s conditional body, and the upload helpers'
own error fallback — by stubbing global `fetch` (the URL-builder one-liners are
left alone; testing them would just restate them). The goal is to bring `app.js`
to that same standard without a rewrite: peel off one concern at a time, behind a
documented seam, with the appropriate kind of test.

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
| Small pure helpers (`humanBytes`, `formatTime`, `overSizeLimit`, `initials`) | `util.js` | unit (16) | ✅ done |
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
| Foreground notifications (missed-count badge/title, ping toast, push lifecycle, opt-in control) | `notifyui.js` | e2e (notifications, 3) | ✅ done |
| History/paging + scroll sub-system (older/newer paging, sentinels, history banner, near-bottom math, scrollToBottom) | `history.js` | unit (6) + e2e (history, 3) | ✅ done |

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
feature-module well is dry; the remaining work is spine-tightening, plus the one
sanctioned sub-system carve from the sequenced message-pane pass below (`history.js`,
now done) — not more feature modules.

Still deliberately retained in `app.js` (wireComposer-class entanglements or pure
orchestration): inline message editing (the edit-state capture/restore has since been
split into the in-file `captureEditState`/`restoreEditState` pair — a legibility split,
NOT a module; the `editingMessageId`/`editDraft`/`editFocusPending` state stays in
app.js), `wireComposer` (the most coupled surface in the file: `state`, `replyingToId`,
`sendWS`, `composerTray`, `drafts`, `editingMessageId`, the secret-session gate,
autocomplete, attachments), reactions (the `reactionsRow` DOM stays here woven into
message rendering; the pure `classifyReaction` core and the `mine` invariant are now
spelled out in `format.js`), the call strip (PTT flags), control wiring, bootstrapping,
realtime/sync, message rendering/loading, channel header/selection. With the video grid
lifted, the next worthwhile work is different in kind — tightening that spine (in-file
helper splits, leaning the realtime handler harder on `state.applyEvent`), not carving
out more modules.

### notifyui.js (✅ done), then a sequenced message-pane pass

Two more carves were on deck. They are very different in kind, and the order matters.
The first — **notifyui.js** — is now done (see the status row above); the second — the
**message pane** — is a sequenced pass whose step 3 (`history.js`, the history/paging +
scroll sub-system) is now done; its step 1 remainder (grouping + unread-divider pure
cores) and step 2 (the inline-edit / reactions untangle) are still open. See the
sequencing below.

**notifyui.js — the foreground-notification glue (done, low risk).** The pure
core already left long ago: `notify.js` owns the decision predicate (`shouldNotify`)
and the browser glue (`showNotification`/`currentPermission`/permission request), and
`prefs.js` owns the opt-in persistence. What was still in `app.js` was the *orchestration*
that wires those to the DOM and the realtime handler — a coherent ~160-line cluster
under the "notifications & ring alerts" / "web push subscription" / "settings controls"
banners: `renderNotificationTotal` (title + sidebar badge), `showPingToast` (the
focused-tab mobile toast), `firePing` (the chime + toast-vs-OS-notification decision),
`enablePush`/`disablePush`/`initPushRouting` (the Web Push subscription lifecycle), and
`renderNotifControl` (the profile opt-in row). It carries its own DOM (the `#ping-toasts`
toast, the `#notif-total` badge, the `#notif-enable` control) and its seam into the
spine is narrow — `firePing(evt, ch)` from the realtime handler, plus the push lifecycle
and the profile sub-control — so it lifted cleanly behind `createNotifyUI(deps)`. The
module *owns* `enabled` (the opt-in, seeded from `prefs.loadNotif()`) and `baseTitle`
(set via `setBaseTitle` from `applyInstanceName`); app.js and voiceui.js read the opt-in
through `isEnabled()`, and the profile toggle drives `setEnabled(checked)` (which
encapsulates the request-permission → enable/disable push → save → re-render flow). This
was the **`no` branch / e2e-net** kind of extraction, not a pure-core one — the decision
logic is unit-tested in `notify.js`; the module is DOM/network glue, so
`web/e2e/notifications.spec.js` (3 specs: the missed-count badge/title, the focused-tab
mobile toast + tap-to-navigate, and the opt-in control) is the net, written and run green
against the un-extracted code first per the iron rule.

Two shared-helper snags were resolved *into the pure layer*, not papered over:
`displayNameOf` (the `state.users[id]?.display_name ?? "Someone"` lookup, shared with the
ring banner in voiceui.js) moved to `state.js` as a pure, unit-tested `displayNameOf(state,
id)`; and `pingLabel` (the "<who> in #<channel>" / DM-name string) moved to `format.js` as
a pure, unit-tested `pingLabel(who, ch)`. With those down a layer, notifyui.js and
voiceui.js share the helpers without depending on each other. As predicted it was a
*modest* win — most of the value was banked when `notify.js` was split; this relocated the
remaining glue and shrank app.js by one more concern (~160 lines).

**Message pane — NOT a single lift; a sequenced pass.** The "main message pane" is not a
feature module — it is the orchestrator spine itself (`renderMessages`/`messageRow`/
`messageActions`/`renderSecretView`/`renderTypingIndicator`, the `loadChannel`/
`jumpToMessage` channel-open/jump orchestrators, and — until step 3 carved it out — the
`loadOlder`/`loadNewer` history machinery and scroll geometry), and its constituents are
exactly the wireComposer-class entanglements this doc already lists as deliberately
retained. A monolithic `messagepane.js` would need a 15+ entry deps bag of mutable
session state (`editingMessageId`/`editDraft`/`editFocusPending`, `replyingToId`,
`flashMessageId`, `liveDeleted`, the `unread` tracker, `state`, `socket`, plus cross-calls
to `selectChannel`/`jumpToMessage`/`markActiveChannelRead`/linkpreview/emoji — and, before
step 3, the `loadingOlder`/`loadingNewer`/`historyComplete`/`viewingHistory`/`NEAR_BOTTOM_PX`
paging set now isolated in `history.js`) — which would *relocate* the tangle behind a
bigger, harder-to-follow seam rather than isolate it, and would churn the riskiest DOM in
the app with e2e as the only net. That violates the spine's "don't move the call sites'
job into the module" rule. So the value the owner wants (isolated + tested) is real, but
it comes from the **pure-core + untangle** axis, sequenced:

1. **Lift the pure decision cores and unit-test them** (their homes already exist):
   message *grouping* (consecutive same-author within the time window → the `grouped`
   flag), the *unread-divider* placement decision, and the *near-bottom* scroll-anchor
   decision. **✅ done.** All three are now pure + unit-tested: the near-bottom
   decision is `isNearBottom` in `history.js` (lifted earlier as step-3 groundwork);
   grouping is `shouldGroupMessage` (+ `GROUP_WINDOW_MS`) in `format.js`, with the
   render loop keeping only the `lastUser`/`lastTime` accumulators; and the
   unread-divider placement is `shouldInsertUnreadMarker` in `unread.js` (its home,
   beside `markerFor`/`unreadCountAfter`), the loop keeping the `markerInserted`
   accumulator and the DOM insert. Tested in `web/test/format.test.js` /
   `web/test/unread.test.js`.
2. **Untangle the woven sub-concerns first** — the prerequisite that makes the pane
   legible: inline editing via the in-file `captureEditState`/`restoreEditState` split
   already prescribed above (NOT a module), and reactions (preserving the `mine`
   invariant) out of the `renderMessages` loop. **✅ done.** The inline-edit
   capture/restore is now the in-file `captureEditState(wrap)` / `restoreEditState(wrap,
   snap)` pair (`captureEditState` also stashes the live draft into `editDraft`),
   leaving `renderMessages` with two one-line calls around the `innerHTML` wipe instead
   of two interleaved blocks. Reactions were already a clean seam (`reactionsRow`, out
   of the loop via `messageRow`, injected into `pins.js`); this pass lifted the one
   remaining pure core — the per-pill `mine`/`isCustom`/`isOrphan`/`disabled`
   classification — to `classifyReaction` in `format.js` (the `SHORTCODE_RE` orphan
   test moving with it), explicitly preserving the `mine` invariant: `classifyReaction`
   computes `mine` once and `reactionsRow` threads that exact value into
   `toggleReaction`, no `findMessage` re-lookup. The glyph element and reactor-name join
   stay in `reactionsRow`; e2e net is `emoji-picker` + `mobile-ctx`.
3. **Only then, if a module still earns its keep, carve the history/paging + scroll
   sub-system** (`loadOlderMessages`/`loadNewerMessages`/`observeScrollSentinels`/
   `renderHistoryBanner`/`scrollToBottom` + `historyComplete`/`viewingHistory`/
   `loadingOlder`/`loadingNewer`) — a self-contained sub-system with a clean seam and a
   pure-ish core (paging cursors, near-bottom math), unlike "the whole pane." That is the
   carve to bless, e2e-first; a `messagepane.js` god-module is not.
   **✅ done — `history.js`** (`createHistoryPaging(deps)`): the flags + sentinels +
   the paging fetches moved behind a ~6-entry deps surface, with `PAGE`/`NEAR_BOTTOM_PX`/
   `isNearBottom`/`scrollToBottom` as free scroll-geometry exports. As predicted, the
   channel-open / jump *orchestrators* (`loadChannel`, `jumpToMessage`) stayed in app.js
   and drive the module through accessors (`resetForChannel`/`noteLoadedPage`/
   `clearHistoryComplete`/`markViewingHistory`/`isViewingHistory`) rather than moving
   wholesale — moving them would have dragged `renderChannelHeader`/
   `applyChannelAffordances`/`refreshActiveMembers` in, the very "relocate the call
   sites' job" anti-pattern this section warns against. The e2e-first net
   (`web/e2e/history.spec.js`: open-at-newest, older-paging without snap, jump→history
   banner→catch-up) landed green on the un-carved code first, then guarded the move.
   Step 1's near-bottom math (`isNearBottom`) and step 2's untangle were not blockers —
   the paging seam was clean enough to lift on its own.

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
constant (both since lifted into `history.js` as the unit-tested `isNearBottom`
predicate, the three checks now its callers); the
`state.users[id]?.display_name ?? "Someone"` lookup and the
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

The message-pane pass then closed out its steps 1 and 2 (the remainder after
`history.js`). Step 1's two still-untested pure cores moved to their homes:
`shouldGroupMessage` (+ `GROUP_WINDOW_MS`) in `format.js` — the same-author/within-window/
non-reply `grouped` decision, the render loop keeping only the `lastUser`/`lastTime`
accumulators — and `shouldInsertUnreadMarker` in `unread.js` (beside `markerFor`/
`unreadCountAfter`), the loop keeping the `markerInserted` accumulator and the DOM
insert. Step 2 made `renderMessages` legible without a module: the inline-edit
capture/restore, previously two blocks interleaved through the `innerHTML` wipe, became
the in-file `captureEditState(wrap)` / `restoreEditState(wrap, snap)` pair (capture also
stashes the live draft into `editDraft`), and the last pure fragment of the reactions
path — the per-pill `mine`/`isCustom`/`isOrphan`/`disabled` classification (with
`SHORTCODE_RE`) — lifted to `classifyReaction` in `format.js`. `classifyReaction`
computes `mine` once and `reactionsRow` threads that exact value into `toggleReaction`,
so the `mine` invariant is now spelled out and unit-tested rather than implicit. The
DOM (glyph element, reactor-name join, the editor textarea) stays in app.js. New pure
cores are unit-tested in `web/test/format.test.js` / `web/test/unread.test.js`; the
DOM-bound edit/reaction behavior rests on the `emoji-picker`, `mobile-ctx`, and
`history` e2e nets (all green). With that, the sequenced message-pane pass is complete.

## Where the effort lands (the carve is complete)

A closing re-scan (2026-06) confirms there is no remaining module to carve. Two axes
were checked:

- **Realtime / `state.applyEvent` — closed.** `applyEvent` is total over the
  state-mutating events (`state.js`), and `handleRealtimeEvent` is a clean per-event
  re-render dispatch. The handler's only inline state writes — `bumpUnread`/`bumpMention`
  — are gated by `classifyIncomingMessage`'s view booleans (`active`/`focused`/
  `adminPanelOpen`), which are DOM-derived; pushing them into `applyEvent` would drag
  view state down into the pure layer, so they correctly stay in the handler. Nothing
  further to lean down here.

- **Oversized functions — all blessed retentions.** The only large functions left are
  the entanglements this doc already lists as deliberately retained: `wireComposer`,
  `handleRealtimeEvent` (clean dispatch), `enterApp` (boot), `renderMessages`, and the
  `render*`/`wire*`/`boot*` families. No new god-function has formed.

The one loose pure fragment the re-scan surfaced — `initials(name)`, an avatar-placeholder
helper that was still in `app.js` and injected into `modals.js`/`videogrid.js` — was lifted
to `util.js` (its home beside `humanBytes`/`formatTime`), unit-tested, and dropped from both
deps bags (they import it directly now). That was the last pure-fragment sweep.

What stays in `app.js` is, by design, the orchestrator spine: `wireComposer` and the other
control wiring, inline message editing, the reactions render path (pure core in `format.js`),
the call strip, boot/auth, the realtime/sync dispatch, message rendering/loading, and the
channel header/selection. These are the wireComposer-class entanglements a module would
*relocate* rather than isolate — extracting them is explicitly out of scope. **The
decomposition effort is complete; further work on these is ordinary maintenance, not a
carve.**
