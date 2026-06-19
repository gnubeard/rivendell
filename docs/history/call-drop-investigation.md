# Call-drop investigation (June 2026)

Symptom: voice and video calls reliably drop after ~1–2 minutes.  
Status: **RESOLVED — fixed in v1.3.108 (2026-06-09).**

---

## Resolution

Both bugs were fixed in v1.3.108:

- **Bug 1 (WS read deadline):** implemented Option D from the fix directions below —
  `startCallHeartbeat`/`stopCallHeartbeat` in `voice.js` sends `{type:"heartbeat"}` over
  the WS every 45 seconds while a call is active. The server ignores the frame type but
  its arrival resets the `readPump` deadline. No changes to the custom WS layer.

- **Bug 2 (stale peers on reconnect):** `resync()` in `app.js` now calls
  `reconcilePeers(liveIds)` after the self-presence check, closing any
  `RTCPeerConnection` whose remote user_id is no longer in the voice channel roster.
  `reconcilePeers` was factored out of the existing `onVoiceState` peer-cleanup path.

Bug 3 (ICE restart dead-call window) was rendered moot by Bug 2 as expected: once
`resync()` closes the stale peer immediately, the answerer no longer waits for ICE
failure.

Confirmed working via a >90-second call with no chat activity — no WS drops, no
dead-call window.

---

## Follow-up: network-switch call drop (June 2026)

Symptom: switching network connections mid-call (e.g. wifi↔cellular on a phone) —
the call **recovers** after a few seconds, then drops ~10–60 s later.
Status: **RESOLVED — DM-call reconnection grace period.**

Traced from a production capture (a DM call, `ch=4`): at the switch both peers go
`ice/conn=disconnected`; +5 s the offerer's ICE restart heals the **media** (frames
flow again, `sig=stable`); +17 s `endDMVoiceCall … leaverStillConnected=false` tears
the call down for both. No `ws: read-deadline timeout` fired — so this is **not** the
v1.3.108 heartbeat bug.

Root cause: the DM call's lifetime was bound to the WebSocket. WebRTC media migrates
across a network change (ICE restart), but the WS is a plain TCP connection that
cannot migrate; the stranded socket dies, and on the server a dead WS is
indistinguishable from "user left" (`onPresenceChange(false)` →
`cleanupVoiceForUser` → `endDMVoiceCall`, immediately and irreversibly). The "~a
minute" is the lag before the server notices the dead WS (30 s ping cadence; the
client only reconnects passively via `onclose`/`online`), which is why media heals
first and the call dies after.

Fix (two parts):

- **Server grace period (`voiceReconnectGrace`, 20 s).** A WS drop during an active
  DM call no longer ends it on the spot — `cleanupVoiceForUser` leaves the user in
  the roster and arms `scheduleDMTeardown`. If they reconnect and re-announce
  (`voice.join` → `cancelDMTeardown`) within the window, the call continues; only on
  expiry does `endDMVoiceCall` run. Group channels still drop a participant
  immediately. New read-only hub methods `VoiceChannelsForUser` / `VoiceHasUser`.

- **Client re-announce on reconnect.** `resync()` in `app.js`, when still in the call
  per the roster check, re-sends `voice.join` over the fresh socket to cancel the
  server's pending teardown. Gated behind the roster check so an already-expired
  window isn't resurrected into a solo call.

Guarded by `TestDMCallEndsForBothParties` (hold-through-grace, cancel-on-reconnect,
teardown-on-expiry).

---

## TL;DR (original analysis)

There are two layered bugs. Together they guarantee that a call lasting ~90 seconds
will end abruptly:

1. **The WebSocket read deadline is not reset by ping/pong keepalives.** A client
   whose only WS activity is responding to server pings (no typing, no mute toggles)
   is disconnected after 90 seconds.

2. **When a client's WS drops mid-call, peer connections aren't cleaned up on
   reconnect.** The reconnect resync only checks "am I still listed as a
   participant?" — it doesn't compare the peer list against the live roster.

---

## Evidence from telemetry

The raw telemetry log of a call that dropped at ~91 seconds has been removed now
that the investigation is closed; the key extracted timeline is preserved below
(UTC, ch=4, self=3=desktop-FF,
self=1=Android-FF):

```
04:51:59.764  call joins (both sides), ICE connected within ~100ms
04:51:59.879  conn=connected on both sides
04:52:04–04:53:24  steady call: zero packet loss, rtt=4–65ms, host/host+host/prflx
04:53:30.742  user 1  kind=leave  (vel.ct=89.4 — 89.4s into the call)
04:53:34–04:53:38  user 3 telemetry: in.v.fps=0, in.v.bytes frozen — peer gone
04:53:39.080  user 3  connectionstatechange conn=disconnected
04:53:39.081  user 3  iceconnectionstatechange ice=disconnected
04:53:58.516  user 3  iceconnectionstatechange ice=failed
04:53:58.521  user 3  connectionstatechange conn=failed
04:53:58.952  user 3  kind=leave  (ICE gave up or manual hang-up)
```

