# Voice calling design — v1.1.0

Target: serviceable voice for ~20 friends. No media server, no ML, no new Go
dependencies. P2P via WebRTC, signaled over the existing WS hub.

---

## The "good enough" tier

The old Ventrilo/Skype tricks that still work perfectly at small scale, all
available for free:

| Technique | Where it comes from |
|---|---|
| Opus codec — DTX (silence suppression), PLC (packet loss concealment), built-in FEC | WebRTC mandates Opus; browser handles it |
| Echo acoustic cancellation (AEC) | `echoCancellation: true` on `getUserMedia` |
| Noise suppression | `noiseSuppression: true` on `getUserMedia` |
| Auto gain control — normalizes quiet/loud speakers | `autoGainControl: true` on `getUserMedia` |
| Jitter buffering — absorbs network timing jitter | Browser's WebRTC stack, automatic |
| Voice activity detection — gates transmission on speech | Opus DTX + browser VAD |
| Comfort noise — makes silence sound like a live line, not a dead one | Browser inserts it when DTX suppresses |
| Push-to-talk | Client-side: hold a key, unmute mic; release, re-mute |

Every one of those is free. No library, no server computation, no configuration
beyond the `getUserMedia` constraints. This is what Ventrilo 2003 did with manual
C implementations; we get it for nothing from the browser.

**What Discord/Teams/Zoom do that we don't need:**

- Krisp / RNNoise ML denoising (a separate cloud model — browser's built-in is
  90% of the benefit for home use)
- Acoustic echo cancellation tuned for conference rooms and specific hardware
- Adaptive bitrate playout calibrated for enterprise WAN shapes
- Selective Forwarding Units / server-side mixing for thousands of concurrent
  streams
