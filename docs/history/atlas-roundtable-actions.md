# app.js roundtable — forward action plan

**Handoff for a fresh context.** This turns the findings in
[`atlas-roundtable.md`](atlas-roundtable.md) into discrete, independently-shippable work
units. Read that record for the *why*; read this for the *what to do*. Nothing here has been
implemented yet — the roundtable was a read-only experiment.

> Status as of 2026-06-19: **all five work units implemented** on branch
> `roundtable-recommendations` (version `2.1.1-roundtable-recommendations.1`). WU-1 added
> `web/static/trim.js` (+test); WU-2 landed the CLAUDE.md/atlas docs; WU-3 added the C-1..C-5
> in-file comments and extracted `web/static/grouping.js` (`groupingAnchor` +
> `liveDeletedStillLoaded`, +parity test) for D-2/D-3; WU-4 fixed echo-lost by reconciling
> from the POST response (NOT a TTL sweep — the POST returns the created message) with a new
> echo-dropped e2e case; WU-5 added `rowContextFor`, routed the five modal close-buttons
> through `closeModal`, and consolidated the password validators. The bare `applyPresence`
> rename was deliberately skipped (the C-5 doc already captures the fan-out; a rename is
> net-negative churn). Full `make test` + `make test-e2e` green (120/120).

## Conventions a fresh context MUST respect (from CLAUDE.md)

- **Zero new dependencies.** A new *first-party* JS module (e.g. `trim.js`) is fine — that's
  the existing carve pattern. No npm/Go third-party additions.
- **Branch = `develop`.** Work on develop (or a feature branch off it); end on develop. A
  commit to develop auto-deploys to test.
- **Version bump rule.** Bump `Version` in `internal/config/config.go` (patch) **only** when a
  *shipping* source file changes (server code, `web/static`, `web/sw.js`, `web/index.html`,
  `web/manifest.json`, `Dockerfile`, `go.mod`). **Doc-only** (`CLAUDE.md`, `docs/`) and
  **test-/tooling-only** (`web/test`, `web/e2e`) changes do **not** bump and do **not** deploy.
  So WU-2 and WU-3 below need no bump; WU-1, WU-4, WU-5 do.
- **Tests before done.** `make test` (Go + web). Web tests run as `node --test web/test/*.test.js`
  (directory arg is misinterpreted). `TEST_DATABASE_URL` is auto-set via `Makefile.local` — don't
  pass it by hand. e2e (`make test-e2e`) only gates a push to `main`.
- **Frontend ES modules** import siblings with bare relative specifiers (`./trim.js`).

## Work units, in recommended order

### WU-1 — Trim-parity: extract `trim.js` (P1, flagship) — *shipping, bump*
The richest finding: trailing-whitespace trimming is hand-copied across Go and two JS sites;
optimistic reconcile matches by exact content, so any drift orphans a dimmed phantom row.

- **New** `web/static/trim.js`: `export const trimMessageContent = (s) => s.replace(/[ \t\r\n]+$/, "");`
  with a header comment naming `handlers_messages.go`'s `strings.TrimRight(content, " \t\r\n")`
  as the source of truth.
- **Edit** `web/static/app.js`: replace the inline `.replace(/[ \t\r\n]+$/, "")` at the composer
  send path (~L2889) with `trimMessageContent(...)`; import it. Confirm `reconcileOptimistic`'s
  match still compares the same normalized string (R5 confirmed it reuses the composer's already-
  trimmed `content`, so no second trim is needed there — but import-and-use if any normalization
  is later added).
- **New** `web/test/trim.test.js`: assert right-side-only trimming — `"hi \t\r\n"→"hi"`, interior
  & leading whitespace preserved, whitespace-only→`""`. Comment the Go cutset as the spec.
- **Edit** `CLAUDE.md` → "Message-pane rendering": the A-1 invariant (Go is source of truth; both
  JS callers import `trimMessageContent`; mismatch ⇒ stuck dimmed duplicate).
- **Acceptance:** `node --test web/test/*.test.js` green; `web/e2e/optimistic-send.spec.js` still
  green (run via `make test-e2e` if pushing main). Bump Version.

### WU-2 — Documentation batch (P1–P3) — *doc-only, no bump, no deploy*
One commit, zero code risk. Safe to do first if you want momentum.

- `CLAUDE.md`:
  - **A-2 (P1)** extend the `scheduleRender` bullet: surface names
    `{channels,dms,members,me,total,typing,messages}` are a fixed R3↔R4 contract; `scheduleRender`
    does **no** validation — an unknown surface is silently never painted.
  - **A-3 (P2)** Conventions/frontend block: every modal dismissal must route through `closeModal`
    (lists bypassers: `#channel-close`, `#invite-close`, `#emoji-manager-close`, `#search-close`,
    `#forward-close`, profile-save & channel-create success paths).
  - **E-1 (P1)** "Message-pane rendering" known-gap line: POST-success-but-echo-lost dangles a
    `pendingSends` row (see WU-4).
