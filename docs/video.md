# Video calling roadmap

Target: opt-in camera video on top of the existing P2P WebRTC voice infrastructure.
Same design constraints as voice: no media server, no new Go dependencies, vanilla JS,
~20 friends.

---

## What already exists

Everything needed for the transport layer is already in place:

- P2P RTCPeerConnection mesh with ICE/STUN/TURN (`voice.js`)
- SDP offer/answer/ICE signaling over the WS hub (`voice.*` events)
- ICE restart reconnection logic
- `getUserMedia` call (currently `video: false`)
- `VoiceParticipant` struct and hub state (`hub.go`)
- `voice.mute` event and per-participant muted flag

Video is additive: we add a video track to the existing peer connections, extend
a few data structures, and build out the UI. The signaling protocol does not change;
WebRTC renegotiation handles the track addition transparently.

---

## What video adds over voice

| Concern | Voice (today) | Video (new) |
|---|---|---|
| Media capture | `getUserMedia({audio, video:false})` | `getUserMedia({audio, video:{...}})` |
| Track count per peer | 1 audio | 1 audio + 1 video |
| Participant element | `<audio>` (appended to body, invisible) | `<audio>` (same) + `<video>` (visible tile) |
| Local preview | none | local `<video>` tile (must be muted) |
| Mute controls | audio mute only | audio mute + camera toggle |
| Server state | `Muted bool` in VoiceParticipant | + `VideoMuted bool` |
| WS event | `voice.mute {muted}` | extend payload: `{muted, video_muted}` |
| Renegotiation | never needed | needed when camera is toggled mid-call |
| Participant cap | warn at 8, block at 12 | much lower — see scaling section |
| Layout | fixed strip in sidebar | dedicated video grid panel/modal |

---

## Scaling reality check

Voice at 32 kbps Opus: 8 people = 28 connections, ~450 kbps upstream each. Fine.

Video at 360p / ~400 kbps VP8 or H.264: 4 people = 6 connections, ~1.2 Mbps upstream.
At 6 people that's 1.5 Mbps+ upstream per client — approaching the limit of home
upload speeds. At 8 it becomes untenable.

**Recommended cap: warn at 4 video participants, block video at 6.**
(Audio-only users can still join above that cap — voice has its own higher cap.)
The browser's built-in congestion control (REMB/TWCC) will reduce quality under load,
but the mesh itself is the bottleneck; an SFU would fix that but adds real ops work.

