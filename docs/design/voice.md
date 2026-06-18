# Voice calling

**Status: shipped.** Serviceable voice for ~20 friends: a full peer-to-peer WebRTC
mesh, signaled over the existing WebSocket hub. No media server, no ML, no new Go
dependencies. Video (camera + screen share) is built on top of this — see
[video.md](video.md).

## Design

### The "good enough" tier

At ~20 users we lean entirely on what the browser's WebRTC stack gives for free —
the old Ventrilo/Skype tricks that still work perfectly at small scale:

| Technique | Where it comes from |
|---|---|
| Opus codec — DTX (silence suppression), PLC (packet loss concealment), FEC | WebRTC mandates Opus; the browser handles it |
| Echo cancellation, noise suppression, auto gain control | `echoCancellation` / `noiseSuppression` / `autoGainControl` on `getUserMedia` |
| Jitter buffering, voice activity detection, comfort noise | Browser WebRTC stack, automatic |
| Push-to-talk | Client-side: hold a key, unmute; release, re-mute |

On top of that, cheaply and client-side: visual speaking indicators (`AnalyserNode`
RMS metering), a per-participant volume slider, and a push-to-talk toggle.

We deliberately skip everything that only matters at scale: ML denoising
(Krisp/RNNoise), conference-room-tuned AEC, enterprise adaptive bitrate, and
SFU/server-side mixing. At 20 friends we never hit the problems those solve.

### Transport — full P2P mesh

Each participant opens a direct `RTCPeerConnection` to every other participant; the
browser's SRTP carries the audio and the server never touches media bytes. The mesh
costs `n*(n-1)/2` connections. Opus voice at ~32 kbps is effectively transparent; at
8 people that's 28 connections and ~450 kbps upstream per client — fine for home
broadband.

Caps are server-enforced (`MaxVoiceAudio`, with a separate lower video sub-cap — see
[video.md](video.md)). For 20 friends there will rarely be more than 4–5 in a
channel at once. If the mesh cap ever feels wrong in practice, an SFU (Pion,
mediasoup) is the natural next step — but that's a new service, a new dependency, and
real ops work. Don't add it speculatively.

### Signaling

The WS hub routes `voice.*` frames point-to-point by `to_user_id` (offer / answer /
ice) or fans them out to a channel audience (state / mute). The hub validates that
both users have access to the named channel; it never inspects the SDP. DM ring
flow (`voice.ring` / `ring_response` / `ring_timeout`) reuses the same relay, with a
server-side timeout goroutine for an unanswered call.

### Server-side state

Ephemeral and in-memory only, in the hub struct (`voiceChannels map[int64]map[int64]*VoiceParticipant`,
channel → user → `{JoinedAt, Muted, VideoMuted}`). No DB table: voice state does not
survive a restart (everyone reconnects, which is fine), and the hub cleans up a
user's participation when their WS closes, the same as presence.

REST reads for page load: `GET /api/voice/state`, `GET /api/channels/{id}/voice`,
and `GET /api/rtc/credentials` (below).

### NAT traversal: STUN + coturn

STUN punches through most home NAT for free (`RIVENDELL_STUN_URL`, default Google's
public STUN). TURN relays the rest (symmetric NAT, CGNAT, restrictive firewalls) via
coturn — a separate Linux service (`dnf install coturn`), not a Go dependency.

Credentials use coturn's HMAC time-limited model, so the server mints short-lived
credentials with no coturn-side user database:

```
username   = "{unix_timestamp}:{user_id}"
credential = HMAC-SHA1(TURN_SECRET, username)
```

**The HMAC is SHA-1, not SHA-256** — coturn validates with SHA-1, and
`TestRTCCredentials` asserts the 20-byte digest. `GET /api/rtc/credentials` returns a
fresh pair valid for ~1 hour; if `RIVENDELL_TURN_URL` is unset, TURN is omitted and
STUN-only applies (acceptable on a LAN or where everyone has a routable IP).

Config: `RIVENDELL_STUN_URL`, `RIVENDELL_TURN_URL`, `RIVENDELL_TURN_SECRET`.

## Invariants / footguns

These are the load-bearing rules; the condensed list is in CLAUDE.md under
Voice/WebRTC, and the pure helpers are unit-tested in `voice.test.js`.

- **Offerer = lower `user_id`, with Perfect Negotiation on top** (lower = impolite).
  The *initial* offer belongs to `onVoiceState` alone — `sendOffer` (the
  `negotiationneeded` path) returns early while `!pc.remoteDescription`. Letting both
  sides offer at setup causes glare and an ICE stall.
- **Glare re-offer is one-shot** (`renegotiatePending` in `onOffer`). Do **not** wire
  it to `signalingstatechange` — both peers re-offer in lockstep and oscillate,
  breaking both video directions.
- **DM calls end for both parties** (`endDMVoiceCall` / `cleanupVoiceForUser` removes
  both). Guarded by `TestDMCallEndsForBothParties` / `TestVoiceChannelLeaveKeepsOthers`.
- **Both `onconnectionstatechange` AND `oniceconnectionstatechange`** feed
  `effectiveConnectionState` — Firefox reports ICE failure before (sometimes instead
  of) connection state. The ICE-disconnect grace is 5 s on purpose; don't shorten it.
- **Per-user volume uses `audio.volume`, not a Web Audio `GainNode`** (a Chromium
  no-output bug bites WebRTC + WebAudio together).
- **Teardown is synchronous** (`finishTeardown` → `closeAllPeers` before the
  farewell-tone await); `callGen` guards a rapid re-join from colliding with a stale
  teardown.

## coturn setup (ops reference)

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

Firewall: open UDP 3478 (STUN/TURN signaling) and UDP 49152–65535 (relay range), with
TCP 3478 as a fallback for restrictive firewalls. Nginx needs no changes — TURN is UDP
and bypasses it; the existing WS proxy config is unchanged.

## Out of scope

Server-side audio processing or mixing, recording, end-to-end encryption beyond the
DTLS-SRTP WebRTC already gives, and an SFU/MCU (add only if the mesh cap is regularly
hit, which is unlikely at 20 users).
