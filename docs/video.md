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

## Capture aspect ratio — the FF-Android square-capture saga (reference)

This is the single fiddliest corner of video, and it has bitten us across many
commits. Read this before touching `VIDEO_CONSTRAINTS`, the coercion ladder, or
anything that "fixes" a non-landscape capture. The short version:

> **On Firefox for Android with a 4:3/1:1-native sensor (e.g. the Pixel 7 Pro),
> the camera captures *square* (1080×1080, 360×360, …) and there is no JS
> constraint that reliably moves it to landscape. This is a browser limitation,
> not a bug in our code. Accept it; fix aspect on the render side. Chrome for
> Android gives landscape; Firefox for Android does not.**

### How to recognise it

Open the admin video console (RTC HUD). The tells:

- `local cap: 1080x1080@60` / `local cap: 360x360@30` — width == height (square).
- `(chromium-only) impl=n/a pe=n/a` — the Chromium-only encoder stats are absent,
  so the browser is **Firefox**. (On Chromium these read real values.)

A square `local cap` line plus `impl=n/a` is the signature of this exact issue.

### Why constraints can't fix it

1. **getUserMedia constraints are advisory on FF-Android.** `width/height: {ideal}`
   nudge the fitness-distance pick but do not force a mode; the camera can and does
   settle on a square mode anyway.
2. **`aspectRatio` makes it *worse*.** An earlier `aspectRatio: {ideal: 16/9}`
   (commit `3a31f7e`) didn't widen the picture — it fought a sensor with no real
   16:9 mode and *collapsed* FF-Android to a square 360×360 capture, which then fed
   a wedged VP8 encoder (enc frozen, `0x0` out). Do not reintroduce an `aspectRatio`
   term. See the comment block above `VIDEO_CONSTRAINTS` in `voice.js`.
3. **`applyConstraints` is effectively a no-op on a live FF-Android track.** The
   post-open coercion ladder (commit `f596106`) walks `exact` landscape profiles via
   `track.applyConstraints()`. On Chromium this can re-pick a mode; on FF-Android the
   exact rungs simply reject (or resolve back to square), leaving the track untouched.
   The ladder is therefore a **best-effort safety net for portrait/rotated captures,
   not a cure for FF-Android square.** It can only help, never break — don't expect
   more from it, and don't expand it hoping to win this fight.
4. **Never use `max` or `exact` at getUserMedia time.** A `max` ceiling threw
   `OverconstrainedError` on Android front cameras and silently killed the preview
   (the v1.3.18 regression). Open-time constraints are ideal-only on purpose.

### The standing policy (the "standard")

- **Capture:** `VIDEO_CONSTRAINTS` is ideal-only, landscape-oriented size
  (`width 640 / height 360`), **no `aspectRatio`, no `max`, no `exact`**. This lets
  each camera settle on its own native landscape mode where it has one (~640×360 on
  a 16:9 webcam, ~480×360 on a 4:3 Pixel under Chrome) and fall back to square on
  FF-Android without erroring.
- **Render:** the video tiles use `object-fit` (`contain`/`cover`, see `style.css`),
  so *any* arriving aspect — square, 4:3, 16:9 — displays without stretching. This is
  where aspect is actually handled.
- **Encode:** VP8 drives a square frame cleanly. The historical "one frame and done"
  freeze was **not** an encoder/aspect problem — it was an unmuted remote `<video>`
  paused by mobile autoplay policy (fixed by `muted = true` on every video element;
  see Phase 1). Don't go looking for a codec fix for a square frame.
- **Diagnosis lever:** the admin video console persists a tuned constraints object to
  `localStorage` (`rivendell.videoConstraints`) so you can A/B a capture profile on a
  real call without a rebuild. Use it to *confirm* behaviour on a device, not to hunt
  for a magic constraint that doesn't exist on FF-Android.

### Commit trail (so the reasoning isn't lost)

| Commit | Move | Outcome |
|---|---|---|
| `3a31f7e` | `aspectRatio: {ideal: 16/9}` | Fought the 4:3 sensor → collapsed FF-Android to square, wedged the encoder. Reverted. |
| `f596106` | `applyConstraints` coercion ladder | No-op on FF-Android live tracks; kept only as a portrait→landscape safety net. |
| `98ba35e` | Added the real-time video debugging console / RTC HUD | Gave us `local cap` + `impl=n/a` so we could finally *see* the square frame. |
| `cfdb0d3` | Stopped forcing 16:9; accept the native sensor + `object-fit` render | Current policy. Capture may be square on FF-Android; the UI handles it. |

### If "make it landscape on that device" ever resurfaces

The honest answer is: **use Chrome for Android**, or run an SFU/transcode step
server-side (explicitly out of scope — no media server, see top of this doc).
There is no client-side constraint that makes Firefox for Android hand us a
landscape frame from a square-native sensor. Document any *new* device behaviour in
the table above rather than re-litigating the constraint stack.

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
