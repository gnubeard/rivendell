# Call-UI video staleness — investigation hand-off

**Status: OPEN, real bug, not yet fixed.** Diagnosed far enough to be confident it's a
genuine (rare) call-UI bug, then deferred so it can be fixed with fresh context rather
than rushed in fragile realtime code. Start here.

## Symptom

Two e2e tests flake **only under full-suite CPU contention** (this box has **2 cores**;
the whole Playwright suite running serially starves the browsers). Not reproducible by
running the spec in isolation. Rate ~1 in 3–8 full-suite runs.

- `web/e2e/dm-call.spec.js` → "glare: simultaneous first-time camera adds converge under
  Perfect Negotiation"
- `web/e2e/group-call.spec.js` → "two cameras on → the third sees both remote tiles"

Both fail the **first** `assertLiveVideo` poll: `#video-grid video` count is 1, expected
2. One peer never shows the other's remote video tile (for the full 45s timeout — not
slow, genuinely absent from the DOM).

## What is PROVEN (instrumented repro, hard data)

The media is fine; only the **UI** is wrong. From a captured failure (page1 = the peer
missing the tile):

```
page1: conn=connected, ice=connected,
  transceiver mid1 video currentDirection=sendrecv   ← negotiated to send AND receive
  vids=1                                              ← only 1 <video> in #video-grid
  videoEls=[2]                                        ← the remote element FOR peer 2 EXISTS
  videoElsState: {uid:2, inDom:FALSE, hasSrc:true, vw:640, paused:false}
                                                      ← it's LIVE (640px, playing) but NOT in the DOM
  localVideo: {inDom:true, vw:640}                   ← own preview is fine
  gridTiles=1                                         ← the remote tile rendered is an AVATAR (.video-tile), not the video
```

So: the remote video track is negotiated and flowing, `ontrack` created the `<video>`
element (it's in the `videoEls` map, live, 640px) — but `renderDMVideoGrid` chose the
**avatar** branch and never put that live element in `#video-grid`.

## The gate that fails

`web/static/videogrid.js`, `renderDMVideoGrid` (~line 151):

```js
const remoteVideoMuted = !otherP || otherP.video_muted;  // line ~130
...
if (remoteVideo && !remoteVideoMuted) { remoteTile.appendChild(remoteVideo); }
else { remoteTile.appendChild(videoAvatarTile(...)); }   // ← this branch ran despite live media
```

`buildParticipantTile` (group path, ~line 188) has the equivalent gate on `p.video_muted`.

So the tile is gated on the **`video_muted` roster flag**, not on whether media is
actually flowing. The flag came out stale/wrong on the failing peer, OR a re-render after
`ontrack` was missed. **This is the open question — see "Next step".**

## Why the flag (and not the media) is load-bearing

You can't just "trust the live track instead of the flag": camera-OFF in this app **keeps
the track** and only sets `track.enabled=false` (see `voice.js` ~line 537), which sends
black frames — the receiver still sees a live track with `videoWidth>0`. So media alone
cannot distinguish camera-off from camera-on; the `video_muted` signaling flag is
genuinely necessary. The fix must make the flag (or the render) correct, not discard it.

## Hypotheses — one DISPROVEN, one OPEN

- **DISPROVEN: slow-consumer WS drop.** The hub drops+closes a client whose 64-deep send
  buffer overflows (`internal/ws/hub.go` ~line 150, "dropping slow client"). I suspected a
  dropped `voice.state` left the flag stale. But a full WS close on the last connection
  fires `onPresenceChange(online=false)` → `cleanupVoiceForUser` (`realtime.go:96`), which
  for a DM **ends the call for both**. In the failures the call is still alive (call-strip
  present, media flowing), so the WS did **not** drop. (Also confirmed `hub.remove()` does
  NOT prune voice state on disconnect — only the presence-offline path does.)
- **OPEN: stale flag vs missed re-render.** Two candidates remain, NOT yet distinguished
  because the dump captured `peerMeta` but **not** `voiceCallState.participants[].video_muted`:
  1. **Stale flag:** page1's `participants` entry for peer 2 has `video_muted:true` at
     render time (a `voice.state`/`voice.mute` ordering or lost-update issue). `onVoiceState`
     (`voice.js:1570`) *replaces* the whole roster from each `voice.state` payload.
  2. **Missed re-render:** the flag is correct (`false`) but the grid render that would
     show the now-created `videoEls[2]` never ran after `ontrack`. `ontrack` (`voice.js`
     ~line 1864) calls `notifyState()` → app.js re-renders; if that render was coalesced/
     skipped, the element stays out of the DOM.

## Next step (the one capture that decides it)

Re-instrument and reproduce, capturing **both**: the live `participants[].video_muted`
flag for the missing peer, AND whether a grid render happened after `ontrack` created the
element. Then:
- if flag is `true` → it's the signaling staleness → fix flag delivery/reconciliation;
- if flag is `false` → it's a missed render → fix the render trigger (re-render on
  `ontrack`, or have the render not depend on element-exists-at-that-instant).

### Instrumentation I used (re-add temporarily; remove before commit)

In `web/static/voice.js`, right after the `peerConns`/`peerMeta` declarations:
```js
if (typeof window !== "undefined") window.__voiceDbg = {
  peerConns: () => peerConns, peerMeta: () => peerMeta, myId: () => myUserId,
  videoEls: () => videoEls, localVideoEl: () => localVideoEl,
  participants: () => participants,            // ADD THIS — capture video_muted
};
```
Then in the failing spec, on assert failure, `page.evaluate` to dump
`window.__voiceDbg.participants()` (the `video_muted` per user) alongside the
`videoEls`/grid state already shown above.

### Repro recipe (don't waste time running specs in isolation — they pass)

The bug needs CPU starvation. Either run the full suite 10× (slow), or oversubscribe the
2 cores and loop the one spec:
```sh
cd web
export E2E_DATABASE_URL=... E2E_DB_RESET_CMD=... E2E_WEBKIT='' E2E_FIREFOX=''
for c in 1 2 3 4; do yes > /dev/null & done      # 4 CPU hogs on 2 cores
for i in $(seq 1 24); do npx playwright test dm-call.spec.js --reporter=line; done
kill %1 %2 %3 %4
```
This reproduced it ~2/24. (1 hog was too weak; 4 reliably starves the browsers.)

## Likely fix shapes (to evaluate once the capture decides)

- If stale flag: re-sync the voice roster on signaling reconnect (mirror app.js `resync()`,
  which currently re-pulls users/channels/messages but **omits voice** — there's no REST
  voice-roster endpoint, so trigger a server rebroadcast, e.g. re-send `voice.mute` with
  current posture; note the server does NOT prune voice on disconnect so this is safe),
  and/or reconcile in the render.
- If missed render: ensure `ontrack` reliably triggers a grid render for the new element
  (and that the render isn't coalesced away).

## A note on the earlier glare attempt (reverted)

While chasing this I added a `sendOffer` `finally` → `maybeRenegotiate` flush in
`voice.js` (a real-looking glare re-offer race) and bumped to v2.0.25. The instrumented
dump later showed the transceiver was already `sendrecv` (negotiation was fine), so that
change was treating the wrong layer; it was **reverted**. Don't reach for the glare path
first — the evidence points at the UI/flag layer, not negotiation.
