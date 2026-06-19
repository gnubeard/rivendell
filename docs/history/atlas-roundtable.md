# The app.js region roundtable (2026-06-19)

An experiment, not a code change. Nine sub-agents were spawned to read one large working
whole — `web/static/app.js` (~4,120 lines) — from eight separate vantage points, form
independent opinions, then meet and compare notes. The goal: learn what a fleet of narrow
experts can surface about a single file that one reader sweeping the whole thing might miss.

**No code was changed.** The only artifact is this record and the documentation proposals it
collects. Line numbers cited are as of this date and will drift.

## Participants & method

Eight region agents (A1–A8), one per `// ▌ REGION N` banner, plus a technical writer (A9).
The run had three phases:

1. **Cold study (parallel).** Each region agent studied ONLY its region's lines, barred from
   `docs/atlas.md`, and produced an opening position (role, mechanisms, invariants, opinions,
   cross-region questions, 0–2 proposals). The **boundary rule**: tracing a symbol just past
   the edge to understand your own region is fine; reading another region's function bodies is
   a violation — unknowns become *questions for the room*.
2. **Atlas reaction + cross-examination (parallel).** Each agent was shown the atlas's writeup
   of its region and the cross-cutting findings, asked where its cold read agreed / went deeper,
   then answered the questions other agents had aimed at its region and voted on proposals
   touching it.
3. **Synthesis + writer.** The chair adjudicated each thread; A9 turned the outcomes into
   documentation proposals.

| Agent | Region | Lines |
|---|---|---|
| A1 | Foundations | 65–223 |
| A2 | Boot & Auth | 224–585 |
| A3 | Realtime | 586–936 |
| A4 | Sidebar & Channels | 937–1745 |
| A5 | Message Pane | 1746–2627 |
| A6 | Composer & Message Actions | 2628–3180 |
| A7 | Control Wiring | 3181–3650 |
| A8 | Shell Chrome & Subsystems | 3651–4120 |
| A9 | Technical Writer | — |

## The dominant theme

Six of eight regions independently hit the **same** failure mode: load-bearing invariants
enforced only by line-order or a single inline comment, with the *enforcing* code in a
**different region** than the *explaining* comment. The room's recurring prescription was
consistent — document the contract on **both** ends and/or add a cheap parity test — **not**
add guards or extract further. Ceremony would trade cohesion for no real safety.

## Per-region headline findings

- **R1 Foundations (A1)** — "the module's vocabulary." Went deeper than the atlas by splitting
  the state block into three ownership classes (app-owned / handle-to-module / legacy-resident).
  Withdrew its ownership-tag proposal once it saw the atlas's "keep prose comments" finding.
- **R2 Boot & Auth (A2)** — `enterApp()` is a 127-line linear ignition; flagged
  wire-before-realtime as enforced only by line order. (Later shown safe-by-construction — see
  below.)
- **R3 Realtime (A3)** — owns the dispatch table. Confirmed the message-pane fast-path decision
  is **split across two sites** (reactions in `handleRealtimeEvent`, messages in
  `onMessageEvent`). Reframed its `decideMessagePane` idea from a carve to a doc.
- **R4 Sidebar & Channels (A4)** — owns the `scheduleRender` batcher. **Withdrew** its own
  relocation proposal after the atlas's "cohesion beats symmetry" (5 of 7 surfaces are
  R4-local). Surfaced that `scheduleRender` does **zero** surface-name validation.
- **R5 Message Pane (A5)** — the gravity well. Found the `isMod`/`canPin`/`activeCh` triple
  duplicated verbatim in **five** functions and grouping logic encoded **twice**.
- **R6 Composer (A6)** — the send handler is the densest/riskiest block; the trailing-whitespace
  trim is a **hand-copied regex** mirroring Go's `TrimRight`.
- **R7 Control Wiring (A7)** — independently corroborated the atlas's "don't extract `wire*`"
  verdict; found that many modal close-buttons bypass `closeModal`.
- **R8 Shell Chrome (A8)** — confirmed exactly three plug-ordering edges and articulated the
  **generative** rule behind them (const-vs-hoisted). Flagged `applyPresence` as a non-pure
  fan-out.

## Cross-region questions → answers (resolved by the owning agent)

- **Can an `onmessage` fire mid-`enterApp` before controls are wired?** (A2→A3) **No.**
  `startRealtime` is synchronous and called last; a WebSocket can't dispatch synchronously. The
  ordering is **safe by construction** today; a `controlsWired` assert is belt-and-suspenders.
