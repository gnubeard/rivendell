# app.js — the atlas

`web/static/app.js` is the web client's orchestrator: ~4,100 lines wiring the API,
websocket, formatter, and the pure `state.js` reducer to the DOM. Years of
extraction (see [history/frontend-decomposition.md](history/frontend-decomposition.md))
pulled the *pure* logic and the *self-contained DOM widgets* out into ~30 sibling
modules. What's left is the glue — deliberately framework-free, unavoidably DOM- and
state-entangled — and the prevailing wisdom became "the rest can't be cleanly split."

Maybe. But the goal was never "more files" for its own sake — it's *understandable
and maintainable*. So instead of forcing another carve, this atlas **maps the file**:
it imposes a coarse hierarchy on top of `app.js` so you can navigate it from the top
down, and records the structural observations that fall out of seeing the whole shape
at once.

## How the map is drawn

Two tiers of in-file signage, plus this doc:

- **Regions** (`// ▌ REGION N · NAME`, heavy `━` rule) — 8 regions. The coarse
  tier this atlas added.
- **Sections** (`// --- name ---`, light rule) — 31 fine-grained markers (30
  pre-existing, plus `incremental message updates` added in R5 with the
  incremental-render work). Each region is an exact superset of some of these.
- **This doc** — the index, the role of each region, and the cross-cutting findings
  the banners can't carry.

The banners are the source of truth for *where* things are (they travel with the
code). This doc is the source of truth for *why* the shape is what it is and *where*
it might want to go. **This doc carries no line numbers on purpose** — they were the
drift-prone artifact the banners replaced, so navigate by banner text and grep for it
(see "Maintaining the atlas"), never by a number quoted here.

## The eight regions

| # | Region | Contains (`// ---` sections) |
|---|--------|------------------------------|
| 1 | **Foundations** | module state |
| 2 | **Boot & Auth** | mobile viewport · notification chime · bootstrapping |
| 3 | **Realtime** | realtime |
| 4 | **Sidebar & Channels** | rendering (incl. the render-batching substrate) · channel reordering · channel & DM actions · channel selection + read state · channel header |
| 5 | **Message Pane** | message loading/history/scrolling · message rendering · incremental message updates · replies |
| 6 | **Composer & Message Actions** | inline autocomplete · composer wiring · emoji picker · inline message editing · link previews · reactions |
| 7 | **Control Wiring** | control wiring |
| 8 | **Shell Chrome & Subsystems** | drawers/swipe/idle · **feature-module plugs** · modals + user card · admin panel · notifications & ring alerts · presence · avatars & image preloading · loading screen · voice calling · secret session UI |

### R1 · Foundations
The module's vocabulary. All mutable module-level state — `state` (the immutable
world model from `state.js`, reassigned every update — read it fresh, never capture
it) plus the ephemeral session cursors (`editingMessageId`, `replyingToId`,
`flashMessageId`, `dmVolume*`, …) — and the DOM micro-helpers `$`, `el`, `show`,
`guard`, `safeLocalGet/Set`. Three plugs (`prefs`, `unread`, `drafts`) are seeded
here because later regions depend on them at eval time.

### R2 · Boot & Auth
Page-load → live app. Viewport/audio priming, the `/set-password` and `/invite`
routes (`bootSetPassword`/`bootSignup`), `wireLogin`, and `enterApp()` — the single
big async that fetches users+channels, seeds unread/voice/emoji, restores the last
channel (or a permalink jump), renders the first frame, inits voice + secret, and
wires every control *before* `startRealtime()` (so a transport failure can never
leave handlers unattached — a load-bearing ordering, see CLAUDE.md).

### R3 · Realtime
The inbound WebSocket pump. `handleRealtimeEvent` folds each frame into `state` via
the pure `S.applyEvent`/`classifyIncomingMessage` reducers, then dispatches the
*targeted* DOM re-renders by event type and hands `voice.*`/`secret.*` frames to
their subsystems. `resync` re-pulls server state after a reconnect to close the gap
a dead socket left. This is DOM-dispatch territory, not a further pure carve.

The message-pane **fast-path vs. full-render** decision is **two-site**: reactions
decide in `handleRealtimeEvent`, messages decide in `onMessageEvent`.
Return contracts to honor: `reconcileOptimistic` and `patchMessageRow` return a
**bool** (false ⇒ fall back to a full `renderMessages`); `appendMessageRow` returns
**undefined** and always appends — never branch on its result.