Duration from call start to user 1 leaving: **89.4 seconds** (vel.ct on their last snap).
Duration of the dead-call window (user 1 gone, user 3 stuck): **28 seconds**.

---

## Bug 1: WS read-deadline not reset by pong frames

### Code

`internal/ws/hub.go` `readPump`:
```go
for {
    c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))  // set once
    _, data, err := c.conn.ReadMessage()                      // blocks
    ...
}
```

`internal/ws/websocket.go` `ReadMessage`:
```go
case opPong:
    continue  // ← handles pong silently; deadline is NOT reset here
```

### What happens

`SetReadDeadline` is called once, before `ReadMessage()`. That call sets an
**absolute** deadline 90 seconds in the future on the underlying `net.Conn`.
`ReadMessage` then loops, reading frames. When it gets a pong it calls `continue`
— back to the inner frame loop, still under the original deadline.

**Pong responses do not reset the 90-second deadline.** The deadline only resets
when `ReadMessage` returns, which only happens when a full text/binary message
arrives.

### Why it fires during calls

During a voice or video call:
- ICE candidates are exchanged at call start and then stop.
- Voice media is direct P2P — it never touches the WS.
- `voice.mute` only fires on user action.
- Without typing, reactions, or other chat activity, the client sends **zero text
  frames** after the initial `voice.join` + `voice.mute`.

Result: ~90 seconds after `voice.join`, the server closes the WS connection as if
the client is unresponsive, even though ping/pong is working fine. The close
triggers `cleanupVoiceForUser` on the server.

### The 89.4-second fingerprint

User 1's last telemetry snap shows `vel.ct=89.4` (call time in seconds) at the
moment they left. That is almost exactly the 90-second deadline. Whether user 1
left manually or their WS was killed, the timing is a red flag. For the bug to
manifest repeatedly at "1–2 minutes" this is the most likely driver.

### Fix direction

In `ReadMessage()` (websocket.go), reset the deadline when a pong is received.
The `Conn` struct needs to know the deadline duration (currently only the hub
knows it), or `ReadMessage` needs a refresh callback. The simplest approach:

**Option A**: Add a `pongDeadline time.Duration` field to `Conn` set by
a new `SetPingDeadline(d)` method; `ReadMessage` calls `SetReadDeadline` on
pong receipt.

**Option B**: Change `ReadMessage` to accept an optional `onPong func()` callback
that `readPump` uses to refresh the deadline.

**Option C** (quick & dirty, zero API change): Move the deadline set *inside* the
inner `ReadMessage` loop by refactoring it to expose a per-frame hook. Too invasive.

**Option D** (client-side): Send a client-to-server heartbeat (e.g.
`{type:"heartbeat"}`) from `voice.js` on a 30-second interval while a call is
active. The server ignores it; `readPump` naturally resets its deadline on the
incoming text frame. Requires no changes to the WS layer. Downside: extra round-
trip traffic and a new client-side interval to manage.

---

## Bug 2: WS reconnect doesn't sync peer connections against live roster

### Code

`web/static/app.js` `resync()` (the WS-reconnect handler):
```js
if (isInCall()) {
  const pts = await api.voiceParticipants(voiceChannelId());
  if (!pts.some((p) => p.user_id === state.me.id)) endCallLocally();
}
```

### What it misses

