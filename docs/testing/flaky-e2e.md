# Flaky e2e — log of timing races found and hardened

On 2026-06-18 a doc-only `develop` push tripped the `pre-push` e2e gate **twice in a
row, each time on a different spec**, then passed on a third run against the identical
tree. That is the signature of timing races in the specs, not regressions in the app.
That push named two offenders (`channel-reorder`, `remove-embed`); hardening them and
then stress-running the *full* suite repeatedly (10×+ batches) surfaced three more in the
call specs that only appear under whole-suite CPU contention. Five issues in all — **#1–#4
are fixed (test-only; no app code changed)**; **#5 is a genuine, rare, pre-existing
call-UI bug that is NOT yet fixed** — its diagnosis is handed off to a dedicated
investigation ([call-ui-video-staleness.md](call-ui-video-staleness.md)), so the two
tests it affects stay occasionally red under full-suite load for now. The config runs
**0 retries** (workers 1, serial), so a race fails the gate directly — the fix is always
to make the wait deterministic (or fix the real bug), never to add retries.

The standing rule: **every wait keys on an observable condition, never on wall-clock
luck.** No `waitForTimeout` to mask a race, no measuring geometry before layout settles,
no reading server-backed state before the write that produced it is acknowledged.

The one antipattern that actually flakes is a **non-retrying snapshot**: `expect(await
fn())` on a plain JS value, or a `getBoundingClientRect()` read via `page.evaluate`.
Playwright's locator assertions (`expect(locator).toHaveCount/toHaveText/toBeVisible/…`)
**auto-retry** up to `expect.timeout` (15s here) and are *not* races — don't churn them
into `expect.poll`. Use `expect.poll` precisely where auto-retry can't reach: a computed
JS value or geometry.

## 1. `channel-reorder.spec.js` — reload raced the persistence PATCH(es) — RESOLVED

Observed failure: the post-reload assertion read `[b, c, a]` instead of `[c, a, b]`.

