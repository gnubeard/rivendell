# Call-UI video staleness — investigation log

**Two distinct bugs hide behind the same e2e symptom.** Bug #1 (glare signaling
serialization) is **FIXED** (v2.0.25). Bug #2 (a stale `video_muted` roster flag) is
**still OPEN** — it's the rarer residual and the one the original hand-off described. Read
the whole thing before touching realtime code; the two have opposite root layers.

## Symptom (shared by both bugs)

Two e2e tests flake **only under full-suite CPU contention** (this box has 2 cores; the
serial Playwright suite starves the video-encoding Chromium contexts). Not reproducible in
isolation.

- `web/e2e/dm-call.spec.js` → "glare: simultaneous first-time camera adds…"
- `web/e2e/group-call.spec.js` → "two cameras on → the third sees both remote tiles"

Both fail the **first** `assertLiveVideo` poll: `#video-grid video` count is 1, expected 2.
One peer shows an avatar tile where the other's live video should be.

## How the two bugs are told apart (the decisive capture)

Instrument the DM-grid render to log, at the branch decision, **both** `hasEl`
(`!!getVideoEl(peerId)` — does the remote `<video>` element exist?) and `pVm`
(`participants[peer].video_muted` — the roster flag). The failing render then reads as one
of two signatures:

- **Bug #1 — `hasEl:false`** → the remote video element was never created (no `ontrack`):
  a **media/negotiation** failure. The peer's video never arrived.
- **Bug #2 — `hasEl:true, pVm:true`** → the element EXISTS and is live, but the roster
  flag says muted, so the render picks the avatar branch: a **stale-flag** failure.

The original hand-off saw only the bug-#2 signature and theorised "stale flag." Adding the
serialised instrumentation (below) surfaced bug #1 as the *dominant* cause first.

---

## Bug #1 — glare signaling serialization — FIXED (v2.0.25)

**Root cause.** Voice signaling was dispatched **fire-and-forget**: `app.js`'s
`handleRealtimeEvent` is not async and calls `voiceUI.onVoiceEvent(evt)` without awaiting
it (`if (evt.type.startsWith("voice.")) voiceUI.onVoiceEvent(evt);`). Those handlers
(`onOffer`/`onAnswer`) are async and `await pc.setRemoteDescription(...)`. So two voice
frames arriving back-to-back run their async bodies **concurrently**, violating Perfect
Negotiation's hard requirement that signaling be processed strictly serially per
connection.

**The failure, proven by capture.** In a simultaneous-camera glare (both peers `addTrack`
at once), the polite peer (higher id) rolls back its own offer, accepts the impolite
peer's, answers it, and then one-shot **re-offers** its own video (`renegotiatePending` →
`maybeRenegotiate`). The impolite peer (lower id) receives, back-to-back: the **answer** to
its own offer, then that **re-offer**. Under CPU load `setRemoteDescription(answer)` is
slow; because the dispatch didn't await, the re-offer's `onOffer` ran **during** that await
— so the impolite peer was still in `have-local-offer`, declared a collision, and (being
impolite) **ignored** the re-offer. The one-shot `renegotiatePending` was already spent, so
the polite peer never re-offered again. That video direction was lost for the whole call.

The ring-buffer trace showed the smoking gun unambiguously — the `voice.offer` handler's
`sig-begin … glare-ignore … sig-end` nested *inside* the `voice.answer` handler's
`answer-recv-begin … answer-recv-done`:

```
sig-begin   voice.answer from:2
answer-recv-begin  sig:have-local-offer          ← await setRemoteDescription(answer) starts
  sig-begin voice.offer from:2                    ← re-offer dispatched CONCURRENTLY
  offer-recv polite:false collision:true sig:have-local-offer
  glare-ignore                                    ← impolite peer drops the re-offer
  sig-end   voice.offer from:2
answer-recv-done   sig:stable                      ← answer only NOW applied
sig-end     voice.answer from:2
```

**The fix** (`voice.js`, `handleVoiceSignal`): serialise every voice frame through a
one-at-a-time FIFO so each handler fully settles before the next begins.

```js
let signalChain = Promise.resolve();
export function handleVoiceSignal(evt) {
  signalChain = signalChain.then(() => dispatchVoiceSignal(evt)).catch(() => {});
  return signalChain;
}
async function dispatchVoiceSignal(evt) { /* the switch over voice.state/offer/answer/ice */ }
```

After the fix the handlers no longer nest and the deterministic loss is gone (the
`glare-ignore` that remains is now harmless — the answer is fully applied before the next
offer is processed). It is keyed at the signaling layer, NOT the flag/render layer the
original hand-off suspected.

## Bug #2 — stale `video_muted` roster flag — STILL OPEN

After bug #1, residual failures (~3/40 under the pathological 4-hog load below) show the
bug-#2 signature: the receiver HAS the peer's live `<video>` (`hasEl:true`) but renders an
avatar because `participants[peer].video_muted` is stuck `true`.

