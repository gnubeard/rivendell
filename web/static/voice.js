// voice.js — WebRTC audio calling for Rivendell.
//
// Phases 2–3: DM calls + multi-party voice channels (full P2P mesh).
// Phase 4: reconnection on peer failure via ICE restart (see that section below).
//
// Peer connection role: the participant with the LOWER numeric user_id is the
// offerer. This deterministic rule avoids signaling glare when both sides join
// at roughly the same time, without requiring a separate negotiation step.
// Layered on top is the standard Perfect Negotiation pattern for everything
// after initial setup (renegotiation, ICE restarts): the lower user_id is the
// IMPOLITE peer (its offer wins a collision), the higher user_id is the POLITE
// peer (it implicitly rolls back its own colliding offer and answers). See
// politeFor / onOffer / onnegotiationneeded.
//
// Topology: full P2P mesh (just two nodes in Phase 2). The server never touches
// media; it only relays offer/answer/ICE via the existing WS hub.

let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
let localStream = null;
let peerConns = new Map();    // remoteUserId -> RTCPeerConnection
let peerMeta = new Map();     // remoteUserId -> { restarts, timer } (reconnection bookkeeping)
let audioEls = new Map();     // remoteUserId -> <audio> element
let videoEls = new Map();     // remoteUserId -> <video> element
let localVideoEl = null;      // local preview <video> (muted, created on first camera use)
let cameraEnabled = false;    // camera state in current call
let activeChannelId = null;
let participants = [];         // latest voice.state roster for the active channel
let myUserId = null;
let muted = false;
let deafened = false;
let sendFn = null;            // (obj) -> void — socket.send wrapper
let onStateChange = null;     // ({inCall, channelId, muted, deafened, videoMuted}) -> void
let onSpeaking = null;        // (userId, speaking: bool) -> void — see setSpeakingCallback
let onCameraError = null;     // (err) -> void — surfaces a camera getUserMedia failure to the UI
let callHeartbeatTimer = null;

// dbg is the optional WebRTC telemetry hook (see rtcdebug.js). null unless the
// operator/client enabled debug telemetry, so production and the unit tests run
// with it absent and every dbg call below is a guarded no-op. Instrumentation
// only — it must never change call behavior.
let dbg = null;
export function registerDebug(hook) { dbg = hook; }
function dbgEvent(remoteUserId, kind, data) {
  if (dbg) { try { dbg.event(remoteUserId, kind, data); } catch { /* telemetry never throws into a call */ } }
}

// pendingIceCandidates buffers remote ICE candidates that arrive before
// setRemoteDescription has been called on a peer connection. This is a real
// race: onOffer/onAnswer are async (each await yields to the event loop), and
// trickle-ICE candidates from the remote can arrive during those gaps. Without
// the buffer the candidates are silently dropped, forcing the connection to
// rely on STUN retransmits to settle on a working path — which explains
// intermittent fragility on a network where the direct path would have worked.
// Drained immediately after setRemoteDescription; cleaned up in closePeer.
const pendingIceCandidates = new Map(); // remoteUserId -> RTCIceCandidateInit[]