Root cause: the drop fires a `PATCH /api/channels/{id}` per moved channel (via
`channeldrag.js`'s `Promise.all` over `api.updateChannel`) to persist the new order. The
live-DOM poll (`expect.poll(trioOrder)`) goes green off the **optimistic in-DOM move**
while those PATCHes are still in flight. The subsequent `page.reload()` rebuilds the list
from a **single** server fetch at load — so a reload that beats the PATCHes loads the
*stale* order and never re-sorts. (Polling the post-reload assertion would not help:
there's no second rebuild after load for a poll to converge on.)

Fix (shipped): before reloading, poll the server's own order directly —
`GET /api/channels`, filter to the trio, sort by `position` then `name`, and wait until
it equals `[N3, N1, N2]`. This keys the reload on persistence at the source and is
independent of how many PATCHes fired (so it's more robust than awaiting a single
`waitForResponse`, which would resolve on the first of several).

## 2. `remove-embed.spec.js` (bare-URL inline image) — THREE stacked races — RESOLVED

This spec turned out to hide three independent races, peeled back one at a time under a
20× stress loop. The original hit-list named only the first.

**(a) Geometry measured before the image has intrinsic size.** Observed: `cx >=
embed.left - 1` failed with `cx` ~15px *left* of the embed — the `×` is `position:
absolute; right: 6px` inside the `a.msg-image-link.embed-host` inline-block, which
collapses to ~0 width until the routed PNG decodes (`naturalWidth 0, complete false` at
the failing read). Fix: read the geometry **inside `expect.poll`**, gated on the `<img>`
being `complete && naturalWidth > 0`, and re-measure until the button is contained — so a
re-render mid-measure (see below) just retries instead of failing a snapshot.

**(b) The message is delivered twice; the second delivery reverts the edit.** Observed:
after the × click, `expect(img.msg-image).toHaveCount(0)` got `1` — the embed came back.
The spec posted the message, then opened the channel — so the message arrived once via
the channel's messages GET *and* again via the WS `message.new` echo, and `addMessage`
(state.js) **overwrites content** on the second delivery. When that echo landed after the
×'s edit (`message.update` → `<url>`), it reverted the row to the original bare-URL
content. Fix: `openChannel` now drains the messages GET (`waitForResponse`) on the empty
channel **before** posting, leaving the WS echo as the message's sole delivery — nothing
left to race the later edit.

**(c) Force-click occasionally didn't fire the handler.** The `×` is
`pointer-events: none` until `.msg:hover`, so `click({ force: true })` depended on the
mouse-move hover landing first — a `:hover`/pointer-events frame race. Fix: invoke the
handler directly with `dispatchEvent("click")`, exactly as `emoji-picker.spec.js` does
for the same reason. No hover dependency.

(The og:-card case shares (b) and (c); its embed is CSS-sized so it never hit (a).)
Verified green 20/20 in a tight loop after all three fixes.

## 3. `group-call.spec.js` — channel.new broadcast raced login — RESOLVED

Only surfaced under repeated *full-suite* runs (~1 in 8), never in isolation. Observed:
`selectChannel(…, "e2e-group-voice")` timed out in `beforeAll` — the channel row never
appeared in one of the three sidebars.

Root cause: `uiLogin` waited for `#me-name`, which renders during boot, but
`startRealtime()` runs **last** — so a just-logged-in page's WebSocket may not be
connected (registered on the server hub) yet. `beforeAll` then has admin POST a public
channel and relies on the `channel.new` **broadcast** to add the row in each sidebar. A
page still mid-connect misses the broadcast, and the app doesn't refetch the channel list
without a reconnect, so the row never appears.

Fix (shipped): `uiLogin` now also waits for `#conn-status` to carry the `online` class
(set by `onRealtimeConnChange(true)` on WS open) before returning — login means
realtime-ready, so the broadcast can't outrun the socket. (DM-based call specs —
`dm-call`, `listen-only`, `video-grid`, `screen-share` — don't share this: each page
create-or-finds and selects *its own* DM row in the test body, with the socket long
connected, so there's no login→broadcast gap.)

## 4. The `assertLiveVideo` helper flaked under full-suite CPU load — RESOLVED (all 5 call specs)

After fix #3, a rarer failure remained that only reproduced under *full-suite* runs (not
in isolation): a video-tile liveness check got `1`, expected `2`. It surfaced in
`group-call` ("two cameras → third sees both") and `dm-call` ("glare: simultaneous camera
adds"), but the cause is in the **helper, which is copied into all five call specs**
(`dm-call`, `group-call`, `listen-only`, `screen-share`, `video-grid`).

Two stacked causes, classified rather than papered over:

- **Slow convergence.** Bumping the ceiling to 45s and re-running isolated 12× went green
  every time — the streams always eventually flow; nothing is dropped. With several
  video-encoding Chromium contexts contending for CPU, a remote stream's frames can start
  past the old 20s ceiling.
- **The measurement artifact (the real fix).** The old helper counted tiles whose
  `currentTime` advanced within a single shared ~500ms window and needed `min` of them in
  the *same* window. Under that CPU contention the decoders **stutter alternately** — each
  genuinely flowing, but rarely both advancing in one 500ms slice — so the count never
  reached 2 even though both streams were live. A 45s ceiling alone still failed in the
  full suite for this reason.

Fix (shipped): rewrite `assertLiveVideo` to **accumulate liveness per video track id
across samples** — key each tile on its `srcObject` video track id, mark a track live the
first time it's seen to advance (in a widened ~1.2s window), and union those across poll
iterations until `min` distinct tracks are live (45s ceiling). A genuinely dead stream
never accumulates, so this removes the artifact without hiding a real drop. The five
copies are identical; the canonical one + this rationale live in `group-call.spec.js` —
keep them in sync (the helper is intentionally duplicated, matching the self-contained
spec convention). Heavy tests that call it 2–3× also get a raised per-test `setTimeout`
so the 45s ceilings can't blow the default 90s budget.

## 5. `dm-call` glare + `group-call` camera — TWO real call-UI bugs (one fixed, one open)

After #1–#4, two call tests still flaked under *full-suite* CPU contention (~1 in 3–8 full
runs; not reproducible in isolation): `dm-call`'s "glare: simultaneous first-time camera
adds" and `group-call`'s "two cameras → third sees both". Both fail the first poll — 1
`<video>` element where 2 are expected — because one peer shows an avatar where the other's
live video should be. Instrumenting the ordered call-event sequence revealed **two distinct
root causes** behind the one symptom (full diagnosis, the proven captures, the repro recipe,
and the remaining next steps live in [call-ui-video-staleness.md](call-ui-video-staleness.md)):

- **Bug #1 — glare signaling serialization — FIXED (v2.0.25).** Voice frames were
  dispatched fire-and-forget (`app.js` `handleRealtimeEvent` doesn't await
  `voiceUI.onVoiceEvent`), so `onOffer`/`onAnswer` ran concurrently and corrupted Perfect
  Negotiation — the impolite peer ignored the polite peer's one-shot re-offer mid-
  `setRemoteDescription`, permanently losing one video direction (`hasEl:false` — the
  remote element never existed). Fix: `voice.js` `handleVoiceSignal` now serialises every
  voice frame through a one-at-a-time FIFO. This was the **dominant, deterministic** cause.

- **Bug #2 — stale `video_muted` roster flag — STILL OPEN.** The rarer residual matches the
  original hand-off symptom: the receiver HAS the peer's live `<video>` (`hasEl:true`) but
  renders an avatar because `participants[peer].video_muted` is stuck `true` (a spurious
  camera off/on toggle plus a `voice.state` `false`→`true` regression where the stale value
  lands last). Not a test artifact; needs its own fix. Until then these two tests can still
  *rarely* flake under full-suite load — a known, documented gap, not new breakage.

## Suite-wide audit of the non-call specs — clean

Outside the call specs, a full sweep turned up no further genuine races. The candidates
that looked suspect (`search`, `notifications`, `emoji-picker`, `link-previews`,
`modals`) all use auto-retrying locator assertions, which already converge on async
state. The one `waitForTimeout(300)` in `composer-paste.spec.js` is a deliberate
*negative* assertion ("prove no smuggled fetch fired") — you can't poll for the absence
of an event, so a bounded wait is correct there, not a flakiness source.

## General lessons (the antipatterns that actually flake here)

- **Non-retrying snapshots** — `expect(await fn())` on a JS value, or a
  `getBoundingClientRect()` read. Use `expect.poll`. (Locator assertions auto-retry; leave
  them alone.)
- **Double delivery + content overwrite** — a posted message reaches this client via both
  a REST GET and the WS echo, and `addMessage` overwrites content on the later one. If a
  test posts then edits within the same tick, the late delivery can revert the edit. Open
  the channel (drain its GET) before posting so the WS echo is the only delivery.
- **Force-clicking a hover-revealed control** — anything `pointer-events: none` until
  `:hover` (the `×`, the message action buttons) is unreliable under `click({force:true})`.
  Use `dispatchEvent("click")` to run the handler directly.
- **Geometry vs. media layout** — never measure a box that hosts an `<img>` before the
  image is `complete && naturalWidth > 0`; poll the measurement and re-read.
- **Broadcast races login** — `#me-name` rendering is NOT realtime-ready; `startRealtime()`
  runs last. Before relying on a `*.new` broadcast right after login, wait for
  `#conn-status` to be `online`.
- **Mesh media needs headroom, not retries** — a WebRTC frame-flow assertion that fails
  only under full-suite CPU contention is usually slow, not broken. Confirm by raising the
  ceiling and re-running; if the stream always eventually arrives, the higher ceiling on
  the (still observable-keyed) poll is the right fix, not a retry.

## When a new race appears

Re-run the full suite several times to build confidence:

```sh
for i in 1 2 3 4 5; do make test-e2e || break; done
```

If you find a new flaky spec, append it here with the same anatomy: observed failure →
root cause → the observable condition the wait should key on. Specs are test-/tooling
only, so changes here don't bump `Version` or deploy.