**What the capture proved:**
1. The peer's camera **spuriously toggles off then back on** mid-call — a `voice.mute`
   with `video_muted:true` is emitted (no offer/answer around it; pure `sendMuteState`
   with `cameraEnabled===false`), then `video_muted:false` ~400 ms later. The e2e test
   never asked for a second toggle. **What flips `cameraEnabled` to false is not yet
   identified** (it is NOT the DM path — `voice.join_denied{video_full}` is group-only and
   DM-exempt server-side; the camera button isn't re-clicked).
2. The receiver then sees a **5 ms double-broadcast** of `voice.state`: `[peer vm:false]`
   immediately followed by `[peer vm:true]`, and the stale `true` lands last — even though
   that peer's *last* `sendMuteState` was `video_muted:false`. So the server's final
   broadcast disagrees with the peer's last announced state. Since `VoiceJoin` is
   idempotent and `VoiceSetMute` only mutates the live entry (`hub.go`), this points at
   either a server-roster ordering issue or a brief **WS double-socket** delivering frames
   out of order under load.

**Next captures to take** (re-add instrumentation, then run the repro below):
- Log `setCameraEnabled` entry with `on` + a caller hint (and `joinVoiceChannel`) to find
  what drives the spurious camera-off.
- Log the WS socket identity (so a transient double-socket shows up) alongside every
  received `voice.state`, to see whether the `false`→`true` regression is out-of-order
  delivery vs a genuine server broadcast.

**Why you can't just trust the live track instead of the flag:** camera-OFF in this app
keeps the track and only sets `track.enabled=false` (`voice.js`), sending black frames — so
the receiver still sees a live track with `videoWidth>0`. Media alone cannot distinguish
camera-off from camera-on; the `video_muted` flag is genuinely necessary. The fix must make
the flag (or its delivery) correct, not discard it.

---

## Instrumentation that cracked it (re-add temporarily; tag every line `// __CALLDBG__`)

A per-page ring buffer recording the **ordered** call-event sequence, dumped for all
involved pages on the first `assertLiveVideo` failure. The shared global lets
`videogrid.js` + `ws.js` push to the same buffer.

```js
// voice.js, near the top:
function callDbg(ev, d) {
  if (typeof window === "undefined") return;
  const buf = window.__callDbg || (window.__callDbg = []);
  buf.push(Object.assign({ t: Date.now(), me: myUserId, ev }, d));
  if (buf.length > 800) buf.shift();
}
if (typeof window !== "undefined") window.__callDbgPush = callDbg; // ws.js/videogrid.js reuse
```

Log points that mattered: `onVoiceState` (per-peer `video_muted`); `ontrack` video
(`created`); the DM-grid + group-tile branch decision (`hasEl`, `pVm`, branch);
`sendMuteState` (`vm`); `sendOffer`/`onOffer`/`onAnswer` with `signalingState` +
collision/ignore; and `sig-begin`/`sig-end` around each handler in `dispatchVoiceSignal`
(the begin/end pair is what makes concurrent interleaving visible). In ws.js: `ws-open` /
`ws-close`. The spec helper dumps `window.__callDbg` (JSON per line) for the page under
assert and its peers.

## Repro recipe (don't run the spec in isolation — it passes)

The bug needs CPU starvation. Oversubscribe the 2 cores and loop one spec:

```sh
cd web
export E2E_DATABASE_URL=... E2E_DB_RESET_CMD=... E2E_WEBKIT='' E2E_FIREFOX=''
hogs=(); for c in 1 2 3 4; do yes >/dev/null & hogs+=($!); done   # 4 CPU hogs on 2 cores
for i in $(seq 1 40); do npx playwright test dm-call.spec.js --project=chromium --reporter=line || break; done
kill "${hogs[@]}"
```

Reproduced bug #1 at iter 6 and 11; after the fix, bug #2 at iters 5/16/38/40. (Note: 4
hogs on 2 cores is *harsher* than a real full-suite run, so some residual churn here may be
load artifact — but the bug-#2 stale-flag symptom does occur under realistic full-suite
load too.)

## Disproven / superseded

- **DISPROVEN (original hand-off): "slow-consumer WS drop ends the call."** A drop only ends
  a DM call if `onPresenceChange(online=false)` fires, and that fires only on the user's
  *last* connection closing (`hub.go`). A drop + fast reconnect leaves the call alive.
- **SUPERSEDED: "stale flag vs missed render" as the framing.** Render is never coalesced
  for voice (`onVoiceStateChange` → `renderVideoGrid` synchronously; `ontrack` →
  `notifyState` → render synchronously), so a *missed render* was never the issue. Bug #1
  was a negotiation-layer loss; bug #2 is a genuine stale flag (delivery/source), not a
  missed paint.