// Camera preference is remembered PER channel (DM): "camera was on when we last
// hung up in this DM" auto-enables it on the next call to that same DM, while a
// brand-new DM (or one we always voice-call in) starts voice-only. Stored as a
// JSON map of channelId -> true; only camera-on entries are kept, so the absence
// of a key means voice-only. Saved on every toggle, so the stored value always
// equals the camera state at the moment the call ended.
const CAMERA_PREF_KEY = "rivendell.cameraEnabled";
function loadCameraPrefs() {
  try {
    const raw = localStorage.getItem(CAMERA_PREF_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    // Back-compat: an older build stored a single "1"/"0" global scalar. A
    // non-object parse is that legacy value — treat it as no per-channel prefs.
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}
function loadCameraPref(channelId) {
  return loadCameraPrefs()[channelId] === true;
}
function saveCameraPref(channelId, on) {
  if (channelId == null) return;
  try {
    const prefs = loadCameraPrefs();
    if (on) prefs[channelId] = true; else delete prefs[channelId];
    localStorage.setItem(CAMERA_PREF_KEY, JSON.stringify(prefs));
  } catch { /* localStorage unavailable (node tests / private mode) — non-fatal */ }
}
export function loadCameraPreference(channelId) { return loadCameraPref(channelId); }
// Self join/leave tones are fired from these lifecycle hooks rather than from
// onStateChange, but — crucially — they play INSIDE the live-capture window, in
// the same steady state where remote-peer tones already play loud and clear.
//
// History: earlier builds played the self-greet BEFORE getUserMedia and the
// self-farewell AFTER teardown, on the theory that the AEC was ducking output
// while capture was live. That theory was wrong: remote-peer tones fire during
// live capture and are loud, so steady-state output is NOT ducked. The real
// culprit is the audio-device TRANSITION at capture start/stop — opening the
// mic (with echoCancellation) and stopping the track both glitch the output
// device for a few hundred ms. The old placement put the self tones squarely in
// that transition (greet clipped to near-silence, farewell dropped). So we now
// do the opposite: greet AFTER the mic is live and settled, farewell BEFORE the
// mic is torn down — both safely inside steady-state capture.
let onSelfJoinTone = null;    // () -> void — fired after mic is live + settled
let onSelfLeaveTone = null;   // () -> void — fired before teardown, then we wait

// Timing for the self tones relative to the capture transitions (see above).
// SETTLE: how long to wait after getUserMedia resolves for the AEC pipeline to
// stabilize before greeting. FINISH: how long to let the farewell ring out
// while the mic is still live, before releasing it (the tone runs ~0.34s).
const SELF_TONE_SETTLE_MS = 250;
const SELF_TONE_FINISH_MS = 400;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Camera capture constraints. These are deliberately ideal-ONLY (advisory): an
// ideal constraint is best-effort and never rejects, whereas a `max` (mandatory
// ceiling) can make getUserMedia throw OverconstrainedError on cameras whose
// native capture modes can't satisfy the width/height/frameRate ceilings in
// combination — common on Android front cameras. (A `max` ceiling here was the
// v1.3.18 regression that broke Android video preview — getUserMedia rejected
// and the failure was swallowed.) Outgoing bandwidth is shaped by contentHint
// ("motion"), not by capping capture resolution, so constraining dimensions here
// would only risk a silent camera failure for no bandwidth gain.
//
// We impose NO spatial constraint — only a frame-rate ideal. This dodges an
// FF-Android quirk we measured directly: given any width/height ideal where
// width != height, FF-Android does NOT pick a matching native mode; it crops to
// a SQUARE whose side equals the requested HEIGHT (a `640x360` ideal yielded
// `360x360`, `640x480` yielded `480x480`). The Pixel 7 sensor is 4:3-only, so
// there is no 16:9 mode to land on; FF squares it instead, and its sender-side
// scaler then wedges on the 1:1 frame. Omitting width/height entirely leaves
// nothing to crop against, so the sensor opens its own native (non-square) 4:3
// mode. The tiles render whatever aspect arrives (object-fit, see style.css),
// so a 4:3 — or even a portrait — frame is fine.
const VIDEO_CONSTRAINTS = { frameRate: { ideal: 24 } };

// Per-sender outgoing video bitrate ceiling (RTCRtpSender.setParameters
// maxBitrate). This is a STABILITY cap for variable networks — it bounds what a
// single video sender may consume so a burst of motion can't saturate a phone's
// uplink and starve the audio/ICE path (the browser's REMB/TWCC congestion
// control still adapts freely *below* the ceiling). History note: an earlier
// live setParameters cap was tried as a fix for the FF-Android encoder freeze
// and removed when it (correctly) didn't help — that freeze is an upstream
// encoder bug (see docs/video.md). This cap is not a freeze cure and must not
// be re-litigated as one; it's bandwidth hygiene for the mesh.
// 800 kbps comfortably carries the ~360p-class video the mesh is sized for.
const VIDEO_MAX_BITRATE_BPS = 800000;

// Microphone capture constraints. Hoisted to module scope because the mid-call
// camera-enable path re-acquires a combined audio+video stream (see
// acquireCameraStream) and must request the mic identically to the join path.
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
};

// Ring-sound state. The incoming-call ringtone (callee) and the call-pending
// tone (caller waiting for pickup) are independent so they never share an
// interval — a single client is only ever one side of a ring, but keeping them
// separate is cheap and avoids any cross-talk.
let ringInterval = null;
let ringAudioCtx = null;
let ringTick = 0;             // counts ringtone repeats, to occasionally accent
let pendingInterval = null;
let pendingAudioCtx = null;

// --- speaking detection (AnalyserNode RMS metering) -----------------------
//
// One shared AudioContext feeds an AnalyserNode per participant stream (local
// mic + each remote). A single poll loop reads the time-domain samples, computes
// RMS, and flips a per-user "speaking" flag with hysteresis: it turns ON quickly
// (so a ring appears the moment you talk) and OFF lazily (so brief pauses between
// words don't flicker the ring). State changes are pushed via onSpeaking; app.js
// uses them to pulse a ring on that participant's roster row. This is pure
// metering — it never touches the audio path, so it can't affect what's heard.
let meterCtx = null;
let meterTimer = null;
const meters = new Map();     // userId -> { source, analyser, data, speaking, aboveSince, lastLoudAt }

// Tuning. THRESHOLD is RMS over a -1..1 time-domain frame; ~0.01 sits above the
// noise floor of a suppressed mic but below normal speech. Poll every 80ms.
const SPEAK_THRESHOLD = 0.012;
const SPEAK_POLL_MS = 80;
const SPEAK_ON_MS = 100;      // sustained loudness before the ring lights up
const SPEAK_OFF_MS = 500;     // sustained quiet before it goes dark

export function initVoice(myId, socketSend, stateChangeCb, selfJoinTone, selfLeaveTone) {
  myUserId = myId;
  sendFn = socketSend;
  onStateChange = stateChangeCb;
  onSelfJoinTone = selfJoinTone || null;
  onSelfLeaveTone = selfLeaveTone || null;
}

// fetchIceServers calls /api/rtc/credentials and caches the iceServers config.
export async function fetchIceServers() {
  try {
    const creds = await fetch("/api/rtc/credentials", { credentials: "same-origin" }).then(r => r.json());
    const servers = [{ urls: creds.stun }];
    if (creds.turn && creds.username && creds.credential) {
      servers.push({ urls: creds.turn, username: creds.username, credential: creds.credential });
    }
    iceServers = servers;
  } catch {
    // leave default STUN-only config
  }
  return iceServers;
}

// startCallHeartbeat sends a no-op WS frame every 45 s while a call is active.
// The server ignores the "heartbeat" type; the frame's arrival causes the Go
// readPump to loop and reset its 90 s read-deadline, preventing a spurious
// timeout disconnect on a call where no chat messages are sent.
function startCallHeartbeat() {
  stopCallHeartbeat();
  callHeartbeatTimer = setInterval(() => {
    if (activeChannelId !== null && sendFn) sendFn({ type: "heartbeat" });
  }, 45000);
}
function stopCallHeartbeat() {
  if (callHeartbeatTimer !== null) {
    clearInterval(callHeartbeatTimer);
    callHeartbeatTimer = null;
  }
}

// reconcilePeers closes any open RTCPeerConnection whose remote user_id is no
// longer in activeUserIds. Called by app.js after a WS reconnect to drop stale
// peers that left while our socket was down (and whose voice.state we missed).
export function reconcilePeers(activeUserIds) {
  const ids = new Set(activeUserIds);
  for (const userId of [...peerConns.keys()]) {
    if (!ids.has(userId)) closePeer(userId);
  }
}

// joinVoiceChannel acquires the microphone (and optionally the camera), informs
// the server (voice.join), and waits for voice.state updates to establish peer
// connections. Pass { enableVideo: true } to start with camera on; camera failure
// never blocks the call — we fall back to audio-only and clear cameraEnabled.
export async function joinVoiceChannel(channelId, { enableVideo = false } = {}) {
  if (activeChannelId === channelId) return;
  if (activeChannelId !== null) await leaveVoiceChannel();

  cameraEnabled = enableVideo;
  const audioConstraints = AUDIO_CONSTRAINTS;
  const videoConstraint = cameraEnabled ? VIDEO_CONSTRAINTS : false;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: videoConstraint });
  } catch (err) {
    if (cameraEnabled && shouldRetryRelaxed(err)) {
      // Camera couldn't satisfy our ideal constraints (common on Android) — retry
      // with the camera unconstrained before giving up on video. Mic + relaxed
      // video together; only if that also fails do we drop to audio-only.
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
      } catch {
        cameraEnabled = false;
        localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      }
    } else if (cameraEnabled) {
      // Permission denied for the camera — fall back to audio-only (relaxing
      // constraints wouldn't help) without blocking the call.
      cameraEnabled = false;
      localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    } else {
      throw err;
    }
  }

  // contentHint "motion" tells the encoder to prefer frame rate over detail,
  // which is the right trade-off for a camera video call.
  localStream.getVideoTracks().forEach(t => { t.contentHint = "motion"; });

  if (muted) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
  if (cameraEnabled) setupLocalVideo();

  // Meter our own mic so our roster row pulses while we talk (a disabled/muted
  // track reads as silence, so muting naturally clears our own speaking ring).
  addMeter(myUserId, localStream);

  activeChannelId = channelId;
  participants = []; // reset; the server's voice.state will populate the roster
  if (dbg) { try { dbg.startCall(channelId, myUserId); } catch { /* no-op */ } }
  sendFn({ type: "voice.join", channel_id: channelId });
  // Announce our real mute/camera state immediately. A fresh participant is
  // video-muted by default server-side (so peers never flash a video placeholder
  // before anyone turns a camera on), so a camera-on-at-join caller MUST correct
  // that to video_muted:false here or their video tile would never appear; a
  // mic-muted caller (mute persists across calls) likewise announces it.
  sendFn({ type: "voice.mute", channel_id: channelId, muted, video_muted: !cameraEnabled });
  startCallHeartbeat();
  notifyState();

  // Greet AFTER the mic is live and the AEC has settled — this lands the tone in
  // steady-state capture (where remote-peer tones play loud), not in the
  // capture-START device transition that clipped it to near-silence before.
  // Fire-and-forget via setTimeout so join doesn't block on the settle window.
  if (onSelfJoinTone) setTimeout(onSelfJoinTone, SELF_TONE_SETTLE_MS);
}

export async function leaveVoiceChannel() {
  if (activeChannelId === null) return;
  stopCallHeartbeat();
  const chId = activeChannelId;
  activeChannelId = null;
  participants = [];
  sendFn({ type: "voice.leave", channel_id: chId });
  notifyState();
  if (dbg) { try { dbg.endCall(); } catch { /* no-op */ } }
  // Farewell BEFORE teardown, while the capture is still live and the output
  // device is in the same steady state where remote-peer tones play loud. Then
  // wait for it to ring out before releasing the mic — stopping the track first
  // (as we used to) dropped the tone into the capture-STOP device transition.
  if (onSelfLeaveTone) onSelfLeaveTone();
  await delay(SELF_TONE_FINISH_MS);
  stopAllMeters();
  closeAllPeers();
  stopLocalStream();
  videoEls.clear();
}