DM calls are exempt from the cap (they're always exactly 2 people).

---

## Implementation phases

### Phase 1 — DM video calls (2-party)

Safest starting point: one peer connection, no grid layout needed.

**Backend changes** (`hub.go`, `handlers.go`)

- Add `VideoMuted bool` to `VoiceParticipant`. No DB migration needed (ephemeral).
- Extend the `voice.mute` hub dispatch to read and store `video_muted` from the
  payload, then include it in the `voice.state` broadcast.
- No new routes or WS event types required.

**`voice.js` changes**

- Change `getUserMedia` to accept a `{enableVideo: bool}` option. When enabled,
  include a video constraint:
  ```js
  video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } }
  ```
  360p/24fps is a reasonable default — crisp enough to read faces, light on bandwidth.
  Fall back to `video: false` if the camera fails (camera failure must not block a call).

- Add `videoEls` map (`remoteUserId → <video>`). In `createPC`'s `ontrack`, dispatch
  on `track.kind`: audio → existing `<audio>` path, video → new `<video>` element.
  Video elements need `autoplay`, `playsinline` (iOS), and **`muted = true`** — on
  BOTH the remote tiles and the local preview. Not for echo (the remote audio plays
  through its own `<audio>` element), but because mobile autoplay policy refuses to
  play a media element that produces sound: an unmuted remote `<video>` whose stream
  carries an audio track decodes one frame and then sits paused forever. That was the
  "one frame and done" freeze — a paused element on the receiver, not an encoder stall
  on the sender (which is why no codec change ever fixed it).

- Add a local preview `<video>` element. Point its `srcObject` at `localStream`
  immediately after `getUserMedia`; set `.muted = true` to suppress audio feedback.

- Add `setCameraEnabled(bool)` export: toggles the video track's `.enabled` flag.
  This does not require renegotiation (the track stays in the SDP, just sends black
  frames or nothing). Send `voice.mute` with the updated `video_muted` state.

- Add `cameraErrorMessage(err)` pure helper (mirrors `micErrorMessage`, unit-test it):
  handles `NotAllowedError`, `NotFoundError`, `NotReadableError`, `OverconstrainedError`.
  A camera denial must not abort the call — fall back to audio-only.

**Mid-call camera toggle (renegotiation)**

If a user starts a call with camera off and then enables it later, `addTrack` on an
existing peer connection triggers `onnegotiationneeded`. Wire that event in `createPC`:

```js
pc.onnegotiationneeded = async () => {
  if (!isOfferer(remoteUserId)) return; // answerer waits
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendFn({ type: "voice.offer", to_user_id: remoteUserId, ... });
};
```

The answerer's existing `onOffer` path handles it transparently. This is the same
offer/answer flow already in place; `onnegotiationneeded` just triggers it automatically
instead of us calling `createOffer` manually.

**UI (DM call only)**

- Replace the flat "in call" audio strip with a 2-tile video grid inside the DM channel
  view. Local tile (bottom-right corner, picture-in-picture style) + remote tile.
- Camera-off state: show a dark tile with the participant's avatar and name.
- Add a camera toggle button (🎥 / ✕) to the call controls alongside mute/deafen/hang-up.
- Camera permission prompt: if `getUserMedia` rejects with `NotAllowedError`, show
  `cameraErrorMessage` in the call UI and continue the call audio-only.

**Tests**

- Unit test `cameraErrorMessage` in `voice.test.js`.
- Extend the `voice.test.js` timeline test to cover the camera-on/camera-off
  lifecycle (track.enabled transitions, onnegotiationneeded firing).

---

### Phase 2 — video in multi-party voice channels

**Backend**

- Enforce the video participant cap server-side: when a `voice.join` arrives with
  `video: true`, count current video-enabled participants; reject with a new
  `voice.join_denied` event if over the cap. The client falls back to audio-only.
  (Cap value: 6 hard-block, configurable via `RIVENDELL_MAX_VIDEO_PARTICIPANTS` or
  just a constant.)

**`voice.js`**

- `joinVoiceChannel` gains an `{enableVideo}` option that flows through to
  `getUserMedia` and is advertised in the `voice.join` payload.
- `onVoiceState` already creates peer connections for all participants; video tracks
  are added automatically when `localStream` contains them.

**UI**

- Video grid layout: CSS grid, auto-sizing tiles. Speaker-view mode (largest tile =
  loudest speaker by RMS) vs equal-grid toggle.
- Sidebar call strip still shows who's in the channel; the video panel is a
  floating overlay or occupies the main content area while in a video call.
- Participant count badge shows camera icons (🎥 on, 🎤 audio-only) in the roster.
- Mobile: portrait video tiles stacked vertically; camera toggle accessible without
  opening the sidebar.

---

### Phase 3 — screen sharing (future)

`getDisplayMedia` produces a `MediaStream` with a video track. The mechanics are
identical to camera video (add a third track, renegotiate), but it's a separate
permission flow and the UX is distinct: only the sharer sends a screen track; viewers
just receive it. Defer until Phase 2 is stable.

Key open questions deferred to that design pass:
- Can a user share screen + camera simultaneously (two video tracks)?
- Does a screen share replace or add to the video grid?
- Should the hub track `ScreenSharing bool` in `VoiceParticipant`?

---

## Capture aspect ratio & the FF-Android outbound-video freeze (reference)

This is the single fiddliest corner of video. Read it before touching
`VIDEO_CONSTRAINTS` or anything that "fixes" a non-landscape capture or a frozen
tile. There are **two separate FF-Android problems** here that were long conflated;
keep them apart.

### 1. Square capture (real, fixed)

On Firefox for Android with a 4:3/1:1-native sensor (e.g. the Pixel 7), given any
`width ≠ height` ideal, the camera does NOT pick a matching native mode — it crops to
a **square** whose side equals the requested height (`640×360 → 360×360`,
`640×480 → 480×480`). No JS constraint reliably forces landscape.

**Fix (current policy):** request **no spatial constraint at all** —
`VIDEO_CONSTRAINTS` is `{ frameRate: { ideal: 24 } }`, nothing else. With nothing to
crop against, the sensor opens its own native (non-square) mode, and the render side
absorbs whatever aspect arrives via `object-fit` (see `style.css`). Never use
`aspectRatio`, `max`, or `exact` at getUserMedia time: an `aspectRatio: {ideal:16/9}`
term (commit `3a31f7e`) *collapsed* capture to square, and a `max` ceiling threw
`OverconstrainedError` and silently killed the Android preview (the v1.3.18
regression). Open-time constraints are ideal-only, frame-rate-only, on purpose. See
the comment block above `VIDEO_CONSTRAINTS` in `voice.js`.

### 2. The outbound-video encoder freeze (upstream Firefox bug, unfixable here)

Independently of capture geometry, **Firefox-stable on Android invokes its video
encoder for ~3–7 frames and then stops entirely** (`totalEncodeTime` flat,
`framesEncoded` frozen, `frameWidth = 0`) while it *receives/decodes* peers fine and
its own local preview stays pristine. We ruled out, by direct testing: codec
(reproduces on VP8 and VP9; FF-Android exposes no H.264 at all), transport
(reproduces at `connected/connected` on LAN), the camera→encoder feed (a
`canvas.captureStream` pipeline froze identically), and frame orientation/dimensions.

**Conclusion: it's an upstream Firefox-stable encoder bug — it works on Firefox
Android _Nightly_.** Nothing in this codebase cures it; don't re-chase it. Use Chrome
for Android (or Firefox Nightly) to *send* video from a phone; receiving works
everywhere. The "one frame and done" *receiver* freeze was a different, fixed problem
— an unmuted remote `<video>` paused by mobile autoplay policy (Phase 1, `muted =
true` on every tile). Don't conflate the two.

### Removed diagnostic scaffolding

Chasing #2 produced a lot of throwaway tooling that has since been deleted — don't be
surprised by references to it in old commit messages:

- the `?rtcdebug=1` on-screen getStats HUD,
- an admin-panel "video debugging console" (a live camera/constraints lab that
  persisted a `rivendell.videoConstraints` override),
- a `canvas.captureStream` send pipeline,
- an `applyConstraints` landscape-coercion ladder.

All served their diagnostic purpose and were removed to keep the surface small once
the root cause (#2) was understood as an upstream bug.

### What survives as standing policy

- **Capture:** `VIDEO_CONSTRAINTS = { frameRate: { ideal: 24 } }` — frame-rate ideal
  only, no spatial constraint (see #1).
- **Codec:** VP8-first (`orderVideoCodecsVP8First`) as a safe cross-browser default;
  it does **not** fix the freeze (#2).
- **Render:** `object-fit` on the tiles absorbs any aspect ratio.
- **Bandwidth:** shaped by `contentHint = "motion"` — not by a capture-resolution or
  sender-bitrate cap. (A live `setParameters` bitrate cap was a dead end and was
  removed.)

### Commit trail (so the reasoning isn't lost)

| Commit | Move | Outcome |
|---|---|---|
| `3a31f7e` | `aspectRatio: {ideal: 16/9}` | Collapsed FF-Android to square, wedged the encoder. Reverted. |
| `ee2e9d7` | Dropped spatial constraints entirely | Current capture policy — sensor opens its own native mode. |
| `fd0ba03` | `muted = true` on remote tiles | Fixed the "one frame and done" *receiver* freeze (autoplay). |
| `1a65e48` → `3c31acd` | canvas send pipeline | Froze identically; the wedge is in FF's encoder, not the feed. Removed. |
| `f596106` → `3c31acd` | `applyConstraints` coercion ladder | No-op on FF-Android live tracks. Removed. |
| `98ba35e` → cleanup | video debugging console + `rtcdebug` HUD | Diagnostic only; let us *see* the freeze. Removed once the cause was known. |

### If "make it work on Firefox-stable Android" resurfaces

There is no client-side fix — it's an upstream Firefox encoder bug (works on
Nightly). Use Chrome for Android or Firefox Nightly to *send*; receiving works
everywhere. An SFU/transcode step is explicitly out of scope (no media server, see
top of this doc). Document any *new* device behaviour in the table above rather than
re-litigating the constraint stack.

---

## Data structure changes summary

**`internal/ws/hub.go`** — `VoiceParticipant`:
```go
type VoiceParticipant struct {
    UserID     int64     `json:"user_id"`
    JoinedAt   time.Time `json:"joined_at"`
    Muted      bool      `json:"muted"`
    VideoMuted bool      `json:"video_muted"` // new
}
```

**`voice.js`** — module-level state additions:
```js
let videoEls = new Map();       // remoteUserId -> <video>
let localVideoEl = null;        // local preview <video>
let cameraEnabled = false;      // whether we joined with camera on
```

**WS event extension** — `voice.mute` payload gains `video_muted`:
```json
{ "type": "voice.mute", "channel_id": 5, "muted": false, "video_muted": true }
```
Backwards-compatible: old clients ignore unknown fields; new server ignores absent
`video_muted` (defaults false).

---

## What this does not do

- SFU/MCU — the mesh topology is preserved; add an SFU (Pion, mediasoup) only if
  the video cap is regularly hit in practice.
- Recording — a natural add-on once video is stable, but requires storage and
  consent UI.
- End-to-end encrypted video beyond DTLS-SRTP (already covered by WebRTC).
- Adaptive bitrate switching beyond the browser's built-in REMB/TWCC.
- Virtual backgrounds or ML-based video processing.
- Multi-camera layouts (no SFU = one video track per person).