- **Who picks fast-path vs full render?** (A5→A3) `onMessageEvent` (~L800) for
  message.new/update/delete, **plus** `handleRealtimeEvent` (~L700) for reactions. Return
  contracts: `reconcileOptimistic`→bool, `patchMessageRow`→bool (false ⇒ full render),
  `appendMessageRow`→undefined (always appends — never branch on it).
- **Does `renderDeletedRun` only tombstone loaded ids? Who calls `pruneLiveDeleted`?** (A1→A5)
  Yes (window ∩ `liveDeleted`); `pruneLiveDeleted` is called from **exactly one** site,
  `loadChannel` (~L1775).
- **Does `refreshReadMarks` patch in place?** (A4→A5) Yes — sets `btn.title` only, no innerHTML
  wipe; selection/scroll survive.
- **Who bumps `avatarVersion`?** (A1→A4) Two sites: R3 on `user.update` (~L725) and R8 after a
  local avatar upload (~L3353). R4 only reads it.
- **Does `selectChannel` close the lightbox?** (A7→A4) **No** — a stale-gallery-on-switch gap
  exists if the lightbox is open during a channel switch.
- **`schedulePresenceUpdate`/`flushPendingPresence` semantics?** (A3→A8) 1500ms debounce,
  per-user; `flushPendingPresence` truly **drops** pending flips (never fires), so a stale flip
  can't land over the post-resync authoritative roster.
- **Edit-textarea Escape `stopPropagation`?** (A7→A6) Yes (~L3028), so global Escape doesn't
  double-fire. `composerRich` genuinely can be undefined pre-`wireComposer` — the `?.` is
  required.

## Agreements vs. conflicts

**The one real conflict — relocating `scheduleRender`/`flushRenders` out of R4 — resolved by
the owner conceding.** A4 (owner) withdrew the proposal; A1 opposed landing it in Foundations
("vocabulary, not behavior"); A8 opposed a new module (it would become a 13th switchboard
plug, re-opening the closed consolidation); A3 supported a move only if the `setTimeout(0)`-not-
rAF rationale travelled with it. **Verdict: keep it in R4; document the surface-name contract
instead.** Everything else converged without dispute.

## Proposals & verdicts

| # | Proposal | Origin | Verdict |
|---|----------|--------|---------|
| 1 | Shared `trim.js` + test for content trimming; document Go as source of truth | A6+A5 | **Adopt (P1).** Strongest convergence; two regions found it independently. |
| 2 | Document the render surface-name set as an R3↔R4 contract; note silent no-op on typo | A4+A3 | **Adopt (P1, doc).** |
| 3 | Document the long-press-on-pending-row no-op as intended | A7+A5 | **Adopt (P3, doc).** Not a bug. |
| 4 | Reciprocal tombstone-contract comment at `renderDeletedRun` (+ unit test) | A1+A5 | **Adopt (P2).** |
| 5 | Document the two-site fast-path decision + return contracts | A3 | **Adopt (P2, doc).** `decideMessagePane` extraction optional/low-priority. |
| 6 | One generative comment for plug ordering (const-vs-hoisted rule + 3 edges) | A8 | **Adopt (P2, doc).** Replaces A8's first idea of a test. |
| 7 | `controlsWired` assert in `startRealtime` | A2 | **Demote to doc.** Ordering safe-by-construction; document *why*. |
| 8 | `rowContextFor(channelId)` helper (dedup ×5) + grouping parity test | A5 | **Refactor proposed-only;** document rationale; parity test P2. |
| 9 | Route every modal dismissal through `closeModal` + lightbox-lifecycle doc | A7 | **Adopt invariant (P2);** refactor proposed-only. |
| 10 | Split side-effects out of `applyPresence` (or document the fan-out) | A8 | **Document the coupling (P3);** rename proposed-only. |
| 11 | `selectChannel` snapshot-before-clear ordering note | A4 | **Adopt (P2, doc).** |
| 12 | Consolidate the 3 password-form validators / named constants | A2 | **Proposed-only, low priority.** |
| 13 | `dismissLoadingScreen`'s local `el` shadows the `el()` builder | A8 | **Note (P3).** Readability landmine. |

## The issue the meeting *discovered*