// endCallLocally tears down our side of a call without telling the server we
// left. It's the response to a server voice.end (the other party in a DM hung
// up or dropped, ending the call for both) — we're already being removed
// server-side, so re-sending voice.leave would be redundant.
export async function endCallLocally() {
  if (activeChannelId === null) return;
  stopCallHeartbeat();
  activeChannelId = null;
  participants = [];
  notifyState();
  if (dbg) { try { dbg.endCall(); } catch { /* no-op */ } }
  // See leaveVoiceChannel: farewell BEFORE teardown so it plays in steady-state
  // capture, then wait for it to finish before releasing the mic.
  if (onSelfLeaveTone) onSelfLeaveTone();
  await delay(SELF_TONE_FINISH_MS);
  stopAllMeters();
  closeAllPeers();
  stopLocalStream();
  videoEls.clear();
}

export function setVoiceMuted(m) {
  muted = m;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  if (activeChannelId !== null) sendFn({ type: "voice.mute", channel_id: activeChannelId, muted, video_muted: !cameraEnabled });
  notifyState();
}

export function setVoiceDeafened(d) {
  deafened = d;
  audioEls.forEach(el => { el.muted = deafened; });
  notifyState();
}

// --- per-user volume (persisted playout gain) ------------------------------
//
// Each remote participant carries an independent playout volume in [0,1],
// applied as their <audio> element's .volume (1 = unchanged, 0 = silent —
// distinct from deafen, which mutes everyone at once). Volumes are keyed by
// user id and persisted to localStorage so a chronically quiet/loud friend
// stays adjusted across calls and reloads. The design doc floats a Web Audio
// GainNode, but since the range is 0–1 the element's own .volume is exactly
// equivalent and avoids routing remote WebRTC audio through Web Audio — which
// has a long-standing no-output bug in Chromium and would also fight the
// deafen path (.muted) and the metering AudioContext.
const VOLUME_STORE_KEY = "rivendell.voiceVolumes";
let volumes = loadVolumes();   // userId (number) -> 0..1

function loadVolumes() {
  const m = new Map();
  try {
    const raw = localStorage.getItem(VOLUME_STORE_KEY);
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) m.set(Number(k), clampVolume(v));
  } catch { /* localStorage unavailable (node tests / private mode) or corrupt */ }
  return m;
}

function persistVolumes() {
  try {
    const obj = {};
    for (const [k, v] of volumes) if (v !== 1) obj[k] = v; // only store non-defaults
    localStorage.setItem(VOLUME_STORE_KEY, JSON.stringify(obj));
  } catch { /* non-fatal — volume just won't persist this session */ }
}