- `docs/atlas.md`:
  - **B-1 (P2)** R3 blurb: the fast-path decision is **two-site** (reactions in
    `handleRealtimeEvent` ~L700; messages in `onMessageEvent` ~L800); record return contracts
    (`reconcileOptimistic`/`patchMessageRow`→bool, false⇒full render; `appendMessageRow`→undefined,
    never branch on it).
  - **B-2 (P2)** R8/Finding 1: state the *generative* plug-ordering rule (a plug precedes any later
    plug whose bag names its `const` export; hoisted-fn deps are order-free; loud TDZ on violation)
    + the three current edges.
  - **B-3 (P3)** add a "validated by the 2026 roundtable" note; **B-4 (P3)** record the
    declined/deferred refactors (WU-5) so they aren't re-proposed cold.

### WU-3 — In-file comments + parity tests (P2–P3) — *test-/comment-only, no bump*
Comments touch `web/static/app.js` (a shipping file) — **but** if the commit is comment-only you
may use `RUN_BUMP=0 RUN_DEPLOY=0` per CLAUDE.md. New tests are test-only.

- In-file comments (place at the named sites): **C-1** reciprocal tombstone contract at
  `renderDeletedRun` (~L2069) pointing to `pruneLiveDeleted` (~L108, called only from
  `loadChannel` ~L1775); **C-4** `selectChannel` (~L1396) `hadUnreads` must be snapshotted before
  `S.clearUnread`; **C-2** long-press `findMessage` guard (~L3483) is an intended no-op for pending
  rows; **C-3** safe-by-construction wire-before-realtime note at the `startRealtime` call site;
  **C-5** `applyPresence` (~L3939) is a cross-subsystem fan-out, not pure.
- **D-2 (P2)** grouping-anchor ↔ `renderMessages`-loop parity test (precedent:
  `format.js`↔`composer-richtext.js` parity test). May require exporting the grouping predicate.
- **D-3 (P3)** tombstone-intersection unit test (window ∩ `liveDeleted`).

### WU-4 — Echo-lost safeguard (P2 fix) — *shipping, bump*
The bug the meeting *discovered*. On POST success the send path relies entirely on the
`message.new` echo to upgrade the dimmed row; if the echo never arrives, the `pendingSends` entry
dangles forever.

- **Edit** `web/static/app.js` (R5 optimistic-send region): add a TTL sweep of `pendingSends`
  (timer or next-render-tick) that, past a threshold, either re-queries the message or rolls the
  row back to a retry/error state. Keep the negative-temp-id + `insertionPointFor` invariants intact.
- **Edit** `web/e2e/optimistic-send.spec.js`: add a case that drops the `message.new` echo (the
  typing spec already demonstrates routing-drop) and asserts the row doesn't stay dimmed forever.
- **Acceptance:** new e2e case green; existing optimistic-send/live-append green. Bump Version.

### WU-5 — Proposed-only refactors (P2–P3, optional) — *shipping, bump each*
Documented in WU-2/B-4 so they're not lost. Do only if desired; each is independent.

- `rowContextFor(channelId)` helper in R5 — collapse the `isMod`/`canPin`/`activeCh` triple
  duplicated verbatim in 5 functions (renderMessages loop, `appendMessageRow` ~2409,
  `patchMessageRow` ~2436, `showOptimisticSend` ~2497, `reconcileOptimistic` ~2530).
- Route the bypassing modal closers through `closeModal` (pairs with A-3).
- Rename/clarify `applyPresence` as a fan-out (pairs with C-5).
- Consolidate the 3 R2 password-form validators + lift `≥10` / username-regex to named constants.

## Suggested sequencing

1. **WU-2** (doc-only, zero risk) — lands the knowledge immediately, no deploy.
2. **WU-1** (flagship, highest value) — the trim seam; one focused commit.
3. **WU-3** (comments + parity tests) — cheap durability.
4. **WU-4** (the real fix) — needs care + an e2e case.
5. **WU-5** (optional polish) — only if there's appetite.

## Verification recipe

- After any web change: `node --test web/test/*.test.js`; `make test-web`.
- Full: `make test` (Go + web; DB URL auto-supplied).
- If pushing to `main`: `make test-e2e` runs the Playwright suite (the release gate).
- Confirm scope: `git status` should show only the files for the WU you're on; doc/test-only
  commits must **not** bump `internal/config/config.go`.

## What NOT to do (settled by the room)

- **Do not relocate `scheduleRender`/`flushRenders` out of R4.** Owner withdrew the idea;
  cohesion-beats-symmetry (5 of 7 surfaces are R4-local). Document the contract instead (A-2).
- **Do not add a `controlsWired` runtime guard.** The ordering is safe by construction; document
  *why* (C-3).
- **Do not extract `wire*` (R7) or carve R5/R6.** Re-confirmed by independent cold reads — the
  injection surface is ~2× the widest bag; legibility-in-place is the right call.
- **Do not propose new `createX` carves** generally — per `project-appjs-decomposition` memory,
  the well is dry. `trim.js` is a pure-function module, not a stateful plug carve.
