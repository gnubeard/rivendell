# Frontend decomposition

Breaking `web/static/app.js` (the ~6k-line client orchestrator) into small,
well-understood, well-tested, well-documented modules — incrementally, one
cohesive chunk per commit, each shippable on its own.

This is a living document. Update the status table as chunks land.

## Why

`app.js` is the highest-churn file in the repo and was the only frontend module
with no test coverage. Every other module (`format`, `state`, `voice`, `secret`,
…) is small and has a `web/test/*.test.js` suite. The goal is to bring `app.js`
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

## Module conventions

- **One module = one concern.** Name it for the concern (`unread`, `channelorder`).
- **Header comment states the contract** — what the module owns, what stays in
  the caller, and any invariant a test guards. This is the "well-documented" part.
- **Imports use the `?v=__RIVENDELL_VERSION__` cache-bust suffix**, matching
  app.js (the server rewrites the token; `node --test` ignores the query).
- **Pure modules export functions; stateful ephemeral bookkeeping exports a
  `createX()` factory** (closure-encapsulated, like `createUnreadTracker`) rather
  than module-level mutable globals.
- **Don't move the call sites' job into the module.** Selectors take `state` and
  return values; the module does not render or fetch. DOM/network side effects
  stay in `app.js` (or the chunk's thin adapter).

## Status

| Chunk | Module | Test | Status |
|-------|--------|------|--------|
| Read tracking (divider, mark-unread suppression, POST dedupe) | `unread.js` | unit (15) | ✅ done |
| Sidebar ordering + drag-reorder diff | `channelorder.js` | unit (12) | ✅ done |
| Per-channel composer scratch (draft text + attachments) | `drafts.js` | unit (12) | ✅ done |
| Composer field facade (textarea-on-div) | `composer-field.js` | e2e (composer-paste) | ✅ done |
| Small pure helpers (`humanBytes`) | `util.js` | unit (6) | ✅ done |

### Candidate chunks (not yet scheduled)

Rough inventory of what still lives in `app.js`, for planning. Order TBD.

- **Composer** — `wireComposer`, `uploadAndInsert`, attachment tray render,
  send path. Entangled with `state`/`api`/render fns; extract after the
  self-contained `composer-field` facade. e2e-covered (composer-paste).
- **Theme + preferences** — `applyTheme`/`myTheme`, notif + PTT pref load/save.
  Pure serialization core (parse/format the stored value) → drop into the now-
  existing `util.js` and unit-test; thin localStorage/`<html>` adapter stays.
- `fileTooLarge` (pure size check + an `alert`) still in app.js; it imports
  `humanBytes` from `util.js`. Could move its pure check to `util.js` later.
- **Audio/tones** — `boop`/`playTones`/greet/farewell. Web Audio; e2e or leave.
- **Link/embed previews** — `msgPreviewCache`/`extPreviewCache`/
  `schedulePreviewRender`. A cache state machine (loading/pending/failed) with a
  pure core worth testing; DOM render stays.
- **Boot/auth flow** — `boot`, `wireLogin`, `bootSetPassword`, `bootSignup`,
  `enterApp`. Mostly DOM/network orchestration; e2e territory.
- **Realtime/sync** — `startRealtime`, `resync`, the WS event handler. Folds into
  `state.applyEvent` already; the handler's routing is DOM-heavy.