// clampVolume coerces any input to a valid playout gain in [0,1]. Pure;
// exported for unit testing. Non-finite input falls back to 1 (unchanged).
export function clampVolume(v) {
  if (v == null) return 1;          // unset (null/undefined) -> unchanged
  v = Number(v);
  if (!Number.isFinite(v)) return 1;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// getVolumeForUser returns a user's stored playout gain, or 1 (unchanged).
export function getVolumeForUser(userId) {
  return volumes.has(userId) ? volumes.get(userId) : 1;
}

// setVolumeForUser sets, persists, and live-applies a user's playout gain.
export function setVolumeForUser(userId, vol) {
  const v = clampVolume(vol);
  volumes.set(userId, v);
  persistVolumes();
  const audio = audioEls.get(userId);
  if (audio) audio.volume = v;
}

// setCameraEnabled toggles the camera mid-call. When the video track already
// exists (camera was on at join), it just flips track.enabled — no renegotiation
// needed; we still send voice.mute so the server and peers know the new state.
// When no video track exists yet (camera was off at join), we re-acquire a single
// COMBINED audio+video stream, swap the audio track on every peer, add the video
// track (which fires onnegotiationneeded so the offerer re-offers transparently).
// Camera failure surfaces via onCameraError and leaves the call audio-only.
//
// Why combined rather than a lone getUserMedia({video}): on Android the camera and
// mic capture are coupled at the HAL level, so opening the camera as a SECOND,
// standalone capture session while the mic session from join is still live throws
// AbortError "Starting videoinput failed". Bundling both devices into one session
// is what the working join path already does.
//
// The crucial ordering: we RELEASE the original mic capture *before* acquiring the
// combined stream. The combined getUserMedia re-opens the mic too, and the audio
// HAL is exclusive on Android — so requesting it while the join-time mic session is
// still live makes the combined acquire itself fail ("Starting videoinput failed" /
// NotReadableError). Stopping the old audio after a successful acquire (as we used
// to) meant the acquire never succeeded on Android — that was the mid-call-camera
// bug. We keep a handle to the released track so a camera failure can re-acquire
// audio-only and keep the call alive rather than leaving it mute.
export async function setCameraEnabled(on) {
  if (!localStream || activeChannelId === null) return;
  const videoTracks = localStream.getVideoTracks();

  if (on && videoTracks.length === 0) {
    // First time enabling camera this call. RELEASE the live mic session first —
    // the combined acquire re-opens the mic, and on Android it can't start while
    // the old session still holds it (see the function comment above). We stash
    // the track so a camera failure can restore audio-only.
    const oldAudio = localStream.getAudioTracks()[0];
    if (oldAudio) { localStream.removeTrack(oldAudio); oldAudio.stop(); }

    let combined;
    try {
      combined = await acquireCameraStream();
    } catch (err) {
      // Camera unavailable — re-acquire the mic we just released so the call keeps
      // working audio-only, then surface why (the old silent return is exactly
      // what made a broken camera look like "nothing happens" on Android).
      try {
        const restored = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
        const a = restored.getAudioTracks()[0];
        if (a) {
          a.enabled = !muted;
          localStream.addTrack(a);
          for (const pc of peerConns.values()) {
            const audioSender = pc.getSenders().find(s => s.track && s.track.kind === "audio");
            if (audioSender) { try { await audioSender.replaceTrack(a); } catch {} }
          }
          addMeter(myUserId, localStream);
        }
      } catch { /* couldn't restore the mic either; report the camera error regardless */ }
      dbgEvent(0, "getusermedia-error", { name: err && err.name, where: "camera" });
      if (onCameraError) onCameraError(err);
      notifyState();
      return;
    }
    const vt = combined.getVideoTracks()[0];
    const newAudio = combined.getAudioTracks()[0];
    if (vt) vt.contentHint = "motion";
    if (newAudio) newAudio.enabled = !muted; // preserve current mute state

    // Swap each peer's audio sender to the new session's mic track (replaceTrack
    // is transparent — same m-line, no renegotiation), then add the video track
    // (this fires onnegotiationneeded; the offerer re-offers).
    for (const pc of peerConns.values()) {
      if (newAudio) {
        const audioSender = pc.getSenders().find(s => s.track && s.track.kind === "audio");
        if (audioSender) { try { await audioSender.replaceTrack(newAudio); } catch {} }
      }
      if (vt) pc.addTrack(vt, localStream);
    }

    // Adopt the new session's tracks into localStream (the original audio was
    // already removed and stopped above, before the acquire).
    if (newAudio) localStream.addTrack(newAudio);
    if (vt) localStream.addTrack(vt);

    // Re-meter our mic: the old analyser source pointed at the now-stopped track.
    addMeter(myUserId, localStream);

    cameraEnabled = true;
    saveCameraPref(activeChannelId, true);
    setupLocalVideo();
  } else if (videoTracks.length > 0) {
    // Track already exists: flip .enabled (no renegotiation required).
    videoTracks.forEach(t => { t.enabled = on; });
    cameraEnabled = on;
    saveCameraPref(activeChannelId, on);
    if (on) setupLocalVideo(); else teardownLocalVideo();
  }

  sendFn({ type: "voice.mute", channel_id: activeChannelId, muted, video_muted: !cameraEnabled });
  dbgEvent(0, "camera-toggle", { on: cameraEnabled });
  notifyState();
}

export function isCameraEnabled() { return cameraEnabled; }
export function getVideoEl(userId) { return videoEls.get(userId); }
export function getLocalVideoEl() { return localVideoEl; }

function setupLocalVideo() {
  if (typeof document === "undefined") return;
  if (!localVideoEl) {
    localVideoEl = document.createElement("video");
    localVideoEl.autoplay = true;
    localVideoEl.setAttribute("playsinline", "");
    localVideoEl.muted = true; // suppress audio echo from local preview
  }
  localVideoEl.srcObject = localStream;
}

function teardownLocalVideo() {
  if (localVideoEl) localVideoEl.srcObject = null;
}

// setSpeakingCallback registers cb(userId, speaking) for speaking-indicator UI.
export function setSpeakingCallback(cb) { onSpeaking = cb; }

// setCameraErrorCallback registers cb(err) to surface a camera getUserMedia
// failure to the user (mid-call camera enable). Without it the failure is silent.
export function setCameraErrorCallback(cb) { onCameraError = cb; }

export function isVoiceMuted() { return muted; }
export function isVoiceDeafened() { return deafened; }
export function voiceChannelId() { return activeChannelId; }
export function isInCall() { return activeChannelId !== null; }

// --- push-to-talk + mic-error helpers (pure) -------------------------------
//
// Push-to-talk itself (the keyboard wiring and the mute toggle) lives in
// app.js, because it ties keyboard input to setVoiceMuted; these two pure
// helpers are the parts worth unit-testing. See wirePushToTalk in app.js.

// pttShouldFire decides whether a keyboard event should drive push-to-talk:
// only when PTT is enabled, we're in a call, the event's *physical* key matches
// the bound code (KeyboardEvent.code, layout-independent), and the event did
// NOT originate from an editable element. The editable guard is what lets the
// bound key — backtick by default — still type normally in the message box:
// you transmit with it everywhere else, but in a text field it inserts a char.
export function pttShouldFire({ enabled, inCall, code, boundCode, editable }) {
  return !!(enabled && inCall && !editable && code && code === boundCode);
}

// pttKeyLabel turns a KeyboardEvent.code into a short human label for the UI
// ("Backquote" -> "`", "Space" -> "Space", "KeyT" -> "T", "Digit5" -> "5",
// "F8" -> "F8"). Unknown codes fall through verbatim. Pure; unit-tested.
export function pttKeyLabel(code) {
  if (!code) return "—";
  if (code === "Backquote") return "`";
  if (code === "Space") return "Space";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  if (code.startsWith("Arrow")) return code.slice(5) + " arrow";
  return code;
}

// micErrorMessage maps a getUserMedia rejection to a friendly, specific,
// actionable sentence (instead of dumping the raw exception text at the user).
// The error's .name is the stable cross-browser discriminator; we fall back to
// a generic line for anything unrecognized. Pure; unit-tested.
export function micErrorMessage(err) {
  switch (err && err.name) {
  case "NotAllowedError":      // permission denied (prompt dismissed or blocked)
  case "SecurityError":
    return "Microphone access was blocked. Allow the mic for this site in your browser's settings, then try again.";
  case "NotFoundError":        // no input device at all
  case "OverconstrainedError":
    return "No microphone was found. Plug one in (or check your input device) and try again.";
  case "NotReadableError":     // device held by another app / OS-level error
  case "AbortError":           // device failed to start (e.g. Android "Starting audioinput failed")
    return "Your microphone is in use by another app (or unavailable). Close anything else using it and try again.";
  default:
    return "Could not access the microphone" + (err && err.message ? ": " + err.message : ".");
  }
}

// cameraErrorMessage maps a getUserMedia camera rejection to a friendly sentence.
// Mirrors micErrorMessage but for video; pure, unit-tested.
export function cameraErrorMessage(err) {
  switch (err && err.name) {
  case "NotAllowedError":
  case "SecurityError":
    // No prompt + "blocked" despite the OS granting the browser camera access
    // means the browser is blocking THIS SITE (a separate, per-site permission).
    // On Firefox/Chrome for Android that's behind the shield/lock icon in the
    // address bar → Permissions → Camera; clearing "Blocked" there re-enables
    // the prompt. Point at that, not the OS-level app permission people check.
    return "Camera blocked for this site. Tap the lock/shield icon in the address bar → Permissions → Camera, clear the block, then reload and try again.";
  case "NotFoundError":
  case "OverconstrainedError":
    return "No camera was found. Plug one in (or check your input device) and try again.";
  case "NotReadableError":
  case "AbortError":           // device failed to start (Android "Starting videoinput failed")
    return "Your camera couldn't be started (it may be in use by another app). Close anything else using it, or leave and rejoin the call.";
  default:
    return "Could not access the camera" + (err && err.message ? ": " + err.message : ".");
  }
}

// shouldRetryRelaxed decides whether a failed camera getUserMedia is worth
// retrying with relaxed (unconstrained) settings. A permission denial won't be
// fixed by relaxing constraints, but an OverconstrainedError (the device can't
// satisfy our ideal width/height/frameRate) or a transient NotReadableError can
// resolve with a bare `video: true`. Pure; unit-tested.
export function shouldRetryRelaxed(err) {
  const name = err && err.name;
  return name !== "NotAllowedError" && name !== "SecurityError";
}

// acquireCameraStream gets a COMBINED audio+video MediaStream for the mid-call
// camera-enable path, falling back to an unconstrained `video: true` request if
// the constrained one fails for a reason relaxing might fix (see
// shouldRetryRelaxed). Requesting both devices in one getUserMedia call yields a
// single capture session — the lone-video second session is what fails with
// AbortError on Android (see setCameraEnabled). The mic is requested identically
// to the join path so the swapped-in audio track matches. Throws the original
// error if even the relaxed request fails (or if the failure was a permission
// denial). Internal.
async function acquireCameraStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: VIDEO_CONSTRAINTS });
  } catch (err) {
    if (!shouldRetryRelaxed(err)) throw err;
    return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: true });
  }
}

// handleVoiceSignal dispatches an incoming voice.* event received over the WS.
export async function handleVoiceSignal(evt) {
  const p = evt.payload || {};
  switch (evt.type) {
  case "voice.state":
    await onVoiceState(p);
    break;
  case "voice.offer":
    await onOffer(p);
    break;
  case "voice.answer":
    await onAnswer(p);
    break;
  case "voice.ice":
    await onICE(p);
    break;
  }
}

