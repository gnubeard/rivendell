# Call-UI video staleness — investigation log

**Two distinct bugs hid behind the same e2e symptom; BOTH are now FIXED.** Bug #1 (glare
signaling serialization, v2.0.25) and bug #2 (a stale/reordered `video_muted` roster flag,
v2.0.26). Kept as a worked example: the symptom was identical, the two root causes were at
opposite layers (client signaling vs server broadcast ordering), and only an ordered
per-page event trace under CPU oversubscription told them apart. Under the 4-hogs-on-2-cores
repro the `dm-call` glare test went 0/40 after both fixes (was deterministic for #1, ~3/40
for #2).

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

## Bug #2 — stale/reordered `video_muted` roster flag — FIXED (v2.0.26)

After bug #1, residual failures (~3/40 under the pathological 4-hog load below) showed the
bug-#2 signature: the receiver HAS the peer's live `<video>` (`hasEl:true`) but renders an
avatar because `participants[peer].video_muted` is stuck `true`.

**Root cause — a server-side voice.state delivery REORDER.** The capture's contradiction was
the tell: the peer's *last* `sendMuteState` was `video_muted:false`, yet the receiver's
*last* `voice.state` for that peer was `true`. On a single in-order socket (verified: one
`ws-open`, no `ws-close`) that's impossible unless the server delivers out of order. It does:
each client connection has its **own `readPump` goroutine** (`hub.go`), so two clients'
frames are processed concurrently; and a `voice.state` snapshot is taken under `voiceMu`
(inside `VoiceSetMute`) but **broadcast after the lock is released**. So a broadcast carrying
a logically-OLDER roster (triggered by client A's frame, snapshotting peer B as still
`video_muted:true`) can be written to a third party's send queue AFTER a newer broadcast
(peer B `false`). The receiver adopts the full roster wholesale, so the stale `true` lands
last → avatar over live video.

The "spurious camera off/on toggle" seen in the trace (a peer emitting `video_muted:true`
then `false` with no offer/answer around it) is just the **churn that produces the stale
snapshot to race** — under extreme CPU starvation; it is harmless on its own (the final
state is camera-on). It was NOT separately chased because the reorder fix makes the receiver
robust to it regardless.

**The fix.** The hub stamps every `voice.state` with a per-channel monotonic `seq` assigned
under `voiceMu` at mutation time (`Hub.voiceSeq`; all mutators return it, all broadcasts go
through `Server.broadcastVoiceState`). The client (`voice.js` `onVoiceState`) tracks
`lastVoiceSeq` for the active call and **drops any `voice.state` whose seq isn't newer** —
so a reordered/stale snapshot can't overwrite a newer one. `lastVoiceSeq` resets to 0 on
join (the server seq is globally monotonic, so the first post-join state always applies);
a missing seq applies, for forward-compat. Guarded by `TestVoiceSeqMonotonic` (hub) and the
0/40 e2e validation.

**Why not just trust the live track instead of the flag:** camera-OFF keeps the track and
only sets `track.enabled=false` (`voice.js`), sending black frames — so the receiver still
sees a live track with `videoWidth>0`. Media alone cannot distinguish camera-off from
camera-on; the `video_muted` flag is necessary. The fix makes its *delivery* correct rather
than discarding it.

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

Reproduced bug #1 at iters 6 and 11; after the #1 fix, bug #2 at iters 5/16/38/40; after the
#2 fix, **0/40**. (Note: 4 hogs on 2 cores is *harsher* than a real full-suite run, so it's
a deliberately mean stress test — clean here is a strong signal.)

## Disproven / superseded

- **DISPROVEN (original hand-off): "slow-consumer WS drop ends the call."** A drop only ends
  a DM call if `onPresenceChange(online=false)` fires, and that fires only on the user's
  *last* connection closing (`hub.go`). A drop + fast reconnect leaves the call alive.
- **SUPERSEDED: "stale flag vs missed render" as the framing.** Render is never coalesced
  for voice (`onVoiceStateChange` → `renderVideoGrid` synchronously; `ontrack` →
  `notifyState` → render synchronously), so a *missed render* was never the issue. Bug #1
  was a negotiation-layer loss; bug #2 is a genuine stale flag (delivery/source), not a
  missed paint.