### R4 · Sidebar & Channels
Everything left of the message pane, and the channel as an object you act on:
me/theme rendering, the channel/DM/member list builders + badges, `channelDrag`
reorder wiring, the channel-&-DM action verbs (`deleteChannel`, `toggleMute`,
`leaveActiveChannel`, `closeDM`, `startDM`, `selectChannel`), read-state
(`markActiveChannelRead`, `toggleMessageRead`), and the channel header (regular +
DM variants, topic edit, affordances). The `rendering` section also opens with the
**render-batching substrate** (`scheduleRender`): realtime event repaints mark a
surface dirty and coalesce into one paint per task (`setTimeout(0)`, deliberately
*not* rAF — see the message-pane invariant in CLAUDE.md). The synchronous load/
jump/scroll paths still call the render fns directly.

### R5 · Message Pane
The message list itself and the densest DOM+state knot in the file. Paging/history
(`loadChannel`, `jumpToMessage`, driving `historyPaging`), `renderMessages` +
edit-state capture/restore (so an inbound event mid-edit can't blow the editor away),
the secret-view render, and the reply banner. **This is the gravity well every prior
extraction attempt bounced off.** The pure ROW builders that *renderMessages* drives —
`messageRow` and its leaves, plus the `grouping`/`insertion`/`rowContext` helpers —
were finally carved out to `messagelist.js` (`createMessageList`, READ-ONLY on state
behind a ~small deps object) once the per-row action closures became a `data-act`
dispatch (R7). What stays in R5 is the orchestration the well is actually made of:
`renderMessages`, the edit-state lifecycle, the secret view, and optimistic send —
they call the module's row builders. The `message rendering` section opens with a
**compose map** of the `renderMessages` call-tree and the state it reads.
The `incremental message updates` section (`appendMessageRow`/`patchMessageRow`/
`refreshReadMarks`, plus the optimistic-send trio `showOptimisticSend`/
`reconcileOptimistic`/`removePending`) is the event fast path: it patches the one row
an event touched — or paints a dimmed pending row on send and reconciles it on the
echo — so a reader's text selection and scroll survive live traffic, with the full
`renderMessages` as the channel-open/jump/resync source of truth and the fallback.
Pending optimistic rows live in the DOM but NOT in `state.messages`, so both the
append and the reconcile route through `insertionPointFor` to drop a real row at its
array-sorted DOM slot (above the pending tail), keeping DOM order == array order — a
cross-user message can't land below your pending row and group avatarless under it.

### R6 · Composer & Message Actions
Authoring, and everything you do *to* a message once it (or its draft) exists: the
contenteditable composer (`wireComposer`, ~270 lines) + autocomplete + emoji picker,
inline message editing (`editorFor`/`startEdit`/`commitEdit`), link previews, and
reaction toggling (`toggleReaction`; the `reactionsRow` pill builder itself now lives
in `messagelist.js`).

### R7 · Control Wiring
The one-time `wire*` control-binding functions that attach static-DOM event
listeners (`wireDelegatedClicks`, `wireProfileControls`, …, aggregated by
`wireControls`, run once from `enterApp`), plus the shared `openLightbox`/
`showLightboxAt`/`closeModal` helpers. `openLightbox` snapshots `#message-list`'s
`a.msg-image-link` anchors into a per-channel image gallery (module-level
`lightboxImages`/`lightboxIndex`); `showLightboxAt` steps it with wrap-around,
driven by the ‹ › buttons + swipe (`wireModalDismissal`) and the Left/Right arrow
keys (`wireGlobalKeys`). The 11 `wire*` functions form the single most self-similar
block left in the file — but a *traced non-candidate* for extraction: its ~35-symbol
injection surface is ~2× the codebase's widest bag (Finding 2). The feature-module
plugs that used to live here moved to R8's switchboard.

### R8 · Shell Chrome & Subsystems
The remaining shell behaviors and **the consolidated plug switchboard**:
drawers/swipe/idle, then the `feature-module plugs` section (`forward`, `mobileCtx`,
`pins`, `search`, `notifUI` — folded here from R7) followed by modals + user card,
admin panel, notifications & ring alerts, presence (debounced — see the 1.5s
`schedulePresenceUpdate`, deliberately *not* immediate), avatars & image-warming,
the loading screen, voice/video, and the secret-chat UI — then the lone `boot()`
call on the last line that starts everything. The plug ordering constraint that
survives: `forward` before `mobileCtx` (which injects `openForwardModal`), and
`mobileCtx` after `emojiPicker` (R6); everything else they reference is a hoisted
function declaration, which is what made the fold safe.

## Cross-cutting findings

What the whole-file view makes obvious:

### 1. The plugs were scattered across 6 of 8 regions — now partly consolidated.
The `const x = createX({...})` factory wirings — app.js handing each extracted
module its dependency bag — live in R1 (`prefs`/`unread`/`drafts`), R2
(`createTelemetry`), R4 (`channelDrag`), R6 (`createComposerRichText`/
`createAttachmentTray`/`emojiPicker`/`linkPreviews`), and R8 (the
`feature-module plugs` section + `modals`/`adminPanel`/`imageWarm`/`historyPaging`/
`videoGrid`/`voiceUI`/`secretUI`).

**Done:** the five movable feature-module plugs (`forward`, `mobileCtx`, `pins`,
`search`, `notifUI`) were folded out of R7 into a single `feature-module plugs`
section at the head of R8's plug area, so R7 is now purely control-wiring and the
plugs form one switchboard. Safe because, of everything they inject, the only
eval-time dependency was `mobileCtx` reading `forward`'s `openForwardModal` (order
preserved); every other reference is a hoisted function declaration or a lazy arrow.