// --- reconnection on peer failure (ICE restart) ----------------------------
//
// WebRTC connections drop: a phone flips Wi-Fi→cellular, a NAT mapping expires,
// a router hiccups. The fix is an *ICE restart* — re-gather candidates and
// re-negotiate transport on the SAME RTCPeerConnection, preserving the media
// tracks and the established m-lines. It's far cheaper than tearing the peer
// down and rebuilding (which would also have to re-run the offerer election and
// re-attach audio elements/meters), and the remote barely notices.
//
// Policy (kept as two pure, unit-tested functions below):
//   - The OFFERER (lower user_id, see onVoiceState) drives the restart, so only
//     one side re-offers — no glare. createOffer({iceRestart:true}) on a stable
//     connection produces fresh ICE credentials; the answerer's existing onOffer
//     path renegotiates it transparently.
//   - "disconnected" often self-heals (a transient blip), so the offerer waits a
//     short grace before acting; "failed" is terminal for that ICE generation, so
//     it restarts immediately.
//   - The ANSWERER doesn't initiate; it waits for the offerer's new offer. As a
//     safety net it drops a peer that stays failed far too long (e.g. the offerer
//     is truly gone but the server hasn't yet pruned it from voice.state).
//   - Restarts are bounded (MAX_ICE_RESTARTS); past that, or once the peer has
//     left the roster, we give up and close the peer.
// "disconnected" may self-heal; wait before restarting. 5 s, not the original
// 2 s: now that iceConnectionState also feeds the reconnect plan (below), we see
// "disconnected" *earlier* — Firefox in particular reports it on the ICE state
// well before connectionState moves — and transient blips (Wi-Fi roam, brief
// relay hiccup, phone radio handover) routinely take 2–4 s to self-heal. A 2 s
// grace turned those into restart churn; 5 s rides them out while still
// reacting faster end-to-end than the old late-detection + 2 s ever did.
const ICE_DISCONNECT_GRACE_MS = 5000;
const ICE_RESTART_RETRY_MS = 4000;      // re-check cadence after a restart attempt
const ANSWERER_FAIL_TIMEOUT_MS = 20000; // answerer drops a peer stuck failed this long
const MAX_ICE_RESTARTS = 4;             // give up (close peer) after this many attempts

// reconnectPlan maps a connectionState (+ whether we're the offerer) to the timer
// action the state-change handler should take. Pure; exported for unit testing.
//   action "clear"   — healthy/closed: cancel any pending timer, reset attempts
//   action "restart" — arm a timer (after delayMs) to run an ICE restart
//   action "drop"    — arm a timer (after delayMs) to close a stuck peer
//   action "none"    — leave any existing timer running, do nothing
export function reconnectPlan(connectionState, isOfferer) {
  switch (connectionState) {
  case "connected":
  case "completed":
  case "closed":
    return { action: "clear" };
  case "disconnected":
    return isOfferer ? { action: "restart", delayMs: ICE_DISCONNECT_GRACE_MS } : { action: "none" };
  case "failed":
    return isOfferer ? { action: "restart", delayMs: 0 } : { action: "drop", delayMs: ANSWERER_FAIL_TIMEOUT_MS };
  default:
    return { action: "none" };
  }
}

// restartOutcome decides what a fired restart timer should do, given the peer's
// current connectionState, how many restarts we've already spent, and whether the
// peer is still in the roster. Pure; exported for unit testing.
//   "recovered" — connection healed (or was torn down) since the timer armed
//   "gone"      — peer left the voice channel; close it
//   "give-up"   — exhausted MAX_ICE_RESTARTS; close it
//   "restart"   — perform another ICE restart
export function restartOutcome(connectionState, restarts, maxRestarts, inRoster) {
  if (connectionState === "connected" || connectionState === "completed" || connectionState === "closed") return "recovered";
  if (!inRoster) return "gone";
  if (restarts >= maxRestarts) return "give-up";
  return "restart";
}

function isOfferer(remoteUserId) { return myUserId < remoteUserId; }

// politeFor decides which side is the "polite" peer under Perfect Negotiation
// (https://w3c.github.io/webrtc-pc/#perfect-negotiation-example): the HIGHER
// user_id. This is the same deterministic rule as the offerer election, seen
// from the other end — the lower user_id stays the initial offerer and the
// impolite peer (it ignores colliding offers), the higher user_id is the
// answerer and the polite peer (it rolls back its own offer and answers).
// Pure; exported for unit testing.
export function politeFor(myId, remoteId) { return myId > remoteId; }

// effectiveConnectionState folds connectionState and iceConnectionState into the
// single worst-of state the reconnect plan should act on. Rationale: the two
// state machines disagree in exactly the window that matters — Firefox moves
// iceConnectionState to "disconnected"/"failed" well before connectionState
// follows (sometimes connectionState never reaches "failed" at all), so a plan
// keyed on connectionState alone reacts late or not at all. "closed" is read
// only from connectionState (iceConnectionState "closed" is deprecated and
// unreliable). Pure; exported for unit testing.
export function effectiveConnectionState(connectionState, iceConnectionState) {
  if (connectionState === "closed") return "closed";
  if (connectionState === "failed" || iceConnectionState === "failed") return "failed";
  if (connectionState === "disconnected" || iceConnectionState === "disconnected") return "disconnected";
  return connectionState;
}

// armTimer schedules fn after delayMs, unless a reconnect timer is already in
// flight for this peer (a recovery/retry cycle owns the single per-peer slot).
function armTimer(meta, delayMs, fn) {
  if (!meta || meta.timer) return;
  meta.timer = setTimeout(() => { meta.timer = null; fn(); }, delayMs);
}

function clearReconnectTimer(meta) {
  if (meta && meta.timer) { clearTimeout(meta.timer); meta.timer = null; }
}

// applyReconnectPlan runs the reconnectPlan for a peer's current state. Both
// onconnectionstatechange and oniceconnectionstatechange funnel here; the plan
// is keyed on the worst-of effectiveConnectionState so whichever state machine
// notices trouble first (Firefox: the ICE one) drives the reaction.
function applyReconnectPlan(remoteUserId, pc) {
  const meta = peerMeta.get(remoteUserId);
  if (!meta) return;
  const state = effectiveConnectionState(pc.connectionState, pc.iceConnectionState);
  const plan = reconnectPlan(state, isOfferer(remoteUserId));
  switch (plan.action) {
  case "clear":
    clearReconnectTimer(meta);
    meta.restarts = 0;
    break;
  case "restart":
    armTimer(meta, plan.delayMs, () => doIceRestart(remoteUserId));
    break;
  case "drop":
    armTimer(meta, plan.delayMs, () => {
      const p = peerConns.get(remoteUserId);
      if (!p) return;
      const st = effectiveConnectionState(p.connectionState, p.iceConnectionState);
      if (st === "failed" || st === "disconnected") {
        closePeer(remoteUserId);
        if (activeChannelId !== null) sendFn({ type: "voice.join", channel_id: activeChannelId });
      }
    });
    break;
  // "none": leave any existing timer running
  }
}

// doIceRestart re-offers with fresh ICE on the existing peer connection (offerer
// side), or gives up / closes the peer per restartOutcome. Re-arms itself to
// re-check after a cadence, so a restart that doesn't take is retried or abandoned.
async function doIceRestart(remoteUserId) {
  const pc = peerConns.get(remoteUserId);
  const meta = peerMeta.get(remoteUserId);
  if (!pc || !meta || activeChannelId === null) return;
  const inRoster = participants.some(p => p.user_id === remoteUserId);
  const state = effectiveConnectionState(pc.connectionState, pc.iceConnectionState);
  const outcome = restartOutcome(state, meta.restarts, MAX_ICE_RESTARTS, inRoster);
  if (outcome === "recovered") { meta.restarts = 0; return; }
  if (outcome === "gone") { closePeer(remoteUserId); return; }
  if (outcome === "give-up") {
    dbgEvent(remoteUserId, "ice-restart-giveup", { restarts: meta.restarts });
    closePeer(remoteUserId);
    // Re-announce our presence so the server broadcasts a fresh voice.state.
    // Both sides are still in the channel; onVoiceState will re-create the peer
    // connection from scratch, which is exactly what a manual "refresh" would do.
    if (activeChannelId !== null) sendFn({ type: "voice.join", channel_id: activeChannelId });
    return;
  }
  // outcome === "restart": only the offerer re-offers (answerer waits for it).
  meta.restarts++;
  if (isOfferer(remoteUserId)) {
    dbgEvent(remoteUserId, "ice-restart-attempt", { attempt: meta.restarts, conn: pc.connectionState });
    try {
      // makingOffer marks the Perfect Negotiation collision window for this
      // manual (non-negotiationneeded) offer too, so a crossing remote offer is
      // correctly ignored by us (impolite side) instead of mis-answered.
      meta.makingOffer = true;
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      sendFn({ type: "voice.offer", to_user_id: remoteUserId, channel_id: activeChannelId, sdp: offer.sdp });
    } catch { /* re-check below will retry */ }
    finally { meta.makingOffer = false; }
  }
  armTimer(meta, ICE_RESTART_RETRY_MS, () => doIceRestart(remoteUserId));
}