This check answers "**am I still in the channel?**" If the user is still listed
(e.g. they're the only remaining participant in a regular voice channel), the
check passes and nothing happens — even if a peer they had an open `RTCPeerConnection`
to has since left.

In the telemetry session, after user 1 left:
- The server broadcast `voice.state` with participants = [user3].
- User 3's WS was apparently down (or transitioning) at that moment — they missed it.
- User 3 reconnected to WS; `resync()` checked: "is user 3 still in ch4?" → yes.
  Check passed. Dead peer connection to user 1 left open.
- Proof: `connectionstatechange conn=disconnected` and `connectionstatechange
  conn=failed` were logged **9–28 seconds after user 1 left** — the `onconnectionstatechange`
  handler fires only when the callback is still attached. `closePeer()` sets it to
  null; `closePeer` was never called.

### Fix direction

After WS reconnect, while in a call, also reconcile peer connections:

```js
// in resync(), after the self-check:
if (isInCall()) {
  const pts = await api.voiceParticipants(voiceChannelId());
  if (!pts.some(p => p.user_id === state.me.id)) {
    endCallLocally();
    return;
  }
  // NEW: close any peer whose user_id is no longer in the roster
  reconcilePeers(pts.map(p => p.user_id));
}
```

`reconcilePeers` would be a new export from `voice.js` that closes peers not in
the provided set (same logic already in `onVoiceState`'s "close connections for
participants who left" block — factor it out or call `handleVoiceSignal` with a
synthetic `voice.state` event instead).

---

## Bug 3 (contributing): ICE reconnect logic can't recover from peer-gone scenarios

The ICE restart machinery (voice.js) is designed for transient network hiccups.
It cannot recover from "the peer voluntarily left the voice channel":

- Offerer (lower user_id): arms a 2s grace timer on `disconnected`, then restarts.
  Restart offers are sent over WS. If the peer's server-side voice state is already
  gone, the server's `voice.offer` relay path rejects the relay
  (`canAccess(ch, toUserID)` fails or the user is just gone). The restart silently
  does nothing. After `MAX_ICE_RESTARTS=4` attempts (4 × 4s = 16s after the grace),
  the offerer re-sends `voice.join` — which at least forces a fresh `voice.state`
  from the server.

- Answerer (higher user_id): on `failed`, arms a 20-second drop timer. This is the
  main driver of the 28-second dead-call window in the telemetry (disconnected at
  04:53:39, failed at 04:53:58, gave up ~04:53:59 before the 20s timer fired
  — likely manual hang-up).

This is not a bug per se — the reconnect design is correct for transient drops. But
it means the dead-call window after a peer leaves can be up to ~30 seconds for the
answerer.

The fix (after Bug 2 is fixed) is mostly moot: if `resync()` properly syncs peer
connections on reconnect, the dead-call window collapses to zero. The ICE restart
logic just needs to not interfere.

---

## Other observations from the telemetry session

- **Transport path**: `pair=host/host` on desktop side (direct, no NAT),
  `pair=host/prflx` on Android side (one NAT hop). TURN was not used. The ICE path
  was fine throughout — the disconnect was social (peer left), not network.

- **out.v.bytes frozen** during the dead-call window: encoder kept running
  (`out.v.framesEnc` +24 every 5s) but `out.v.bytes` was stuck at 10031088.
  This is normal — the ICE transport was closed from user 1's side, so packets had
  nowhere to go.

- **`in.v.lost=3` appeared at ~65s** and didn't grow afterwards. Three dropped video
  packets in an 89-second call is negligible and likely normal network variance, not
  a sign of impending trouble.

- **Android client** (`ua="Mozilla/5.0 (Android 16; Mobile; rv:153.0)"`) sent
  `out.v.encT` growing to 93.3s by the last snap — the FF-Android encoder was still
  running fine (not the FF-stable freeze bug; this was FF 153 which may be Nightly or
  a later stable). Desktop sent `out.v.encT=4.x` (fast H/W encoder).

---

## Recommended next steps

### Step 1 — Instrument the WS drop

Before fixing anything: add a `log.Printf` when the read deadline fires so we can
confirm frequency. In `readPump`:

```go
_, data, err := c.conn.ReadMessage()
if err != nil {
    if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
        log.Printf("ws: read-deadline timeout user=%d", c.userID)
    }
    return
}
```

If logs show `read-deadline timeout` entries at ~90s on call-active users, that
confirms Bug 1 is firing in production.

### Step 2 — Fix Bug 1 (pong doesn't reset deadline)

Implement Option A or Option D above. Option D (client heartbeat) is the safest
change: no modification to the custom WS layer, easy to test, easy to revert. Add
a `startCallHeartbeat`/`stopCallHeartbeat` pair in `voice.js` that sends a WS
`{type:"heartbeat"}` every 45 seconds while `activeChannelId !== null`. Server
ignores the type (falls through the `onWSMessage` switch without action).

### Step 3 — Fix Bug 2 (resync doesn't reconcile peers)

After WS reconnect, reconcile open peer connections against the live voice roster.
This is a small addition to the resync path in `app.js`.

### Step 4 — Verify with telemetry

Enable `RIVENDELL_DEBUG_TELEMETRY=true` and make a call that lasts > 90 seconds
with no chat activity. With the fix in place: no WS drops, no dead-call window.
Without: the `read-deadline timeout` log (from Step 1) fires and the call drops.

---

## Scope of impact

Both bugs are purely in the signaling/control plane. The WebRTC media path (audio,
video) is unaffected; if the call stays up it works fine. The bugs cause the *call*
to end earlier than intended, not audio/video quality issues within a working call.

The FF-Android outbound-video freeze (separate, documented in
[../design/video.md](../design/video.md)) is unrelated to the drops described here.