**And the thread is now closed — the rest should *not* be folded in.** Tracing every
remaining plug's bag shows the "they're all TDZ-pinned" intuition was wrong: after
the fold there are only **three** genuine eval-time `const`→`const` constraints
(`mobileCtx`←`forward`, `mobileCtx`←`emojiPicker`, `voiceUI`←`videoGrid`), all now
annotated inline. Almost everything else is reachable through a hoisted `function`
declaration or a lazy arrow, so it's *movable* — but movable isn't a reason to move.
`channelDrag` (R4), `emojiPicker`/`linkPreviews` (R6), and `prefs`/`unread`/`drafts`
(R1) sit beside their only consumers on purpose; `prefs`/`unread`/`drafts` must also
lead because eval-time code below reads them. Folding those into the switchboard
would trade cohesion for symmetry and lose. The 5-plug fold was the right and
sufficient consolidation; this finding is resolved.

**The generative rule** (so the three edges aren't memorized as magic): a plug must be
declared *before* any later plug whose dependency bag names its `const` export — that's
an eval-time read of an as-yet-uninitialized `const`, so getting it wrong throws a loud
TDZ `ReferenceError` at boot (not a silent failure). A dependency reached through a
**hoisted `function` declaration** or a **lazy arrow** is order-free (the binding exists
or is only read at call time), which is why almost every other plug is movable. The three
current edges (`mobileCtx`←`forward`, `mobileCtx`←`emojiPicker`, `voiceUI`←`videoGrid`)
are exactly the cases where a bag names another plug's `const` at eval time.

### 2. The `wire*` block *looks* extractable but isn't — traced and declined.
The ten one-time control-binding functions share one shape (query static DOM, attach
listeners, call app/feature methods), which made a `wiring.js` carve look like the
cleanest remaining move. **Tracing the dependency surface kills it.** The module
would need **~35 app.js symbols injected**: 25 functions (`selectChannel`,
`jumpToMessage`, `applyTheme`, `renderMe`/`renderMessages`, the `open*Modal` set,
`navigate*`, `cancelEdit`, `findMessage`, …), 6 plugs/objects (`notifUI`, `prefs`,
`emojiPicker`, `search`, `avatarVersion`, the live `composerRich`), and a
`getState`/**`setState`** bridge — the last because `wireProfileControls` *reassigns*
`state`. That's ~2× the widest bag in the codebase (`voiceUI` ≈ 16); the seam would
re-export half of app.js's internal API as parameters.

Decisive point: every *successful* prior carve extracted behavior **plus its own
state** behind a **narrow** surface. This block is the inverse — zero owned state, no
isolatable logic, maximal surface, already fully covered by e2e (nothing to gain in
testability). The self-similarity is what makes it readable **in place**, not
evidence that it separates. **Verdict: do not extract.** A couple of functions have a
narrow bag (`wireSearchControls`→`search`, `wireDrawerToggles`), but folding only
those would break the uniform "modules own behavior, app.js wires the static DOM"
rule and trade consistency for nothing. Resolved.

### 3. The file already self-documents; what was missing was hierarchy.
31 section markers and dense rationale comments throughout — the navigation problem
wasn't *absence* of labels but *flatness*: equal-weight sections and no overview.
The regions + this doc add the missing tier. Keep leaning on prose comments at the
section level; that culture is working.

## Reorg candidates

Modest, reversible moves the map suggested. All four are now done — the plug
consolidation, the load-order annotations, the R5 legibility pass, and the
incremental-render rebuild (incl. the optimistic-send follow-on). Kept here as a
record of what was decided and why.

- **~~Acknowledge the de-facto switchboard.~~** ✅ *Done.* The five movable R7 plugs
  (`forward`, `mobileCtx`, `pins`, `search`, `notifUI`) were folded into a new
  `feature-module plugs` section at the head of R8, collapsing the scattered clusters
  into one switchboard. R7 is now purely control-wiring. Verified by the `forward`,
  `mobile-ctx`, `pins`, `search`, and `notifications` e2e specs (97/97 green).
- **~~Annotate the load-order constraints.~~** ✅ *Done.* The tracing turned up only
  three real eval-time `const`→`const` orderings; each now carries an inline note
  (`voiceUI`←`videoGrid`, plus the two `mobileCtx` deps in the `feature-module plugs`
  header). `channelDrag` and `modals` got "placed for cohesion / saved by hoisting"
  notes so the *non*-constraints don't read as mysterious either. See Finding 1.
- **~~Don't chase R5 — but make it legible in place.~~** ✅ *Done.* No file split
  (it's a state projection with no owned state — extraction would just widen a
  dependency bag). The message-rendering section opens with a **compose map** (the
  `renderMessages` call-tree, its builders, and the exact slice of module state it
  reads), AND both follow-on passes shipped: the `renderMessages` loop body is now
  split into named locals (`renderDeletedRun`, `renderSystemMessage`, plus
  `renderSecretView`/`captureEditState`/`restoreEditState`), and `messageRow`/
  `messageActions` carry the same header-comment treatment. Legibility only — still
  one file, no extraction.
- **~~Stop full-rebuilding the pane on every event.~~** ✅ *Done* (incremental-render
  pass). `renderMessages`'s full `innerHTML` wipe ran on nearly every realtime event,
  wiping any active text selection and re-running `formatMessage` on every loaded row.
  Added a `scheduleRender` batching substrate (R4) and the `incremental message
  updates` section (R5): `message.new` appends one row, `reaction.update`/
  `message.update` swap one row, and `read.update`/`markActiveChannelRead` refresh the
  👁 titles in place — full render kept as the fallback. Verified by
  `web/e2e/live-append.spec.js` (selection survives an incoming message + a reaction).
  The *separate* follow-on — an optimistic local echo on send (show the row before the
  server round-trips) — also shipped (2.0.16): `showOptimisticSend`/`reconcileOptimistic`/
  `removePending` in the `incremental message updates` section, guarded by
  `web/e2e/optimistic-send.spec.js`.

## Validated by the 2026 roundtable

On 2026-06-19 nine sub-agents cold-read `app.js` one region each (no atlas access),
then met to compare notes (full record: `docs/history/atlas-roundtable.md`). The
exercise **independently corroborated** Findings 1 (plug consolidation is closed) and 2
(`wire*` is not extractable) — the conclusions survived adversarial review by readers who
hadn't seen them. The cold reads also went deeper than this map on topology it omits:
the **two-site** fast-path decision (now in the R3 blurb), the const-vs-hoisted
**generative** plug-ordering rule (now in Finding 1), R5's `rowContext` triple duplicated
across five functions and grouping logic encoded twice, and R7's two document-level click
listeners + three keydown listeners.

**Declined / deferred refactors** (recorded so they aren't re-proposed cold):
- **Relocating `scheduleRender`/`flushRenders` out of R4 — declined.** The owner withdrew
  it; 5 of 7 render surfaces are R4-local, so cohesion beats symmetry. The surface-name
  contract is documented in CLAUDE.md instead.
- **A `controlsWired` runtime assert in `startRealtime` — declined.** The wire-before-
  realtime ordering is safe by construction (`startRealtime` is synchronous and called
  last; a WebSocket can't dispatch synchronously). Documented, not guarded.
- **`rowContextFor(channelId)` helper (dedup ×5) — proposed-only.** Collapse the
  `isMod`/`canPin`/`activeCh` triple in the `renderMessages` loop, `appendMessageRow`,
  `patchMessageRow`, `showOptimisticSend`, `reconcileOptimistic`. Optional polish.
- **Route every modal dismissal through `closeModal` — proposed-only** (invariant adopted;
  see CLAUDE.md). Several close-buttons hide their modal inline today.
- **Rename `applyPresence` to read as a cross-subsystem fan-out — proposed-only.**
- **Consolidate the 3 password-form validators + lift `≥10`/username-regex to named
  constants — proposed-only, low priority.**

## Maintaining the atlas

The banners move with the code; this doc intentionally quotes **no line numbers**, so
it can't drift out of sync with them (the metadrift this doc used to have). To find a
region or section, grep for its banner text:

```sh
grep -nE '▌ REGION|^// --- ' web/static/app.js
```

When you add or relocate a region, update **both** the in-file banner and the table
here (which lists regions/sections by name only). When a reorg candidate above gets
done, move it from "candidates" to a note in the relevant region and record the
outcome.