// --- peer connection lifecycle --------------------------------------------

// drainPendingCandidates replays any ICE candidates that arrived before
// setRemoteDescription was called. Must be called immediately after every
// setRemoteDescription so the connection gets the full candidate set.
async function drainPendingCandidates(remoteUserId) {
  const q = pendingIceCandidates.get(remoteUserId);
  if (!q || q.length === 0) return;
  pendingIceCandidates.delete(remoteUserId);
  const pc = peerConns.get(remoteUserId);
  if (!pc) return;
  for (const c of q) {
    try { await pc.addIceCandidate(c); } catch {}
  }
}

// orderVideoCodecsVP8First returns a copy of an RTCRtpCodecCapability list
// reordered so VP8 (then VP9) precede H.264, preserving every codec and the
// relative order within a rank (so rtx/red/ulpfec are retained). Pure — exported
// for unit testing.
//
// Why VP8 first: it is mandatory-to-implement and the most reliable cross-browser
// path. A VP9 experiment regressed the laptop sender, so we returned to VP8 as the
// default and keep H.264 last. (FF-Android exposes no H.264 at all, so the ordering
// is moot there — but it costs nothing and keeps other browsers off H.264.)
//
// NOTE: codec order does NOT fix the long-standing FF-Android "few frames then
// freeze" — it reproduced identically on every codec FF-Android offers (VP8, VP9).
// That turned out to be an upstream Firefox-stable encoder bug (it works on Firefox
// Android *nightly*); nothing in this codebase cures it. The preference is just a
// safe cross-browser default, not a freeze workaround.
export function orderVideoCodecsVP8First(codecs) {
  if (!Array.isArray(codecs)) return [];
  const rank = (c) => {
    const m = (c && c.mimeType ? c.mimeType : "").toLowerCase();
    if (m === "video/vp8") return 0;
    if (m === "video/vp9") return 1;
    if (m === "video/h264") return 3;
    return 2; // rtx/red/ulpfec and anything else keep the middle, relative order
  };
  return codecs
    .map((c, i) => [c, i])
    .sort((a, b) => (rank(a[0]) - rank(b[0])) || (a[1] - b[1]))
    .map(([c]) => c);
}

// videoCodecPreferenceList builds (once, cached) the VP8-first capability list
// from the receiver's supported codecs. Empty on browsers without
// getCapabilities — preferVideoCodec then no-ops and default negotiation stands.
let preferredVideoCodecs = null;
function videoCodecPreferenceList() {
  if (preferredVideoCodecs !== null) return preferredVideoCodecs;
  preferredVideoCodecs = [];
  try {
    const caps = RTCRtpReceiver.getCapabilities("video");
    if (caps && caps.codecs) preferredVideoCodecs = orderVideoCodecsVP8First(caps.codecs);
  } catch { /* leave empty -> no preference applied */ }
  return preferredVideoCodecs;
}

// preferVideoCodec reorders each video transceiver's codec list VP8-first. Must
// run before createOffer/createAnswer to land in the SDP; idempotent, so calling
// it on both peers and on every (re)negotiation is safe. No-op without
// setCodecPreferences (older Safari).
function preferVideoCodec(pc) {
  const codecs = videoCodecPreferenceList();
  if (!codecs.length) return;
  for (const t of pc.getTransceivers()) {
    const kind = t.sender?.track?.kind || t.receiver?.track?.kind;
    if (kind !== "video") continue;
    try { t.setCodecPreferences(codecs); } catch { /* unsupported / rejected list */ }
  }
}

// withVideoBitrateCap returns a copy of an RTCRtpSendParameters with maxBitrate
// set on every encoding, or null when there is nothing to do — params missing,
// encodings absent/empty (the array is only populated once negotiation has
// materialized the sender, and the spec forbids *adding* encodings via
// setParameters), or every encoding already carries the cap. Returning null
// lets the caller skip a pointless setParameters round-trip; the cap is then
// re-attempted at the next call site (post-negotiation / on connected). Never
// mutates its input. Pure; exported for unit testing.
export function withVideoBitrateCap(params, maxBitrate) {
  if (!params || !Array.isArray(params.encodings) || params.encodings.length === 0) return null;
  let changed = false;
  const encodings = params.encodings.map(e => {
    if (e && e.maxBitrate === maxBitrate) return e;
    changed = true;
    return { ...e, maxBitrate };
  });
  if (!changed) return null;
  return { ...params, encodings };
}

// applyVideoBitrateCaps caps every video sender on a peer connection at
// VIDEO_MAX_BITRATE_BPS (see that constant for the rationale). Idempotent and
// best-effort: pre-negotiation senders report empty encodings and are skipped
// (withVideoBitrateCap returns null), so this is called wherever encodings may
// have just materialized — after each completed offer/answer exchange and on
// the connection reaching "connected". A setParameters failure never touches
// the call.
function applyVideoBitrateCaps(pc) {
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== "video") continue;
    let params;
    try { params = sender.getParameters(); } catch { continue; }
    const capped = withVideoBitrateCap(params, VIDEO_MAX_BITRATE_BPS);
    if (!capped) continue;
    try { Promise.resolve(sender.setParameters(capped)).catch(() => {}); } catch { /* best-effort */ }
  }
}

async function onVoiceState(payload) {
  if (payload.channel_id !== activeChannelId) return;
  participants = payload.participants || [];
  const remoteIds = new Set(participants.filter(p => p.user_id !== myUserId).map(p => p.user_id));

  // Surface the updated roster so app.js can paint who's connected and chime on
  // join/leave. Done before the (async) peer setup so the UI reacts promptly.
  notifyState();

  // Create connections to new participants.
  for (const p of participants) {
    if (p.user_id === myUserId) continue;
    if (!peerConns.has(p.user_id)) {
      const pc = createPC(p.user_id);
      // Lower user_id is the offerer. The explicit offer here (rather than
      // waiting for onnegotiationneeded) keeps the initial connection setup
      // deterministic and one-round; makingOffer marks the Perfect Negotiation
      // collision window so a crossing offer from the peer is handled correctly.
      if (myUserId < p.user_id) {
        const meta = peerMeta.get(p.user_id);
        try {
          if (meta) meta.makingOffer = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendFn({ type: "voice.offer", to_user_id: p.user_id, channel_id: activeChannelId, sdp: offer.sdp });
          dbgEvent(p.user_id, "offer-sent", { reason: "join" });
        } catch { /* peer setup failure; reconnect/ICE paths will recover or close */ }
        finally { if (meta) meta.makingOffer = false; }
      }
    }
  }

  // Close connections for participants who left.
  for (const userId of [...peerConns.keys()]) {
    if (!remoteIds.has(userId)) closePeer(userId);
  }

  // An empty roster means the server wiped the channel (endDMVoiceCall /
  // VoiceClear). Treat it as a server-side teardown: end locally without
  // re-sending voice.leave (the server already removed us). This is the
  // fallback for when voice.end was lost in transit (e.g. a WS drop between
  // the targeted SendToUser and the client reconnecting).
  if (participants.length === 0 && activeChannelId !== null) {
    endCallLocally();
  }
}