- Neteq (Google's proprietary jitter algorithm)

We skip all of that. At ~20 users we will never hit the scale problems those
solve.

**What we do add (client-side, cheap):**

- Visual speaking indicators via `AnalyserNode` RMS metering — no audio
  processing, just metering
- Push-to-talk toggle
- Per-participant volume slider (Web Audio `GainNode` on the remote stream)
- Input level threshold gate (client cuts its own transmission below a
  configurable noise floor — coarser than browser VAD but tuneable)

---

## Architecture

### Transport

WebRTC, full P2P mesh. Each participant opens a direct peer connection to every
other participant. The browser's built-in SRTP handles the actual audio. The
server never touches media bytes.

Mesh costs: `n*(n-1)/2` connections, each carrying one Opus stream in each
direction. Opus voice at 32 kbps is effectively transparent; at 8 people that's
28 connections, ~450 kbps per client upstream. Fine for home broadband.

Soft cap: warn the UI at 8 participants, hard-stop joining at 12. At 12 you'd
have 66 peer connections; still functional but the UX degrades. For 20 friends
there will rarely be more than 4–5 in a voice channel at once.

If that cap ever feels wrong in practice, an SFU (Pion, mediasoup) is the
natural next step — but that's a new service, new dependency, and real ops work.
Don't add it speculatively.

### Signaling

The existing WS hub grows a routing layer for `voice.*` message types. No new
transport; no new server; the hub dispatches them like it would any other event,
but routes point-to-point by `to_user_id` rather than fan-out.

```
voice.join           {channel_id}
voice.leave          {channel_id}
voice.offer          {to_user_id, channel_id, sdp}
voice.answer         {to_user_id, channel_id, sdp}
voice.ice            {to_user_id, channel_id, candidate}
voice.mute           {channel_id, muted}          → hub fans out to channel
voice.state          {channel_id, participants}    → hub fans out (authoritative roster)
voice.ring           {dm_channel_id}               → hub routes to other DM participant
voice.ring_response  {dm_channel_id, accept}
voice.ring_timeout   {dm_channel_id}               → server fires after N seconds
```

`voice.offer / answer / ice` are relayed verbatim between two users. The hub
validates that both users have access to the named channel; it doesn't inspect
the SDP.

### Server-side state

Ephemeral, in-memory only (in the hub struct):

```go
voiceChannels map[int64]map[int64]*VoiceParticipant
// channel_id → user_id → {JoinedAt, Muted}
```

No DB table. Voice state does not survive a server restart (everyone gets
disconnected; that's fine). The hub cleans up a user's voice participation when
their WS connection closes, same as presence.

### NAT traversal: STUN + coturn

**STUN** punches through ~80% of home NAT. Use Google's public STUN
(`stun.l.google.com:19302`) or self-host one. Zero cost, zero auth, zero
infrastructure beyond a config var.

**TURN** relays for the rest (symmetric NAT, CGNAT, some corporate firewalls).
coturn is the standard open-source relay. It's a separate Linux service
(`dnf install coturn`), not a Go dependency. For 20 friends with occasional TURN
fallback, relay bandwidth is negligible — maybe a few hundred kbps peaks if
everyone happens to need relay simultaneously.

Use coturn's HMAC time-limited credential model: the server generates short-lived
credentials without coturn needing a user database.

```
username  = "{unix_timestamp}:{user_id}"
credential = HMAC-SHA256(TURN_SECRET, username)
```

A new endpoint `GET /api/rtc/credentials` returns a fresh credential pair valid
for 1 hour. The client passes these to `RTCPeerConnection` as the TURN
`iceServer` config. coturn validates them against the shared secret — no DB hit,
no external call.

New config vars:
```
RIVENDELL_STUN_URL          (default: stun:stun.l.google.com:19302)
RIVENDELL_TURN_URL          (e.g. turn:turn.example.com:3478)
RIVENDELL_TURN_SECRET       (shared HMAC secret with coturn)
```

If `RIVENDELL_TURN_URL` is unset, TURN is skipped; STUN-only is acceptable for
a LAN or a network where everyone has a real routable IP.

---

## New backend surface (Go)

All minimal — no new deps.

### Config (`internal/config/config.go`)

Three new env vars above.

### Hub (`internal/ws/hub.go`)

```
voiceChannels   map[int64]map[int64]*VoiceParticipant
voiceMu         sync.RWMutex
```

New dispatch branch in the hub's run loop:
- `voice.join`: add participant to map, broadcast `voice.state` to channel audience
- `voice.leave`: remove, broadcast `voice.state`
- `voice.offer / answer / ice`: validate both users share the channel, route to
  target client's WS connection
- `voice.mute`: update participant's muted flag, broadcast `voice.state`
- `voice.ring / ring_response`: validate DM membership, route point-to-point;
  server sets a 30s ring timeout goroutine that fires `voice.ring_timeout` if
  unanswered
- On WS disconnect: clean up any voice participation for that user, broadcast
  updated `voice.state` for affected channels

### Handlers (`internal/httpapi/handlers.go`)

```
GET  /api/channels/{id}/voice    → list current voice participants (REST, for page load)
GET  /api/rtc/credentials        → generate short-lived TURN credentials
```

`handleGetVoiceParticipants` reads from hub's voiceChannels map (behind voiceMu),
returns `[]VoiceParticipant{UserID, Muted, JoinedAt}`. Auth: same access rules as
`canAccessChannel`.

`handleGetRTCCredentials` generates the HMAC credential pair. Returns:
```json
{
  "stun": "stun:stun.l.google.com:19302",
  "turn": "turn:turn.example.com:3478",
  "username": "1717680000:42",
  "credential": "<hmac>"
}
```

If TURN is unconfigured, omits `turn`/`username`/`credential`.

---

## New frontend surface

### `web/static/voice.js` (new file)

Owns all WebRTC and audio machinery. Pure functions where possible; the state it
holds is media-specific (streams, peer connections) and doesn't belong in
`state.js`.

```
initVoice(iceServers)       → fetch /api/rtc/credentials, build iceServers config
joinVoiceChannel(channelId) → getUserMedia → for each peer: createOffer → send voice.offer
leaveVoiceChannel()
handleVoiceSignal(msg)      → dispatch voice.offer/answer/ice to the right RTCPeerConnection
setMuted(bool)
setSpeakingCallback(cb)     → cb(userId, speaking: bool) — driven by AnalyserNode polling
setVolumeForUser(userId, 0–1)
```

Peer connection lifecycle per remote participant:
1. Local user joins first → wait for `voice.state`; create RTCPeerConnection and
   send offer to each existing participant
2. New participant joins → existing members get a `voice.state` update; they each
   send an offer to the newcomer
3. ICE trickling: send candidates via `voice.ice` as they arrive; apply incoming
   candidates immediately
4. On `voice.state` removals: close and discard that peer's RTCPeerConnection

Speaking detection: `AudioContext` → `MediaStreamSource` → `AnalyserNode` →
poll `getFloatTimeDomainData`, compute RMS, compare to threshold (~0.01).
Poll interval 80ms. Debounce speaking state flip to avoid flicker (100ms on,
500ms off). Call the speaking callback; `app.js` uses it to animate a ring on
the participant's avatar.

Push-to-talk: keydown/keyup on a configurable key (default: backtick). While
key is held, unmute; on release, re-mute. The mute state is sent as `voice.mute`
so other clients show the visual indicator correctly.

getUserMedia constraints:
```js
{
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000,
  },
  video: false
}
```

Mono, 48kHz (Opus's native sample rate). Stereo is unnecessary for voice chat
and doubles the bitrate.

### `web/index.html` + `web/static/app.js`

**Voice channel rows** in the sidebar: below the channel name, show a small
participant count and their avatars/names when anyone is in the channel. Fetch
`GET /api/channels/{id}/voice` on initial load; keep live via `voice.state`
events.

**Join/leave control**: clicking a voice channel with no active call joins it.
An active call indicator (fixed strip at the bottom of the sidebar) shows "In
#general-voice — 🎙 Mute · 🔇 Deafen · ✕ Leave". Joining a second voice channel
auto-leaves the first.

**Speaking rings**: a subtle pulsing border on a participant's avatar tile when
their RMS crosses the threshold.

**DM call flow**:
- Call button (📞) in the DM header
- Sender: spinner/ringing state; cancel button
- Receiver: incoming call banner with Accept / Decline buttons (and a soft ring
  sound via Web Audio)
- On accept: both sides call `joinVoiceChannel(dm_channel_id)` — same machinery
  as a channel call, just two participants
- On decline or timeout: both sides return to idle

**Mute/deafen**: mute = stop sending audio (track.enabled = false). Deafen =
mute all incoming `<audio>` elements (`.muted = true` on each). Both are
client-only and don't require a server round-trip (mute status is still broadcast
via `voice.mute` for the indicator, but the audio gate is local).

---

## coturn setup (ops notes)

```
# /etc/turnserver.conf (minimal)
listening-port=3478
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=<same value as RIVENDELL_TURN_SECRET>
realm=your.domain
no-multicast-peers
no-cli
```

Firewall: open UDP 3478 (STUN/TURN signaling) and UDP 49152–65535 (relay
range). TCP 3478 as fallback for restrictive firewalls. coturn listens on both.

Nginx doesn't need changes — TURN is UDP and bypasses it. The existing WS proxy
config is unchanged.

---

## Implementation phases

### Phase 1 — signaling skeleton
- Config vars (STUN_URL, TURN_URL, TURN_SECRET)
- Hub voice state map + routing for `voice.*` WS types
- `GET /api/channels/{id}/voice`
- `GET /api/rtc/credentials`
- `voice.state` fan-out when participants change
- Ring timeout goroutine for DM calls

### Phase 2 — DM calling (2-party, simplest case)
- `voice.js` with getUserMedia, one RTCPeerConnection, offer/answer/ICE flow
- DM call UI: call button, ring banner, active call strip
- Mute/deafen controls
- End-to-end green: two users in a DM can call each other

### Phase 3 — voice channels (multi-party mesh)
- ✅ Extend `voice.js` to manage N peer connections
- ✅ Voice channel sidebar UI (participant list, join/leave)
- ✅ Speaking indicators (AnalyserNode)
- ✅ Participant volume sliders
- Soft participant cap (warn at 8, block at 12)

### Phase 4 — polish
- Push-to-talk
- Reconnection on peer connection failure (ICE restart)
- Graceful handling of getUserMedia denial (mic permission)
- ✅ Per-user volume knob persistence (localStorage)
- Mobile: test that the call strip doesn't obscure the composer

---

## What this does not do

- Server-side audio processing or mixing
- Recording
- Video (deferred to a later version)
- End-to-end encryption beyond what DTLS-SRTP gives for free (already covered by WebRTC)
- Noise suppression better than the browser's built-in (good enough for a home server)
- SFU/MCU (add if the mesh cap is regularly hit, which is unlikely at 20 users)
