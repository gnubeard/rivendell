# Video calling

**Status: shipped.** Camera video landed on top of the voice mesh across the 1.4
series; congestion control and desktop screen sharing landed in 2.0.0. This is the
design record and the reference for the fiddly corners — capture aspect ratio and
the FF-Android encoder freeze especially. Same constraints as
[voice.md](voice.md): no media server, no new Go dependencies, vanilla JS, ~20
friends.

## Design

Video is additive over voice: the transport (P2P `RTCPeerConnection` mesh,
offer/answer/ICE over the WS hub, ICE-restart reconnection) was already in place, so
video adds a video track to the existing peer connections and lets WebRTC
renegotiation handle the track. The signaling protocol did not change.

| Concern | Voice | Video adds |
|---|---|---|
| Capture | `getUserMedia({audio})` | `+ video` constraint |
| Tracks per peer | 1 audio | + 1 video |
| Participant element | invisible `<audio>` | + a visible `<video>` tile + local preview |
| Controls | mute | + camera toggle, + screen-share toggle |
| Server state | `Muted` | `+ VideoMuted` on `VoiceParticipant` (ephemeral; no migration) |
| Renegotiation | never | when a camera/screen is toggled mid-call |
| Caps | 10 audio | a lower video sub-cap (server-enforced) |

### Scaling reality check

Video at 360p / ~400 kbps is ~1.2 Mbps upstream at 4 people, approaching home-upload
limits by 6 and untenable by 8. So video carries its own lower cap (warn ~4, block
~6) on top of the audio cap; audio-only users can still join above it, and DM calls
are exempt (always exactly 2 people). The browser's REMB/TWCC reduces quality under
load, but the mesh itself is the bottleneck — an SFU would fix that and is out of
scope.

### Camera, congestion control, and screen share

These three are built and their load-bearing invariants are kept in CLAUDE.md under
Voice/WebRTC (this is the design summary; trust CLAUDE.md for the exact rules):

- **Mid-call camera toggle** uses `onnegotiationneeded` to drive the same
  offer/answer flow that already exists; `setCameraEnabled` flips the track's
  `.enabled` and broadcasts the updated `video_muted` over `voice.mute`. A camera
  failure (`cameraErrorMessage`, mirror of `micErrorMessage`) never aborts the call —
  it falls back to audio-only.
- **Per-sender bitrate cap + AIMD congestion control.** The 800 kbps per-sender cap
  is a ceiling, not a freeze fix; `bitrateCapFor` shrinks it as the roster grows, and
  per-peer congestion control (`monitorCongestion`, every 2.5 s) lowers the live
  target on remote loss/RTT or a CPU-pinned local encoder, climbing back only after
  `CLIMB_AFTER_HEALTHY` healthy intervals (the anti-oscillation gate). The full
  encoding shape (`maxBitrate` + `scaleResolutionDownBy`/`maxFramerate`) is applied
  together — bitrate-only back-off does not relieve a CPU-bound phone encoder.
- **Screen share** is a *second video source* on the single video slot, mutually
  exclusive with the camera (`setScreenShareEnabled`). Camera↔screen swaps the source
  on the existing m-line via `replaceTrack` (instant, no reneg); first-enable
  `addTrack`s and renegotiates. The design-pass questions resolved as: one video
  source at a time (not camera + screen together); the screen replaces the sender's
  existing tile (no extra grid slot); and **no** `ScreenSharing` flag on
  `VoiceParticipant` — the real reason to add a per-stream server flag would be
  bandwidth-consent *receive* control, not labelling.

Two screen-share corners worth keeping straight:

- **Encoding steps resolution DOWN for screen content under congestion.** A share runs
  `contentHint="detail"` + `videoScaleForTarget(t, isScreen=true)`, captured at
  `frameRate: { ideal: 30 }`. A shared screen is high-resolution (often 1080p+), so it
  scales on its OWN thresholds (`VIDEO_SCALE_SCREEN_FULL_BPS` 700k /
  `VIDEO_SCALE_SCREEN_QUARTER_BPS` 350k), more aggressive than the camera's: **native
  res only with real headroom (≥700k), ½ across the broad middle (350–700k), ¼ at the
  floor (<350k)** — framerate stays at 30. The earlier "hold native res, shed framerate"
  design was wrong here: a 1080p+ frame too big for the link stalls in bursts (the
  observed ~0.5 s-smooth / ~0.5 s-hiccup oscillation — telemetry showed `out.v.res`
  pinned at full while `out.v.fps` swung 5↔21 under 13–40 % loss). Crisp-but-laggy is
  worse than soft-but-fluid; small frames pace smoothly. The AIMD target (loss/RTT +
  CPU-bound encoder) is what drops us, so resolution only gives once the controller has
  judged the link can't carry native res. `detectScreenMotion` (hysteretic, watching the
  encoder's outbound `framesPerSecond`: ~0–2 fps static, ~24+ playing) flips
  `contentHint` to "motion" and keeps 30 fps even at the ¼ floor (a static doc eases to
  24 there). Fully automatic, no UI. `track.onended` catches the native "Stop sharing" bar.
- **Audio teardown differs from video.** Shared tab/system audio (Chrome) is
  `addTrack`ed into the mic's stream so the remote plays both through its one
  `<audio>`, but rides its own m-line so muting the mic never silences it. On stop it
  is **fully removed** (`pc.removeTrack`), not parked — audio has no
  `video_muted`-style gate, so a parked-but-silent track would still be audible. Video
  parks-and-reuses its sender; audio removes. `web/e2e/screen-share.spec.js` pins
  share → receive → camera-swap → teardown.

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
— an unmuted remote `<video>` paused by mobile autoplay policy, fixed by setting
`muted = true` on every tile. Don't conflate the two.

### Removed diagnostic scaffolding

Chasing #2 produced a lot of throwaway tooling that has since been deleted — don't be
surprised by references to it in old commit messages: the `?rtcdebug=1` on-screen
getStats HUD, an admin-panel "video debugging console" (a live camera/constraints lab
that persisted a `rivendell.videoConstraints` override), a `canvas.captureStream` send
pipeline, and an `applyConstraints` landscape-coercion ladder. All served their
diagnostic purpose and were removed to keep the surface small once the root cause (#2)
was understood as an upstream bug.

### What survives as standing policy

- **Capture:** `VIDEO_CONSTRAINTS = { frameRate: { ideal: 24 } }` — frame-rate ideal
  only, no spatial constraint (see #1).
- **Codec:** VP8-first (`orderVideoCodecsVP8First`) as a safe cross-browser default;
  it does **not** fix the freeze (#2).
- **Render:** `object-fit` on the tiles absorbs any aspect ratio.
- **Bandwidth:** the per-sender `maxBitrate` ceiling (`VIDEO_MAX_BITRATE_BPS`,
  800 kbps) is bandwidth hygiene, not a freeze cure. An earlier live bitrate cap was
  tried *as a fix for the freeze* and removed when it correctly didn't help — don't
  re-litigate it as one.

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
everywhere. An SFU/transcode step is explicitly out of scope (no media server).
Document any *new* device behaviour in the table above rather than re-litigating the
constraint stack.

## Out of scope

SFU/MCU (mesh preserved; add only if the video cap is regularly hit), recording,
end-to-end encrypted video beyond DTLS-SRTP, adaptive bitrate beyond REMB/TWCC,
virtual backgrounds / ML processing, and multi-camera layouts (no SFU = one video
track per person).