async function onOffer(payload) {
  if (activeChannelId === null) return;
  const fromId = payload.from_user_id;
  let pc = peerConns.get(fromId);
  if (!pc) pc = createPC(fromId);
  const meta = peerMeta.get(fromId);
  dbgEvent(fromId, "offer-recv", {});
  // Perfect Negotiation (w3c webrtc-pc §perfect-negotiation-example), with the
  // deterministic role mapping documented at the top of the file: the lower
  // user_id is the impolite peer, the higher is polite (politeFor). A collision
  // is "we're mid-offer ourselves" — either the offer is still being created
  // (makingOffer, signaling still stable) or it's already local
  // (have-local-offer). The impolite peer IGNORES the colliding remote offer
  // (its own offer wins; the polite peer will answer it). The polite peer
  // accepts it: setRemoteDescription(offer) in have-local-offer performs an
  // implicit rollback of our own offer first (supported by all evergreen
  // engines; this replaced the old explicit {type:"rollback"} dance, which
  // couldn't cover the makingOffer-but-still-stable half of the window).
  const polite = politeFor(myUserId, fromId);
  const collision = (meta && meta.makingOffer) || pc.signalingState !== "stable";
  if (meta) meta.ignoreOffer = !polite && collision;
  if (meta && meta.ignoreOffer) { dbgEvent(fromId, "glare-ignore", {}); return; }
  if (collision) dbgEvent(fromId, "glare-rollback", {});
  await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
  await drainPendingCandidates(fromId); // apply any buffered trickle-ICE candidates
  preferVideoCodec(pc); // VP8-first on transceivers materialized by the remote offer
  await pc.setLocalDescription(); // no-arg: implicit createAnswer
  sendFn({ type: "voice.answer", to_user_id: fromId, channel_id: activeChannelId, sdp: pc.localDescription.sdp });
  applyVideoBitrateCaps(pc); // encodings exist once the answer is local
  dbgEvent(fromId, "answer-sent", {});
}

async function onAnswer(payload) {
  const fromId = payload.from_user_id;
  const pc = peerConns.get(fromId);
  if (!pc || pc.signalingState !== "have-local-offer") return;
  await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
  await drainPendingCandidates(fromId); // apply any buffered trickle-ICE candidates
  applyVideoBitrateCaps(pc); // offer/answer complete — sender encodings are live
  dbgEvent(fromId, "answer-recv", {});
}

async function onICE(payload) {
  const fromId = payload.from_user_id;
  const pc = peerConns.get(fromId);
  if (!pc || !payload.candidate) return;
  if (!pc.remoteDescription) {
    // onOffer/onAnswer are async: they yield during setRemoteDescription, and
    // trickle-ICE candidates from the peer arrive during that window. Buffer
    // them here and drain immediately after setRemoteDescription resolves.
    let q = pendingIceCandidates.get(fromId);
    if (!q) { q = []; pendingIceCandidates.set(fromId, q); }
    q.push(payload.candidate);
    return;
  }
  // Errors are swallowed deliberately: under Perfect Negotiation, candidates
  // belonging to an offer we just IGNORED (meta.ignoreOffer) are expected to
  // fail addIceCandidate — they describe a description we never applied.
  try { await pc.addIceCandidate(payload.candidate); } catch {}
}

function createPC(remoteUserId) {
  const pc = new RTCPeerConnection({ iceServers });
  peerConns.set(remoteUserId, pc);
  // Per-peer bookkeeping: reconnect (restarts/timer) + Perfect Negotiation
  // (makingOffer marks the local-offer-in-flight window; ignoreOffer records
  // that we dropped the peer's colliding offer, so its trailing ICE candidates
  // are expected to fail).
  peerMeta.set(remoteUserId, { restarts: 0, timer: null, makingOffer: false, ignoreOffer: false });
  if (dbg) { try { dbg.attachPeer(remoteUserId, pc); } catch { /* no-op */ } }

  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }
  // Prefer VP8 on any video transceiver addTrack just created (offerer side).
  preferVideoCodec(pc);

  pc.onicecandidate = (e) => {
    if (e.candidate && activeChannelId !== null) {
      sendFn({ type: "voice.ice", to_user_id: remoteUserId, channel_id: activeChannelId, candidate: e.candidate.toJSON() });
    }
  };

  pc.ontrack = (e) => {
    if (e.track.kind === "audio") {
      let audio = audioEls.get(remoteUserId);
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        audio.muted = deafened;
        audio.volume = getVolumeForUser(remoteUserId); // restore any saved per-user level
        document.body.appendChild(audio);
        audioEls.set(remoteUserId, audio);
      }
      if (e.streams[0]) {
        audio.srcObject = e.streams[0];
        addMeter(remoteUserId, e.streams[0]); // pulse their row while they talk
      }
    } else if (e.track.kind === "video") {
      let video = videoEls.get(remoteUserId);
      if (!video) {
        video = document.createElement("video");
        video.autoplay = true;
        video.setAttribute("playsinline", "");
        // MUTED is mandatory, not cosmetic. Mobile autoplay policy (Firefox and
        // Chrome on Android) refuses to play a media element that produces sound
        // unless the play() call rides a user gesture. The remote MediaStream
        // carries an audio track, so an UNMUTED <video> decodes its first frame
        // and then sits paused forever — the remote tile renders one frame and
        // freezes (audio keeps flowing because it plays through the SEPARATE
        // <audio> element below, which is why the call sounds fine). That "one
        // frame and done" symptom survived every codec change because it was
        // never an encoder stall on the sender; it was a paused element on the
        // receiver. Muting the tile loses nothing (audio is on its own element)
        // and lets autoplay / play() actually start the video.
        video.muted = true;
        videoEls.set(remoteUserId, video);
      }
      if (e.streams[0]) {
        video.srcObject = e.streams[0];
        video.play?.().catch(() => {}); // kick playback now; renderVideoGrid also retries
      }
      notifyState(); // app.js re-renders the video grid
    }
  };

  // Renegotiation (mid-call camera enable, ICE restart fallback, future screen
  // share): addTrack fires onnegotiationneeded and we offer. EITHER peer may
  // need to renegotiate — whoever adds the track must be the one to offer,
  // because a fresh offer carries only the offerer's own m-lines. So this is
  // NOT gated on isOfferer: the deterministic offerer rule governs the
  // *initial* setup only; simultaneous renegotiations are resolved by Perfect
  // Negotiation in onOffer (impolite lower-id offer wins, polite higher-id
  // rolls back implicitly and answers). makingOffer brackets the whole
  // create-and-set window so a remote offer crossing it is detected as a
  // collision even before our offer reaches have-local-offer.
  pc.onnegotiationneeded = async () => {
    if (activeChannelId === null) return;
    // Per spec the event only fires in "stable"; the guard stays because older
    // engines have misfired it (e.g. during a parallel ICE restart). Skipping
    // is safe — the browser re-fires once back in stable if still needed.
    if (pc.signalingState !== "stable") return;
    const meta = peerMeta.get(remoteUserId);
    try {
      if (meta) meta.makingOffer = true;
      preferVideoCodec(pc); // VP8-first on the newly-added video track
      await pc.setLocalDescription(); // no-arg: implicit createOffer
      sendFn({ type: "voice.offer", to_user_id: remoteUserId, channel_id: activeChannelId, sdp: pc.localDescription.sdp });
      dbgEvent(remoteUserId, "offer-sent", { reason: "reneg" });
    } catch {}
    finally { if (meta) meta.makingOffer = false; }
  };

  // BOTH state machines feed the reconnect plan via the worst-of
  // effectiveConnectionState. The ICE one matters because Firefox reports
  // disconnected/failed there first (sometimes connectionState never reaches
  // "failed" at all) — keying on connectionState alone reacted late or never.
  pc.oniceconnectionstatechange = () => {
    dbgEvent(remoteUserId, "iceconnectionstatechange", { ice: pc.iceConnectionState });
    applyReconnectPlan(remoteUserId, pc);
  };

  // Reconnect rather than tear down on trouble: an ICE restart re-negotiates
  // transport on this same connection. See the reconnection section above.
  pc.onconnectionstatechange = () => {
    dbgEvent(remoteUserId, "connectionstatechange", { conn: pc.connectionState });
    if (pc.connectionState === "connected") applyVideoBitrateCaps(pc); // encodings are definitely live now
    applyReconnectPlan(remoteUserId, pc);
  };

  return pc;
}