**POST-success-but-echo-lost → a dangling `pendingSends` row.** No cold read caught this; it
emerged when A6 (send path) and A5 (optimistic tracking) compared notes. The send handler only
covers the **failure** branch (`removePending` on POST throw). On success it relies entirely on
the `message.new` echo to upgrade the dimmed row via `reconcileOptimistic`. If the POST succeeds
but the echo never arrives (socket drop between ack and broadcast, missed frame), the
`pendingSends` entry dangles and the row stays dimmed **forever** — there is no timeout/sweep.
**Proposed safeguard:** a TTL sweep of `pendingSends` that re-queries or rolls the row back to a
retry/error state. Document the gap now (P1); the safeguard is future work (P2).

## Atlas accuracy

The cold reads **independently corroborated** the atlas's cross-cutting Findings 1 (plug
consolidation closed) and 2 (`wire*` not extractable) — the conclusions survived adversarial
review by readers who hadn't seen them. They also went **deeper** than the atlas on internal
topology it omits: two document-level click listeners + three keydown listeners in R7; the
const-vs-hoisted generative rule in R8; the 5× `rowContext` duplication and twice-encoded
grouping in R5; the three-ownership-levels view of R1's state block. Recommended atlas edits:
deepen the R3 blurb (two-site decision), generalize Finding 1's plug-ordering rule, and add a
short "validated by the 2026 roundtable" note.

## A9's documentation proposals (prioritized)

**(A) CLAUDE.md invariants**
- **A-1 (P1)** Trim-parity: Go `TrimRight` is the source of truth; the two JS callers import
  `trimMessageContent` from `trim.js`; a mismatch orphans an optimistic row. → "Message-pane
  rendering" subsection.
- **A-2 (P1)** Render surface names are a fixed R3↔R4 contract; `scheduleRender` does no
  validation (typo ⇒ silent no-paint). → extend the `scheduleRender` bullet.
- **A-3 (P2)** Every modal dismissal must route through `closeModal` (lists the current
  bypassers). → Conventions, frontend block.

**(B) docs/atlas.md**
- **B-1 (P2)** R3 blurb: the fast-path decision is two-site; record the return contracts.
- **B-2 (P2)** R8 / Finding 1: state the *generative* plug-ordering rule, not just the 3 edges;
  note the loud TDZ failure mode.
- **B-3 (P3)** Add a "validated by the 2026 roundtable" note (Findings 1 & 2 corroborated;
  topology the atlas omits).
- **B-4 (P3)** Record the declined/deferred refactors so they aren't re-proposed cold.

**(C) In-file section comments**
- **C-1 (P2)** Reciprocal tombstone-contract comment at `renderDeletedRun` (~L2069) pointing
  back to `pruneLiveDeleted` (~L108).
- **C-2 (P3)** "Intended, not a bug" note at the long-press `findMessage` guard (~L3483).
- **C-3 (P3)** Annotate the safe-by-construction wire-before-realtime ordering at the
  `startRealtime` call site; soften the "fragile" framing.
- **C-4 (P2)** `selectChannel` (~L1396): `hadUnreads` must be snapshotted before `S.clearUnread`.
- **C-5 (P3)** `applyPresence` (~L3939): note it's a cross-subsystem fan-out, not a pure apply.

**(D) New tests**
- **D-1 (P1)** `web/test/trim.test.js` + extract `web/static/trim.js` (`trimMessageContent`);
  assertions mirror Go `TrimRight` (right-side only; interior/leading preserved).
- **D-2 (P2)** Grouping-anchor ↔ `renderMessages`-loop parity test (precedent:
  `format.js`↔`composer-richtext.js`).
- **D-3 (P3)** Tombstone-intersection unit test (window ∩ `liveDeleted`).

**(E) Open gap** — **E-1 (P1 doc / P2 fix)** the POST-success-but-echo-lost dangling row,
documented above.

## Executive summary

`app.js`'s documentation is **strong on macro-navigation and weak on cross-region contracts.**
The atlas's region map and "what won't extract" findings held up under adversarial cold reads —
but six regions independently hit the same failure mode: invariants enforced only by line-order
or a lone comment, with the explaining comment in a different region than the enforcing code. The
richest finding is cross-*language*: message-content trimming is hand-copied across Go and two JS
sites and silently orphans optimistic rows on any drift. The right prescription is overwhelmingly
**prose + cheap parity tests on both ends of each contract**, not new guards or further
extraction. One genuine reliability bug (echo-lost dangling pending row) surfaced **only** in
cross-examination — proof that a file's documentation health is best stress-tested by readers who
each hold just one piece of the whole.
