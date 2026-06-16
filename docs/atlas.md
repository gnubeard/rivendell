# app.js — the atlas

`web/static/app.js` is the web client's orchestrator: ~3,470 lines wiring the API,
websocket, formatter, and the pure `state.js` reducer to the DOM. Years of
extraction (see [decomposition.md](decomposition.md)) pulled the *pure* logic and
the *self-contained DOM widgets* out into ~30 sibling modules. What's left is the
glue — deliberately framework-free, unavoidably DOM- and state-entangled — and the
prevailing wisdom became "the rest can't be cleanly split."

Maybe. But the goal was never "more files" for its own sake — it's *understandable
and maintainable*. So instead of forcing another carve, this atlas **maps the
territory**: it imposes a coarse hierarchy on top of the file so you can navigate it
from 50,000 feet, and records the structural observations that fall out of seeing
the whole shape at once.

## How the map is drawn

Two tiers of in-file signage, plus this doc:

- **Regions** (`// ▌ REGION N · NAME`, heavy `━` rule) — 8 continents. The coarse
  tier this atlas added.
- **Sections** (`// --- name ---`, light rule) — 30 pre-existing fine-grained
  markers. Each region is an exact superset of some of these; none were moved.
- **This doc** — the index, the role of each region, and the cross-cutting findings
  the banners can't carry.

The banners are the source of truth for *where* things are (they travel with the
code). This doc is the source of truth for *why* the shape is what it is and *where*
it might want to go. Line numbers below drift as the file changes — trust the banner
text over the numbers, and re-run the grep in "Maintaining the atlas" to refresh.

## The eight continents

| # | Region | Lines | Contains (`// ---` sections) |
|---|--------|-------|------------------------------|
| 1 | **Foundations** | 65–205 | module state |
| 2 | **Boot & Auth** | 206–553 | mobile viewport · notification chime · bootstrapping |
| 3 | **Realtime** | 554–822 | realtime |
| 4 | **Sidebar & Channels** | 823–1581 | rendering · channel reordering · channel & DM actions · channel selection + read state · channel header |
| 5 | **Message Pane** | 1582–2110 | message loading/history/scrolling · message rendering · replies |
| 6 | **Composer & Message Actions** | 2111–2619 | inline autocomplete · composer wiring · emoji picker · inline message editing · link previews · reactions |
| 7 | **Control Wiring** | 2620–3018 | control wiring |
| 8 | **Shell Chrome & Subsystems** | 3019–3478 | drawers/swipe/idle · **feature-module plugs** · modals + user card · admin panel · notifications & ring alerts · presence · avatars & image preloading · loading screen · voice calling · secret session UI |

### R1 · Foundations (65–205)
The module's vocabulary. All mutable module-level state — `state` (the immutable
world model from `state.js`, reassigned every update — read it fresh, never capture
it) plus the ephemeral session cursors (`editingMessageId`, `replyingToId`,
`flashMessageId`, `dmVolume*`, …) — and the DOM micro-helpers `$`, `el`, `show`,
`guard`, `safeLocalGet/Set`. Three plugs (`prefs`, `unread`, `drafts`) are seeded
here because later regions depend on them at eval time.

### R2 · Boot & Auth (206–553)
Page-load → live app. Viewport/audio priming, the `/set-password` and `/invite`
routes (`bootSetPassword`/`bootSignup`), `wireLogin`, and `enterApp()` — the single
big async that fetches users+channels, seeds unread/voice/emoji, restores the last
channel (or a permalink jump), renders the first frame, inits voice + secret, and
wires every control *before* `startRealtime()` (so a transport failure can never
leave handlers unattached — a load-bearing ordering, see CLAUDE.md).

### R3 · Realtime (554–822)
The inbound WebSocket pump. `handleRealtimeEvent` folds each frame into `state` via
the pure `S.applyEvent`/`classifyIncomingMessage` reducers, then dispatches the
*targeted* DOM re-renders by event type and hands `voice.*`/`secret.*` frames to
their subsystems. `resync` re-pulls server state after a reconnect to close the gap
a dead socket left. This is DOM-dispatch territory, not a further pure carve.

### R4 · Sidebar & Channels (823–1581)
Everything left of the message pane, and the channel as an object you act on:
me/theme rendering, the channel/DM/member list builders + badges, `channelDrag`
reorder wiring, the channel-&-DM action verbs (`deleteChannel`, `toggleMute`,
`leaveActiveChannel`, `closeDM`, `startDM`, `selectChannel`), read-state
(`markActiveChannelRead`, `toggleMessageRead`), and the channel header (regular +
DM variants, topic edit, affordances).

### R5 · Message Pane (1582–2110)
The message list itself and the densest DOM+state knot in the file. Paging/history
(`loadChannel`, `jumpToMessage`, driving `historyPaging`), `renderMessages` + the
row builders + edit-state capture/restore (so an inbound event mid-edit can't blow
the editor away), the secret-view render, and the reply banner. **This is the
gravity well every prior extraction attempt bounced off** — so instead of carving
it, the `message rendering` section now opens with a **compose map** of the
`renderMessages` call-tree and the state it reads. Legibility in place, not a split.

### R6 · Composer & Message Actions (2111–2619)
Authoring, and everything you do *to* a message once it (or its draft) exists: the
contenteditable composer (`wireComposer`, ~270 lines) + autocomplete + emoji picker,
inline message editing (`editorFor`/`startEdit`/`commitEdit`), link previews, and
reactions.

### R7 · Control Wiring (2620–3018)
The one-time `wire*` control-binding functions that attach static-DOM event
listeners (`wireDelegatedClicks`, `wireProfileControls`, …, aggregated by
`wireControls`, run once from `enterApp`), plus the shared `openLightbox`/
`closeModal` helpers. The 11 `wire*` functions form the single most self-similar
block left in the file — but a *traced non-candidate* for extraction: its ~35-symbol
injection surface is ~2× the codebase's widest bag (Finding 2). The feature-module
plugs that used to live here moved to R8's switchboard.

### R8 · Shell Chrome & Subsystems (3019–3478)
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

What the 50,000-foot view makes obvious:

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
30 section markers and dense rationale comments throughout — the navigation problem
wasn't *absence* of labels but *flatness*: 30 equal-weight sections and no overview.
The regions + this doc add the missing tier. Keep leaning on prose comments at the
section level; that culture is working.

## Reorg candidates

Modest, reversible moves the map suggested. The plug consolidation and the
load-order annotations are done; the R5 legibility pass has a first cut. Remaining
open work is noted inline below.

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
- **~~Don't chase R5 — but make it legible in place.~~** ◐ *First cut done.* No file
  split (it's a state projection with no owned state — extraction would just widen a
  dependency bag). Instead the message-rendering section now opens with a **compose
  map**: the `renderMessages` call-tree, its builders, and the exact slice of module
  state it reads. Next passes, if wanted: give `messageRow`/`messageActions` the same
  header treatment, or split the ~115-line `renderMessages` body into named locals
  (`renderDeletedRun`, `renderSystemMessage`) — legibility only, still one file.

## Maintaining the atlas

The banners move with the code; this doc's line numbers don't. To refresh the table
after edits:

```sh
grep -nE '▌ REGION|^// --- ' web/static/app.js
```

When you add or relocate a region, update **both** the in-file banner and the table
here. When a reorg candidate above gets done, move it from "candidates" to a note in
the relevant region and record the outcome.