function closePeer(userId) {
  if (dbg) { try { dbg.detachPeer(userId); } catch { /* no-op */ } }
  pendingIceCandidates.delete(userId);
  removeMeter(userId);
  const meta = peerMeta.get(userId);
  if (meta) { clearReconnectTimer(meta); peerMeta.delete(userId); }
  const pc = peerConns.get(userId);
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onnegotiationneeded = null;
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch {}
    peerConns.delete(userId);
  }
  const audio = audioEls.get(userId);
  if (audio) {
    audio.srcObject = null;
    audio.remove();
    audioEls.delete(userId);
  }
  const video = videoEls.get(userId);
  if (video) {
    video.srcObject = null;
    videoEls.delete(userId);
  }
}

function closeAllPeers() {
  for (const uid of [...peerConns.keys()]) closePeer(uid);
}

function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  teardownLocalVideo();
  cameraEnabled = false;
}

function notifyState() {
  if (onStateChange) onStateChange({
    inCall: activeChannelId !== null,
    channelId: activeChannelId,
    muted,
    deafened,
    videoMuted: !cameraEnabled,
    participants: participants.map(p => ({ user_id: p.user_id, muted: !!p.muted, video_muted: !!p.video_muted })),
  });
}

// --- speaking detection ----------------------------------------------------

// computeRMS returns the root-mean-square amplitude of a time-domain frame
// (Float32 samples in -1..1). Pure — exported for unit testing.
export function computeRMS(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// addMeter attaches an AnalyserNode to a participant's stream and starts the
// shared poll loop. Idempotent per user (replacing any prior meter).
function addMeter(userId, stream) {
  if (!stream) return;
  if (typeof AudioContext === "undefined" && typeof webkitAudioContext === "undefined") return;
  removeMeter(userId);
  try {
    if (!meterCtx) {
      const Ctx = typeof AudioContext !== "undefined" ? AudioContext : webkitAudioContext;
      meterCtx = new Ctx();
    }
    const source = meterCtx.createMediaStreamSource(stream);
    const analyser = meterCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser); // analyser is NOT connected to destination: metering only
    meters.set(userId, {
      source, analyser,
      data: new Float32Array(analyser.fftSize),
      speaking: false, aboveSince: 0, lastLoudAt: 0,
    });
    if (!meterTimer) meterTimer = setInterval(pollMeters, SPEAK_POLL_MS);
  } catch {
    // metering is best-effort; a failure here must never break the call
  }
}

function removeMeter(userId) {
  const m = meters.get(userId);
  if (!m) return;
  try { m.source.disconnect(); } catch {}
  try { m.analyser.disconnect(); } catch {}
  meters.delete(userId);
  if (m.speaking) emitSpeaking(userId, false);
  if (meters.size === 0) stopMeterLoop();
}

function stopMeterLoop() {
  clearInterval(meterTimer);
  meterTimer = null;
  if (meterCtx) {
    try { meterCtx.close(); } catch {}
    meterCtx = null;
  }
}

function stopAllMeters() {
  for (const uid of [...meters.keys()]) removeMeter(uid);
  stopMeterLoop();
}

// pollMeters reads each analyser once and applies the on/off hysteresis.
function pollMeters() {
  const now = Date.now();
  for (const [userId, m] of meters) {
    m.analyser.getFloatTimeDomainData(m.data);
    const loud = computeRMS(m.data) > SPEAK_THRESHOLD;
    if (loud) {
      if (m.aboveSince === 0) m.aboveSince = now;
      m.lastLoudAt = now;
    } else {
      m.aboveSince = 0;
    }
    let next = m.speaking;
    if (!m.speaking && loud && now - m.aboveSince >= SPEAK_ON_MS) next = true;
    else if (m.speaking && now - m.lastLoudAt >= SPEAK_OFF_MS) next = false;
    if (next !== m.speaking) {
      m.speaking = next;
      emitSpeaking(userId, next);
    }
  }
}

function emitSpeaking(userId, speaking) {
  if (onSpeaking) try { onSpeaking(userId, speaking); } catch {}
}

// --- ring sound -----------------------------------------------------------

// startRingSound plays the incoming-call ringtone (what the *callee* hears):
// a light, floaty arpeggio of harmonious tones, every few rings adding a
// brighter accent to grab attention. Pass the shared AudioContext from app.js
// (already primed by a user gesture).
export function startRingSound(audioCtx) {
  if (ringInterval) stopRingSound();
  ringAudioCtx = audioCtx;
  ringTick = 0;
  playRingTone(audioCtx, ringTick);
  ringInterval = setInterval(() => playRingTone(ringAudioCtx, ++ringTick), 3000);
}

export function stopRingSound() {
  clearInterval(ringInterval);
  ringInterval = null;
  ringAudioCtx = null;
  ringTick = 0;
}

// startPendingSound plays the call-pending tone (what the *caller* hears while
// waiting for the other party to pick up): the old two-tone phone ring, which
// reads naturally as a "we're dialing, hold on" sound. Repeats every 3s.
export function startPendingSound(audioCtx) {
  if (pendingInterval) stopPendingSound();
  pendingAudioCtx = audioCtx;
  playPendingTone(audioCtx);
  pendingInterval = setInterval(() => playPendingTone(pendingAudioCtx), 3000);
}

export function stopPendingSound() {
  clearInterval(pendingInterval);
  pendingInterval = null;
  pendingAudioCtx = null;
}

// playRingTone: a gentle ascending arpeggio over a major-sixth chord (C–E–G–A),
// sine waves with a slow attack and long release so the notes bloom and overlap
// — floaty and harmonious. Every third ring (tick % 3 === 2) adds a sharp,
// bright accent an octave up to catch a distracted ear.
function playRingTone(ctx, tick) {
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") ctx.resume();
    const t0 = ctx.currentTime;
    // Major sixth: C5, E5, G5, A5 — all consonant, pleasant rising shimmer.
    const notes = [523.25, 659.25, 783.99, 880.0];
    notes.forEach((freq, i) => {
      const t = t0 + i * 0.16;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.07, t + 0.06); // soft bloom
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9); // long float-out
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.95);
    });
    // Occasional sharp accent: a brief, brighter triangle ping up high.
    if (tick % 3 === 2) {
      const t = t0 + 0.64;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = 1318.51; // E6 — sits an octave above the arpeggio
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.01); // fast, sharp attack
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    }
  } catch {}
}

// playPendingTone: the classic two-tone phone ring (480/440 Hz), kept verbatim
// from the old ringtone — now the caller-side "waiting for pickup" sound.
function playPendingTone(ctx) {
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;
    for (const freq of [480, 440]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.10, t + 0.02);
      gain.gain.setValueAtTime(0.10, t + 0.38);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.45);
    }
  } catch {}
}
