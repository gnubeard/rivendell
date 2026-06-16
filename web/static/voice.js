// voice.js — WebRTC audio calling for rivendell.
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
let cameraEnabled = false;    // "sending video" master for the current call (camera OR screen)
let videoIsScreen = false;    // when sending video, is the source the screen (getDisplayMedia) vs the camera?
let listenOnly = false;       // joined without a usable mic: we receive only (no local capture, recvonly peers)
let screenAudioTrack = null;  // the tab/system audio track captured alongside a screen share (Chrome only), or null
let activeChannelId = null;
// callGen is bumped on every join. Call teardown (leave/end) defers the mic +
// meter release behind the farewell-tone wait; if a new call starts during that
// window it bumps callGen, and the stale teardown skips releasing what now
// belongs to the new call (it stops only the old stream it captured). Without
// this, a quick hang-up-then-call reused/clobbered the new call's peer + mic.
let callGen = 0;
let participants = [];         // latest voice.state roster for the active channel
let myUserId = null;
let muted = false;
let deafened = false;
let sendFn = null;            // (obj) -> void — socket.send wrapper
let onStateChange = null;     // ({inCall, channelId, muted, deafened, videoMuted}) -> void
let onSpeaking = null;        // (userId, speaking: bool) -> void — see setSpeakingCallback
let onCameraError = null;     // (err) -> void — surfaces a camera getUserMedia failure to the UI
let callHeartbeatTimer = null;
let congestionTimer = null;   // AIMD video-bitrate monitor (see monitorCongestion)

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
// 800 kbps comfortably carries the ~360p-class video the mesh is sized for, and
// is the per-sender CEILING — a 1:1 call (one video sender) gets exactly this.
const VIDEO_MAX_BITRATE_BPS = 800000;

// Group-call uplink budgeting. In a full mesh each peer connection has its own
// encoder, so a node sending camera to (N-1) peers spends (N-1)× its per-sender
// bitrate on the uplink. To keep total outbound video within a phone's modest
// uplink we divide a fixed TOTAL budget across the active video senders and floor
// each so a crowded call still shows *something*. The per-sender result never
// exceeds VIDEO_MAX_BITRATE_BPS, so the 1:1 / 2-party case is unchanged (full
// 800 kbps); it only shrinks as the roster grows:
//   N=2 → 800k   N=3 → 800k   N=4 → 533k   N=5 → 400k   N=6 → 320k
// (TOTAL ÷ (N-1) senders, ceilinged at 800k, floored at 150k — total uplink
// stays ≤ TOTAL once there are ≥2 senders). Re-applied whenever the roster
// changes in onVoiceState, not only after (re)negotiation.
const TOTAL_VIDEO_UPLINK_BPS = 1600000;
const MIN_VIDEO_BITRATE_BPS = 150000;

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

// (The incoming-call ring and call-pending tones live in tones.js with the rest
// of the client's Web Audio synthesis; voice.js no longer owns any of them.)

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

  // Preflight: if the context can't reach capture at all — an insecure (non-HTTPS)
  // origin strips navigator.mediaDevices, and some embedded WebViews never expose
  // it — bail with a clear, actionable line instead of letting getUserMedia throw
  // an opaque TypeError ("undefined is not an object"). The standalone-PWA caveat
  // is NOT blocked here (mediaDevices exists there); it rides on the failure
  // message via micErrorMessage/cameraErrorMessage. See preflightMediaError.
  const envErr = preflightMediaError(detectMediaEnv());
  if (envErr) {
    const e = new Error(envErr);
    e.name = "UnsupportedMediaContextError";
    throw e;
  }

  cameraEnabled = enableVideo;
  listenOnly = false;
  localStream = await acquireJoinStream(); // degrades: camera fail → audio-only, mic fail → listen-only (null)

  if (localStream) {
    // contentHint "motion" tells the encoder to prefer frame rate over detail,
    // which is the right trade-off for a camera video call.
    localStream.getVideoTracks().forEach(t => { t.contentHint = "motion"; });

    if (muted) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    if (cameraEnabled) setupLocalVideo();

    // Meter our own mic so our roster row pulses while we talk (a disabled/muted
    // track reads as silence, so muting naturally clears our own speaking ring).
    addMeter(myUserId, localStream);
  }

  activeChannelId = channelId;
  callGen++; // supersede any still-pending teardown from a just-ended call
  participants = []; // reset; the server's voice.state will populate the roster
  if (dbg) { try { dbg.startCall(channelId, myUserId); } catch { /* no-op */ } }
  sendFn({ type: "voice.join", channel_id: channelId });
  // Announce our real mute/camera state immediately. A fresh participant is
  // video-muted by default server-side (so peers never flash a video placeholder
  // before anyone turns a camera on), so a camera-on-at-join caller MUST correct
  // that to video_muted:false here or their video tile would never appear; a
  // mic-muted caller (mute persists across calls) likewise announces it.
  sendMuteState();
  startCallHeartbeat();
  startCongestionMonitor();
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
  stopCongestionMonitor();
  const chId = activeChannelId;
  activeChannelId = null;
  participants = [];
  sendFn({ type: "voice.leave", channel_id: chId });
  notifyState();
  if (dbg) { try { dbg.endCall(); } catch { /* no-op */ } }
  await finishTeardown();
}

// finishTeardown closes peer connections immediately, then plays the farewell
// tone and releases the mic once it has rung out. Peers are torn down
// synchronously (not behind the tone wait) so a call started right after this
// one can never reuse a half-closed peer connection — that produced an m-line
// order mismatch on the new call's first offer and killed it. The mic/meter
// release stays deferred (the farewell must play while capture is still live
// and the output device steady; stopping first clips the tone), guarded by
// callGen so a call that started during the wait keeps its fresh stream.
async function finishTeardown() {
  closeAllPeers();
  videoEls.clear();
  const gen = callGen;
  const myStream = localStream;
  if (onSelfLeaveTone) onSelfLeaveTone();
  await delay(SELF_TONE_FINISH_MS);
  if (gen !== callGen) {
    // A new call started during the tone wait and now owns the module-level
    // localStream + meters. Stop only the stream we captured, leave the rest.
    if (myStream) myStream.getTracks().forEach(t => { try { t.stop(); } catch { /* already stopped */ } });
    return;
  }
  stopAllMeters();
  stopLocalStream();
}

// endCallLocally tears down our side of a call without telling the server we
// left. It's the response to a server voice.end (the other party in a DM hung
// up or dropped, ending the call for both) — we're already being removed
// server-side, so re-sending voice.leave would be redundant.
export async function endCallLocally() {
  if (activeChannelId === null) return;
  stopCallHeartbeat();
  stopCongestionMonitor();
  activeChannelId = null;
  participants = [];
  notifyState();
  if (dbg) { try { dbg.endCall(); } catch { /* no-op */ } }
  await finishTeardown();
}

// sendMuteState announces our current audio/video posture to the server (which
// fans it out as voice.state): mute, video-mute, and whether the live video
// source is a screen share. Centralised so every toggle path reports the same
// shape — including the `sharing` flag the spotlight view keys on and the
// listen-only case (no mic ⇒ reported muted, since we can never transmit). No-op
// outside a call.
function sendMuteState() {
  if (activeChannelId === null) return;
  sendFn({
    type: "voice.mute",
    channel_id: activeChannelId,
    muted: muted || listenOnly,
    video_muted: !cameraEnabled,
    sharing: videoIsScreen,
  });
}

export function setVoiceMuted(m) {
  muted = m;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  sendMuteState();
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

// idleVideoSender returns a peer's video RTCRtpSender whose track is currently
// null — the dormant slot a turned-off screen share leaves behind (screen-off does
// replaceTrack(null), unlike camera-off which keeps a disabled track). Reusing it
// via replaceTrack lets video come back on with NO renegotiation; absent one, the
// caller falls back to addTrack (which fires onnegotiationneeded).
//
// CRITICAL: only a transceiver that is already negotiated to SEND
// (currentDirection sendrecv/sendonly) qualifies. A pure RECEIVE transceiver — the
// one carrying a peer's video in a 2-way call — also has a null-track sender and a
// video receiver, but it's recvonly: replaceTrack onto it sets the track without
// flipping direction or firing onnegotiationneeded, so our video would never
// actually be sent. (That was the 2-way regression: whoever turned their camera on
// SECOND matched the recvonly receive slot and silently never offered.) Matching on
// currentDirection keeps the screen-off→camera-on reuse while excluding receivers,
// which fall through to addTrack and renegotiate correctly.
function idleVideoSender(pc) {
  for (const t of pc.getTransceivers()) {
    if (t.sender && t.sender.track === null &&
        (t.currentDirection === "sendrecv" || t.currentDirection === "sendonly") &&
        t.receiver && t.receiver.track && t.receiver.track.kind === "video") {
      return t.sender;
    }
  }
  return null;
}

// attachVideoToPeers puts a local video track onto every peer connection, reusing
// a dormant video sender (replaceTrack, no reneg) when one exists and otherwise
// adding it (addTrack → onnegotiationneeded). Used by every "video turns on" path
// (camera first-enable, screen-share, and the camera↔screen swaps). Best-effort
// per peer; a failure on one never blocks the others. Bitrate caps are re-applied
// after, since a replaceTrack reuse fires no negotiation event to trigger them.
async function attachVideoToPeers(track) {
  for (const [uid, pc] of peerConns) {
    const slot = idleVideoSender(pc);
    if (slot) {
      try { await slot.replaceTrack(track); }
      catch { try { pc.addTrack(track, localStream); } catch { /* peer setup race */ } }
    } else {
      try { pc.addTrack(track, localStream); } catch { /* peer setup race */ }
    }
    applyVideoBitrateCaps(uid, pc);
  }
}

// attachScreenAudioToPeers adds a screen-share audio track (Chrome tab/system
// audio) to every peer. The track is added INTO localStream by the caller so it
// shares the mic's MediaStream msid — the remote then groups both audio tracks into
// one stream and its single per-peer <audio> element plays them mixed (per-user
// volume/deafen cover both). It rides its OWN m-line, separate from the mic, so
// muting the mic never silences the shared audio (by design — you mute your voice,
// the stream keeps playing). Always addTrack (no parked-sender reuse): the teardown
// fully removes this track, so there's never a dormant audio sender to reuse.
async function attachScreenAudioToPeers(track) {
  for (const pc of peerConns.values()) {
    try { pc.addTrack(track, localStream); } catch { /* peer setup race */ }
  }
}

// stopScreenAudio releases the screen-share audio track. Unlike the parked-and-
// reused VIDEO sender, this REMOVES the sender (pc.removeTrack → renegotiation drops
// the m-line). The asymmetry is deliberate: video has the app-layer video_muted flag
// that hides a peer's tile regardless of a lingering (silenced) track, but audio has
// NO such gate — the remote <audio> plays whatever tracks are in its stream — so the
// only way to guarantee a listener stops hearing the shared audio is to take the
// track out, not merely null its source. No-op when none is live.
async function stopScreenAudio() {
  const t = screenAudioTrack;
  if (!t) return;
  screenAudioTrack = null;
  for (const pc of peerConns.values()) {
    const sender = pc.getSenders().find(s => s.track === t);
    if (sender) { try { pc.removeTrack(sender); } catch { /* already gone */ } }
  }
  if (localStream) { try { localStream.removeTrack(t); } catch { /* not in stream */ } }
  try { t.stop(); } catch { /* already stopped */ }
}

// setScreenShareEnabled toggles desktop screen sharing as the call's video source.
// Screen share and the camera are mutually exclusive — one video source at a time —
// so turning the share ON while the camera is live SWAPS the source on the existing
// video m-line (replaceTrack: instant, no renegotiation) and stops the camera.
// getDisplayMedia is independent of the microphone, so none of the camera path's
// Android combined-stream / mic-HAL dance applies here. Turning the share OFF fully
// STOPS the capture (replaceTrack(null) + stop) — unlike camera-off, which keeps a
// disabled track for instant re-toggle — because a live screen-grab the browser is
// still showing its "you're sharing" indicator for must actually be released.
export async function setScreenShareEnabled(on) {
  if (!localStream || activeChannelId === null) return;

  if (on) {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    if (!md || typeof md.getDisplayMedia !== "function") {
      if (onCameraError) onCameraError(new Error("Screen sharing isn't supported in this browser."));
      return;
    }
    let display;
    try {
      // audio:true opts into screen audio — Chrome can capture tab/system audio (only
      // when the user picks a tab or ticks "share system audio"); Firefox/Safari just
      // return no audio track, so the share is silently video-only there.
      display = await md.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      // Dismissing the OS picker rejects with NotAllowedError/AbortError — that's a
      // cancel, not a failure to surface. Anything else is a real error.
      dbgEvent(0, "getdisplaymedia-error", { name: err && err.name });
      if (err && err.name !== "NotAllowedError" && err.name !== "AbortError" && onCameraError) onCameraError(err);
      return;
    }
    const screenTrack = display.getVideoTracks()[0];
    if (!screenTrack) { display.getTracks().forEach(t => { try { t.stop(); } catch { /* already stopped */ } }); return; }
    const screenAudio = display.getAudioTracks()[0] || null;
    // "detail" tells the encoder to preserve sharpness over frame rate — the right
    // trade for text/UI, and the inverse of the camera track's "motion" hint.
    screenTrack.contentHint = "detail";
    // The browser draws its own "Stop sharing" control; ending the capture there
    // fires onended. Flip us back to video-off so our state tracks reality.
    screenTrack.onended = () => { setScreenShareEnabled(false); };

    const oldVideo = localStream.getVideoTracks()[0]; // a live camera track, if the camera was on
    if (oldVideo) {
      for (const pc of peerConns.values()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender) { try { await sender.replaceTrack(screenTrack); } catch { /* sender gone */ } }
      }
      localStream.removeTrack(oldVideo); oldVideo.stop();
    } else {
      await attachVideoToPeers(screenTrack);
    }
    localStream.addTrack(screenTrack);
    // Screen audio (if the browser/user provided it): add it into localStream so it
    // shares the mic's stream and plays mixed at the remote (see attachScreenAudioToPeers).
    if (screenAudio) {
      // A leftover from a prior share shouldn't linger if we somehow re-enter.
      if (screenAudioTrack && screenAudioTrack !== screenAudio) await stopScreenAudio();
      screenAudioTrack = screenAudio;
      // Ending screen audio independently (rare) should drop it cleanly, not wedge state.
      screenAudio.onended = () => { stopScreenAudio(); };
      await attachScreenAudioToPeers(screenAudio);
      localStream.addTrack(screenAudio);
    }
    videoIsScreen = true;
    cameraEnabled = true;
    // A screen share must NOT teach the per-DM "camera was on" memory — the next
    // call should start voice-only, not auto-share the screen.
    saveCameraPref(activeChannelId, false);
    setupLocalVideo();
  } else {
    const vt = localStream.getVideoTracks()[0];
    if (vt) {
      for (const pc of peerConns.values()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender) { try { await sender.replaceTrack(null); } catch { /* sender gone */ } }
      }
      localStream.removeTrack(vt); vt.stop();
    }
    await stopScreenAudio();
    videoIsScreen = false;
    cameraEnabled = false;
    teardownLocalVideo();
    saveCameraPref(activeChannelId, false);
  }

  sendMuteState();
  dbgEvent(0, "screenshare-toggle", { on: videoIsScreen });
  notifyState();
}

export function isScreenSharing() { return videoIsScreen; }

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

  // Switching FROM a live screen share TO the camera. Screen sharing is desktop-only,
  // where opening the camera alone (no mic) is safe — the Android combined-stream
  // dance below applies only to the FIRST camera enable from audio-only — so acquire
  // just the camera and swap it onto the existing video m-line (replaceTrack: instant,
  // no reneg), then stop the screen grab. Camera failure leaves the share running.
  if (on && videoIsScreen) {
    let camTrack;
    try {
      camTrack = (await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS })).getVideoTracks()[0];
    } catch (err) {
      if (shouldRetryRelaxed(err)) {
        try { camTrack = (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0]; }
        catch (e2) { dbgEvent(0, "getusermedia-error", { name: e2 && e2.name, where: "camera-switch" }); if (onCameraError) onCameraError(e2); return; }
      } else {
        dbgEvent(0, "getusermedia-error", { name: err && err.name, where: "camera-switch" });
        if (onCameraError) onCameraError(err);
        return;
      }
    }
    if (!camTrack) return;
    camTrack.contentHint = "motion";
    const screen = localStream.getVideoTracks()[0];
    for (const pc of peerConns.values()) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
      if (sender) { try { await sender.replaceTrack(camTrack); } catch { /* sender gone */ } }
    }
    if (screen) { localStream.removeTrack(screen); screen.stop(); }
    await stopScreenAudio(); // the screen capture is ending — its audio goes with it
    localStream.addTrack(camTrack);
    videoIsScreen = false;
    cameraEnabled = true;
    saveCameraPref(activeChannelId, true);
    setupLocalVideo();
    for (const [uid, pc] of peerConns) applyVideoBitrateCaps(uid, pc);
    sendMuteState();
    dbgEvent(0, "camera-toggle", { on: true, from: "screen" });
    notifyState();
    return;
  }

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
    // is transparent — same m-line, no renegotiation).
    for (const pc of peerConns.values()) {
      if (newAudio) {
        const audioSender = pc.getSenders().find(s => s.track && s.track.kind === "audio");
        if (audioSender) { try { await audioSender.replaceTrack(newAudio); } catch {} }
      }
    }
    // Add the video track: reuse a dormant sender a prior screen-off left behind
    // (replaceTrack, no reneg) or addTrack it (fires onnegotiationneeded; the
    // offerer re-offers). attachVideoToPeers picks whichever applies.
    if (vt) await attachVideoToPeers(vt);

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

  sendMuteState();
  dbgEvent(0, "camera-toggle", { on: cameraEnabled });
  notifyState();
}

export function isCameraEnabled() { return cameraEnabled; }
export function isListenOnly() { return listenOnly; }
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

// detectMediaEnv snapshots the ambient capabilities that decide whether a
// getUserMedia attempt can possibly succeed, read defensively (every global is
// optional, so this is safe under Node's test runner). navigator.standalone is
// the iOS-only flag that we were launched from the home screen in a standalone
// WebView (true) rather than an ordinary Safari tab. Internal; the pure helpers
// below take the snapshot as an argument so they unit-test without a DOM.
function detectMediaEnv() {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const md = nav && nav.mediaDevices;
  return {
    hasMediaDevices: !!(md && typeof md.getUserMedia === "function"),
    // isSecureContext is undefined under Node — treat that as "secure" so the
    // preflight never false-positives in tests; in a browser it's a real bool.
    isSecureContext: typeof isSecureContext === "undefined" ? true : !!isSecureContext,
    standalone: !!(nav && nav.standalone),
  };
}

// preflightMediaError returns a complete, user-facing reason the mic/camera
// CANNOT be reached in the current context, or null when a getUserMedia attempt
// is worth making. Pure (env injected) — unit-tested without a DOM. We only hard
// block when capture is provably unreachable: an insecure origin (non-HTTPS,
// non-localhost) strips navigator.mediaDevices entirely, and some embedded
// WebViews never expose it, so calling getUserMedia would throw an opaque
// TypeError. We do NOT block iOS standalone here — mediaDevices IS present in a
// home-screen app and the call often works; that caveat rides on the FAILURE
// message instead (see mediaErrorHint), since we can't know up front it'll fail.
export function preflightMediaError(env) {
  if (!env || env.hasMediaDevices) return null;
  if (!env.isSecureContext) {
    return "Voice and video need a secure (HTTPS) connection. Open this site over https:// and try again.";
  }
  return "This browser can't reach the microphone or camera. Try a current Safari, Chrome, or Firefox; if you added this app to your home screen, open it in the browser instead.";
}

// mediaErrorHint returns a context-specific sentence appended to a getUserMedia
// FAILURE message, or "" when none applies. iOS standalone (home-screen) web
// apps have a long-standing WebKit defect where getUserMedia rejects — or the
// audio device fails to start — with no actionable cause (it can surface as
// NotAllowed / NotFound / NotReadable); the reliable fix is to open the site in
// Safari proper. Pure; env injected.
export function mediaErrorHint(env) {
  if (env && env.standalone) {
    return " (On iPhone/iPad, open this in Safari rather than the home-screen app — installed web apps can't reliably reach the mic or camera.)";
  }
  return "";
}

// micErrorMessage maps a getUserMedia rejection to a friendly, specific,
// actionable sentence (instead of dumping the raw exception text at the user).
// The error's .name is the stable cross-browser discriminator; we fall back to
// a generic line for anything unrecognized. The optional env defaults to a live
// snapshot so call sites need not thread it through; pass it explicitly in
// tests. Pure given env (mediaErrorHint is the only ambient read). Unit-tested.
export function micErrorMessage(err, env = detectMediaEnv()) {
  let base;
  switch (err && err.name) {
  case "UnsupportedMediaContextError": // our own preflight rejection
    return err.message;                // already a complete, friendly sentence
  case "NotAllowedError":      // permission denied (prompt dismissed or blocked)
  case "SecurityError":
    base = "Microphone access was blocked. Allow the mic for this site in your browser's settings, then try again.";
    break;
  case "NotFoundError":        // no input device at all
  case "OverconstrainedError":
    base = "No microphone was found. Plug one in (or check your input device) and try again.";
    break;
  case "NotReadableError":     // device held by another app / OS-level error
  case "AbortError":           // device failed to start (e.g. Android "Starting audioinput failed")
    base = "Your microphone is in use by another app (or unavailable). Close anything else using it and try again.";
    break;
  default:
    base = "Could not access the microphone" + (err && err.message ? ": " + err.message : ".");
  }
  return base + mediaErrorHint(env);
}

// cameraErrorMessage maps a getUserMedia camera rejection to a friendly sentence.
// Mirrors micErrorMessage but for video; pure given env, unit-tested.
export function cameraErrorMessage(err, env = detectMediaEnv()) {
  let base;
  switch (err && err.name) {
  case "UnsupportedMediaContextError": // our own preflight rejection
    return err.message;
  case "NotAllowedError":
  case "SecurityError":
    // No prompt + "blocked" despite the OS granting the browser camera access
    // means the browser is blocking THIS SITE (a separate, per-site permission).
    // On Firefox/Chrome for Android that's behind the shield/lock icon in the
    // address bar → Permissions → Camera; clearing "Blocked" there re-enables
    // the prompt. Point at that, not the OS-level app permission people check.
    base = "Camera blocked for this site. Tap the lock/shield icon in the address bar → Permissions → Camera, clear the block, then reload and try again.";
    break;
  case "NotFoundError":
  case "OverconstrainedError":
    base = "No camera was found. Plug one in (or check your input device) and try again.";
    break;
  case "NotReadableError":
  case "AbortError":           // device failed to start (Android "Starting videoinput failed")
    base = "Your camera couldn't be started (it may be in use by another app). Close anything else using it, or leave and rejoin the call.";
    break;
  default:
    base = "Could not access the camera" + (err && err.message ? ": " + err.message : ".");
  }
  return base + mediaErrorHint(env);
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

// acquireJoinStream gets the local capture for a join, degrading gracefully so a
// missing/blocked device never aborts the call:
//   - camera fails  → drop to audio-only (relaxing the camera constraints first,
//                     which fixes the common Android OverconstrainedError);
//   - microphone fails → drop to LISTEN-ONLY: return null and set listenOnly, so
//                     we still join and RECEIVE everyone's audio/video over
//                     recvonly transceivers (see createPC) — we just can't send.
// Mutates the module cameraEnabled/listenOnly flags. It never throws for a device
// failure; the only hard stop (a context that can't capture at all) is the
// preflight check the caller runs before this. Internal.
async function acquireJoinStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: cameraEnabled ? VIDEO_CONSTRAINTS : false });
  } catch (err) {
    // The combined request rejects if EITHER device fails. Distinguish by retry:
    // if a relaxed/audio-only request then succeeds it was the camera; if even
    // audio-only fails the mic is unavailable → listen-only.
    if (cameraEnabled && shouldRetryRelaxed(err)) {
      try { return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: true }); }
      catch { /* camera still unhappy — fall through to audio-only */ }
    }
    cameraEnabled = false;
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
    } catch (micErr) {
      listenOnly = true;
      dbgEvent(0, "listen-only-join", { name: micErr && micErr.name });
      return null;
    }
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

// withVideoEncodingCaps returns a copy of an RTCRtpSendParameters with the given
// encoding shape (maxBitrate, scaleResolutionDownBy, maxFramerate) set on every
// encoding, or null when there is nothing to do — params missing, encodings
// absent/empty (the array is only populated once negotiation has materialized the
// sender, and the spec forbids *adding* encodings via setParameters), or every
// encoding already carries this exact shape. Returning null lets the caller skip a
// pointless setParameters round-trip; the shape is then re-attempted at the next
// call site (post-negotiation / on connected). Never mutates its input. Pure;
// exported for unit testing.
export function withVideoEncodingCaps(params, caps) {
  if (!params || !Array.isArray(params.encodings) || params.encodings.length === 0) return null;
  const { maxBitrate, scaleResolutionDownBy, maxFramerate } = caps;
  let changed = false;
  const encodings = params.encodings.map(e => {
    if (e && e.maxBitrate === maxBitrate &&
        e.scaleResolutionDownBy === scaleResolutionDownBy &&
        e.maxFramerate === maxFramerate) return e;
    changed = true;
    return { ...e, maxBitrate, scaleResolutionDownBy, maxFramerate };
  });
  if (!changed) return null;
  return { ...params, encodings };
}

// bitrateCapFor returns the per-sender maxBitrate for a node in an N-participant
// call: the total uplink budget split across the (N-1) video senders, ceilinged
// at the per-sender stability cap and floored so a crowded call still shows
// something. numPeers is the total participant count (including self). Only
// "video" is budgeted today; other kinds return the plain ceiling. Pure;
// exported for unit testing.
export function bitrateCapFor(numPeers, kind) {
  if (kind !== "video") return VIDEO_MAX_BITRATE_BPS;
  const senders = Math.max(1, (numPeers || 0) - 1);
  const per = Math.floor(TOTAL_VIDEO_UPLINK_BPS / senders);
  return Math.max(MIN_VIDEO_BITRATE_BPS, Math.min(VIDEO_MAX_BITRATE_BPS, per));
}

// --- congestion-adaptive video bitrate -------------------------------------
// The roster budget (bitrateCapFor) is a static CEILING. On a marginal uplink
// (a phone on a flaky link) sending video at that ceiling self-inflicts the
// congestion that drops the call: the uplink saturates → packets are lost → ICE
// consent checks time out → disconnect/restart storm. So we run an AIMD loop per
// uplink sender — multiplicative DECREASE when the remote reports loss/RTT spikes
// or the local encoder is CPU-pinned, gradual additive INCREASE back toward the
// ceiling when the path is healthy — and apply the result as the live encoding
// shape: maxBitrate AND, below thresholds, a coarser scaleResolutionDownBy /
// maxFramerate (see videoScaleForTarget). Bitrate alone is not enough: a phone
// whose encoder can't keep up at full resolution (encT climbs, fps collapses)
// pays the same per-frame CPU no matter how low maxBitrate goes — only dropping
// resolution/framerate relieves it. The browser's own congestion control still
// operates below this; this just stops us from offering more than a stressed
// link or encoder can carry. Per-peer state lives in peerMeta (videoTarget =
// current adaptive bps; lossPrev = last sent/lost counters; healthyStreak =
// consecutive non-stressed intervals, gating the climb so one clean sample
// doesn't bounce us back up).
const RTT_STRESS_MS = 600;            // RTT at/above this = stressed
const LOSS_STRESS = 0.08;             // ≥8% uplink loss over an interval = stressed
const LOSS_OK = 0.02;                 // ≤2% loss = healthy enough to climb
const CONGESTION_DECREASE = 0.75;     // multiplicative back-off factor
const CONGESTION_INCREASE_BPS = 75000; // additive recovery step
const CLIMB_AFTER_HEALTHY = 2;        // need this many consecutive healthy intervals before climbing
// Resolution/framerate stepping by adaptive target. Keyed on ABSOLUTE bps (encoder
// CPU cost tracks pixels/sec, not the ratio to a roster ceiling), so a big roster —
// whose per-sender slice is already small — also renders at a coarser scale, which
// is fine since tiles are tiny. 1× = native capture; 2× halves each dimension
// (¼ pixels); 4× quarters them.
const VIDEO_SCALE_FULL_BPS = 500000;  // ≥ this → native resolution
const VIDEO_SCALE_HALF_BPS = 300000;  // ≥ this → ½-scale; below → ¼-scale
const CONGESTION_INTERVAL_MS = 2500;  // monitor cadence

// uplinkLossFraction is the fraction of our sent video packets the remote lost
// over one interval, from cumulative sent (outbound-rtp) and lost (remote-
// inbound-rtp) counters. null when there's no baseline, no traffic, or a counter
// reset (a reconnect zeroes them). Pure; exported for unit testing.
export function uplinkLossFraction(sentNow, lostNow, sentPrev, lostPrev) {
  if (typeof sentPrev !== "number" || typeof lostPrev !== "number") return null;
  const dSent = sentNow - sentPrev, dLost = lostNow - lostPrev;
  if (dSent <= 0 || dLost < 0) return null;
  return Math.min(1, dLost / dSent);
}

// uplinkStressed classifies one interval's signals as stressed: remote-reported
// loss at/above LOSS_STRESS, RTT at/above RTT_STRESS_MS, or the LOCAL encoder
// reporting it's CPU-limited (cpuLimited). CPU pressure belongs here because the
// only relief is a smaller frame, which the back-off → lower target → coarser
// scale path delivers. Pure; exported so the monitor can keep the streak in sync.
export function uplinkStressed(sig) {
  return (sig.lossFrac != null && sig.lossFrac >= LOSS_STRESS) ||
         (sig.rttMs != null && sig.rttMs >= RTT_STRESS_MS) ||
         !!sig.cpuLimited;
}

// congestionTarget runs one AIMD step: given the previous target, the roster
// ceiling, and the observed signals, return the new per-sender bitrate. Decrease
// on stress (loss/RTT/CPU; see uplinkStressed); otherwise climb by a step — but
// only once the link has been healthy for CLIMB_AFTER_HEALTHY consecutive
// intervals (sig.healthyStreak, maintained by the caller) and the encoder isn't
// already bandwidth-limited. The streak gate is the oscillation fix: without it a
// single clean sample bounced the target back up while RTT was still elevated.
// Always clamped to [MIN_VIDEO_BITRATE_BPS, ceiling]. Pure; exported for testing.
export function congestionTarget(prev, ceiling, sig) {
  let target = typeof prev === "number" && prev > 0 ? prev : ceiling;
  if (uplinkStressed(sig)) {
    target = Math.floor(target * CONGESTION_DECREASE);
  } else {
    const lossOk = sig.lossFrac == null || sig.lossFrac <= LOSS_OK;
    const rttOk = sig.rttMs == null || sig.rttMs < RTT_STRESS_MS;
    const settled = (sig.healthyStreak || 0) >= CLIMB_AFTER_HEALTHY;
    if (lossOk && rttOk && settled && !sig.limited) target += CONGESTION_INCREASE_BPS;
  }
  return Math.max(MIN_VIDEO_BITRATE_BPS, Math.min(ceiling, target));
}

// videoScaleForTarget maps an adaptive bitrate target to an encoding shape:
// scaleResolutionDownBy and maxFramerate. At/above VIDEO_SCALE_FULL_BPS the link
// can carry native capture; as the target falls we shed resolution (2×, then 4×)
// and trim framerate, which is what actually unloads a CPU-pinned phone encoder.
//
// isScreen INVERTS the resolution/framerate trade-off. Shedding resolution turns
// shared text/UI to mush — unreadable is worse than choppy — so a screen source
// HOLDS native resolution (scaleResolutionDownBy:1) at every target and gives back
// frame rate instead (a near-static screen barely needs frames). This pairs with
// the "detail" contentHint the screen track carries. Pure; exported for unit testing.
export function videoScaleForTarget(target, isScreen = false) {
  if (isScreen) {
    // Hold full resolution at every target (sheared text is worse than choppy),
    // but give framerate back generously: the original 15/8/5 ladder was tuned
    // far enough toward sharpness that motion (scrolling, video, a demo) stuttered
    // noticeably even on a healthy link. These let the encoder use the frames the
    // bitrate affords; the AIMD target still steps them down on a stressed link.
    if (typeof target !== "number" || target >= VIDEO_SCALE_FULL_BPS) return { scaleResolutionDownBy: 1, maxFramerate: 24 };
    if (target >= VIDEO_SCALE_HALF_BPS) return { scaleResolutionDownBy: 1, maxFramerate: 15 };
    return { scaleResolutionDownBy: 1, maxFramerate: 10 };
  }
  if (typeof target !== "number" || target >= VIDEO_SCALE_FULL_BPS) {
    return { scaleResolutionDownBy: 1, maxFramerate: 24 };
  }
  if (target >= VIDEO_SCALE_HALF_BPS) return { scaleResolutionDownBy: 2, maxFramerate: 20 };
  return { scaleResolutionDownBy: 4, maxFramerate: 15 };
}

// readUplinkSignals extracts the congestion signals for our outbound video from
// a getStats() report: the remote-reported loss fraction (vs the prev counters),
// the round-trip time, and whether the encoder is bandwidth-limited. null when
// we aren't sending video. `prev` is {sent, lost} from the last interval.
function readUplinkSignals(report, prev) {
  let out = null;
  const remoteIns = [];
  report.forEach((s) => {
    if (s.type === "outbound-rtp" && s.kind === "video") out = s;
    else if (s.type === "remote-inbound-rtp") remoteIns.push(s);
  });
  if (!out) return null;
  // Link the remote-inbound report for OUR video stream. Prefer the matching
  // ssrc (most reliable); fall back to a kind/mediaType tag (Firefox doesn't
  // always set kind on remote-inbound-rtp). null is fine — we just lose the
  // loss/RTT signal and behave as before (no back-off).
  const remoteIn = remoteIns.find(r => r.ssrc === out.ssrc) ||
                   remoteIns.find(r => r.kind === "video" || r.mediaType === "video") || null;
  const sent = typeof out.packetsSent === "number" ? out.packetsSent : 0;
  const lost = remoteIn && typeof remoteIn.packetsLost === "number" ? remoteIn.packetsLost : undefined;
  const rttMs = remoteIn && typeof remoteIn.roundTripTime === "number"
    ? Math.round(remoteIn.roundTripTime * 1000) : null;
  const lossFrac = (lost !== undefined && prev)
    ? uplinkLossFraction(sent, lost, prev.sent, prev.lost) : null;
  return {
    sent, lost: lost ?? 0, rttMs, lossFrac,
    limited: out.qualityLimitationReason === "bandwidth", // hold the climb (encoder maxed for the link)
    cpuLimited: out.qualityLimitationReason === "cpu",    // back off (shed resolution/framerate)
  };
}

// effectiveVideoCap is the live per-sender bitrate for a peer: the roster
// ceiling, lowered to the peer's current congestion target when one is set.
function effectiveVideoCap(remoteUserId) {
  const ceiling = bitrateCapFor(participants.length, "video");
  const meta = peerMeta.get(remoteUserId);
  if (!meta || typeof meta.videoTarget !== "number") return ceiling;
  return Math.max(MIN_VIDEO_BITRATE_BPS, Math.min(ceiling, meta.videoTarget));
}

// monitorCongestion samples each peer's uplink and steps its adaptive target.
// Runs on a timer for the whole call; getStats failures and absent senders are
// skipped silently so it never disturbs a call.
async function monitorCongestion() {
  if (activeChannelId === null) return;
  const ceiling = bitrateCapFor(participants.length, "video");
  for (const [uid, pc] of peerConns) {
    const meta = peerMeta.get(uid);
    if (!meta) continue;
    let report;
    try { report = await pc.getStats(); } catch { continue; }
    const sig = readUplinkSignals(report, meta.lossPrev);
    if (!sig) continue;
    meta.lossPrev = { sent: sig.sent, lost: sig.lost };
    // Maintain the consecutive-healthy streak that gates the climb (congestionTarget
    // reads it via sig.healthyStreak): reset on any stressed interval, else extend.
    meta.healthyStreak = uplinkStressed(sig) ? 0 : (meta.healthyStreak || 0) + 1;
    sig.healthyStreak = meta.healthyStreak;
    const prevTarget = typeof meta.videoTarget === "number" ? meta.videoTarget : ceiling;
    const next = congestionTarget(prevTarget, ceiling, sig);
    if (next !== meta.videoTarget) {
      meta.videoTarget = next;
      applyVideoBitrateCaps(uid, pc);
      dbgEvent(uid, "bitrate-adapt", {
        target: next, lossFrac: sig.lossFrac, rttMs: sig.rttMs,
        scale: videoScaleForTarget(next, videoIsScreen).scaleResolutionDownBy, cpu: sig.cpuLimited,
      });
    }
  }
}

function startCongestionMonitor() {
  stopCongestionMonitor();
  congestionTimer = setInterval(monitorCongestion, CONGESTION_INTERVAL_MS);
}
function stopCongestionMonitor() {
  if (congestionTimer !== null) { clearInterval(congestionTimer); congestionTimer = null; }
}

// applyVideoBitrateCaps shapes every video sender on a peer connection to the
// effective per-sender target (roster budget, lowered by congestion control; see
// effectiveVideoCap / bitrateCapFor) — maxBitrate plus the matching resolution/
// framerate step (videoScaleForTarget). Idempotent and best-effort:
// pre-negotiation senders report empty encodings and are skipped
// (withVideoEncodingCaps returns null), so this is called wherever encodings may
// have just materialized — after each completed offer/answer exchange, on the
// connection reaching "connected", on a roster-size change (onVoiceState), and
// from the congestion monitor when a peer's target moves. A setParameters
// failure never touches the call.
function applyVideoBitrateCaps(remoteUserId, pc) {
  const cap = effectiveVideoCap(remoteUserId);
  const shape = { maxBitrate: cap, ...videoScaleForTarget(cap, videoIsScreen) };
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== "video") continue;
    let params;
    try { params = sender.getParameters(); } catch { continue; }
    const capped = withVideoEncodingCaps(params, shape);
    if (!capped) continue;
    try { Promise.resolve(sender.setParameters(capped)).catch(() => {}); } catch { /* best-effort */ }
  }
}

async function onVoiceState(payload) {
  if (payload.channel_id !== activeChannelId) return;
  participants = payload.participants || [];
  const remoteIds = new Set(participants.filter(p => p.user_id !== myUserId).map(p => p.user_id));
  const prevPeerCount = peerConns.size;

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

  // Re-budget every video sender for the new roster size: a join shrinks each
  // sender's slice, a leave grows it back, neither of which renegotiates on its
  // own. Best-effort and idempotent (no-op when the cap is unchanged).
  for (const [uid, pc] of peerConns) applyVideoBitrateCaps(uid, pc);

  // Telemetry: a membership change (someone joined or left) is the group-call
  // event worth correlating with the per-tick aggregate. Mute/camera flips that
  // leave the peer set unchanged don't emit one.
  if (peerConns.size !== prevPeerCount) {
    dbgEvent(0, "roster-change", { n: participants.length, peers: peerConns.size });
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

// sendOffer creates and sends an offer for a peer (the renegotiation path that
// onnegotiationneeded and maybeRenegotiate both funnel through). It only offers
// from "stable"; firing mid-negotiation instead records renegotiatePending so
// maybeRenegotiate re-offers once stable. makingOffer brackets the whole
// create-and-set window so a remote offer crossing it is detected as a
// collision even before our offer reaches have-local-offer. NOT gated on
// isOfferer: whoever adds a track must offer it (a fresh offer carries only the
// offerer's m-lines), and simultaneous offers are resolved by Perfect
// Negotiation in onOffer.
// hasUnsentLocalTrack reports whether any transceiver carries a local track the
// currently-negotiated direction does NOT send (recvonly/inactive). True means
// we added a track (e.g. our camera) whose negotiation never completed — the
// classic case being a glare rollback that discarded the offer carrying it. It
// is deliberately false when a track is already sendrecv/sendonly (e.g. audio
// negotiated by accepting the peer's sendrecv offer at join), so we don't fire
// a redundant renegotiation that would churn ICE while it's still connecting.
export function hasUnsentLocalTrack(pc) {
  return pc.getTransceivers().some(t =>
    t.sender && t.sender.track &&
    t.currentDirection !== "sendrecv" && t.currentDirection !== "sendonly");
}

async function sendOffer(remoteUserId, pc) {
  if (activeChannelId === null) return;
  const meta = peerMeta.get(remoteUserId);
  // The INITIAL offer is sent explicitly by the deterministic offerer (lower
  // user_id) in onVoiceState. Until a remote description exists we suppress the
  // negotiationneeded-driven offer — adding our tracks to a brand-new peer fires
  // it, and on the higher-id peer that offer collides with the impolite peer's
  // initial offer at EVERY call setup, a guaranteed glare whose rollback churn
  // intermittently stalls ICE before it connects. Any local track the initial
  // offer doesn't carry (e.g. camera-on-at-join) is picked up post-connect by
  // hasUnsentLocalTrack + maybeRenegotiate, which serialises it after the base
  // connection instead of racing it.
  if (!pc.remoteDescription) return;
  // Per spec negotiationneeded only fires in "stable", but a glare rollback can
  // leave a track un-negotiated without re-firing it reliably — so when we're
  // not stable we remember the debt instead of trusting the browser to re-fire.
  if (pc.signalingState !== "stable") { if (meta) meta.renegotiatePending = true; return; }
  try {
    if (meta) { meta.makingOffer = true; meta.renegotiatePending = false; }
    preferVideoCodec(pc); // VP8-first on the newly-added video track
    await pc.setLocalDescription(); // no-arg: implicit createOffer
    sendFn({ type: "voice.offer", to_user_id: remoteUserId, channel_id: activeChannelId, sdp: pc.localDescription.sdp });
    dbgEvent(remoteUserId, "offer-sent", { reason: "reneg" });
  } catch { /* setup failure; reconnect/ICE paths recover or close */ }
  finally { if (meta) meta.makingOffer = false; }
}

// maybeRenegotiate fulfils a deferred renegotiation once the connection is back
// in "stable". The crucial case: in a simultaneous-video glare the polite peer
// rolls back its own offer to accept the impolite peer's — discarding the
// negotiation of the track it had just added. Without re-offering, that
// direction's media is lost for the whole call (the flaky e2e glare symptom:
// one side never sees the other's video). We re-offer it ourselves rather than
// trusting the browser to re-fire negotiationneeded after a rollback. Keyed on a
// one-shot renegotiatePending flag, NOT on live transceiver state on every
// settle — re-checking hasUnsentLocalTrack on each stable transition made both
// peers re-offer in lockstep and oscillate, breaking BOTH directions.
function maybeRenegotiate(remoteUserId, pc) {
  const meta = peerMeta.get(remoteUserId);
  if (!meta || !meta.renegotiatePending || meta.makingOffer) return;
  if (pc.signalingState !== "stable") return;
  sendOffer(remoteUserId, pc);
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
  applyVideoBitrateCaps(fromId, pc); // encodings exist once the answer is local
  dbgEvent(fromId, "answer-sent", {});
  // If accepting this offer left one of our own tracks un-sent — the polite-peer
  // glare case where our offer carrying e.g. our camera was rolled back to take
  // this one — flag a one-shot re-offer. Gated on hasUnsentLocalTrack so we DON'T
  // churn a redundant renegotiation when the accepted offer already negotiated
  // our send (e.g. audio at join), which can stall ICE while it's still
  // connecting. One-shot (not re-evaluated each settle) so the two peers can't
  // fall into a re-offer oscillation that breaks both directions.
  if (meta && hasUnsentLocalTrack(pc)) meta.renegotiatePending = true;
  maybeRenegotiate(fromId, pc);
}

async function onAnswer(payload) {
  const fromId = payload.from_user_id;
  const pc = peerConns.get(fromId);
  if (!pc || pc.signalingState !== "have-local-offer") return;
  await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
  await drainPendingCandidates(fromId); // apply any buffered trickle-ICE candidates
  applyVideoBitrateCaps(fromId, pc); // offer/answer complete — sender encodings are live
  dbgEvent(fromId, "answer-recv", {});
  maybeRenegotiate(fromId, pc); // flush any renegotiation deferred during the offer
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
  // are expected to fail; renegotiatePending records that we owe the peer an
  // offer once we're back in "stable" — set when our own offer was rolled back
  // to accept a colliding one, or when negotiationneeded fired mid-negotiation).
  peerMeta.set(remoteUserId, { restarts: 0, timer: null, makingOffer: false, ignoreOffer: false, renegotiatePending: false, videoTarget: undefined, lossPrev: null, healthyStreak: 0 });
  if (dbg) { try { dbg.attachPeer(remoteUserId, pc); } catch { /* no-op */ } }

  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  } else if (isOfferer(remoteUserId)) {
    // Listen-only (no mic/camera): with no local tracks our offer would carry no
    // m-lines and we'd negotiate — and receive — nothing. Add recvonly
    // transceivers so the peer still sends us audio/video. Only needed on the
    // OFFERER side: as the answerer, setRemoteDescription synthesises matching
    // recvonly transceivers from the peer's offer automatically.
    try { pc.addTransceiver("audio", { direction: "recvonly" }); } catch { /* older engines */ }
    try { pc.addTransceiver("video", { direction: "recvonly" }); } catch { /* older engines */ }
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
      // A peer can send a SECOND audio track mid-call: the tab/system audio from a
      // screen share, grouped into the mic's msid stream so it arrives in this SAME
      // `e.streams[0]`. The track is received and lands in the stream, but Chrome
      // treats re-assigning the identical srcObject as a no-op and the <audio>
      // element never starts RENDERING the newly-added track — received but unheard
      // (the IRL "I hear their mic, not their share" bug). Null-flip srcObject to
      // force the element to re-evaluate the stream's tracks, then kick playback.
      // We keep the browser-owned stream (not a stream of our own) so that when the
      // share's audio sender is later removed, the track drops out automatically.
      const stream = e.streams[0];
      if (stream) {
        if (audio.srcObject === stream) audio.srcObject = null;
        audio.srcObject = stream;
        audio.play?.().catch(() => {}); // autoplay can need a kick after a re-bind
        addMeter(remoteUserId, stream); // pulse their row while they talk
        dbgEvent(remoteUserId, "audio-track", { tracks: stream.getAudioTracks().length });
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

  // Renegotiation (mid-call camera enable, screen-share add/swap, ICE restart
  // fallback): addTrack fires onnegotiationneeded and we offer. EITHER peer may
  // need to renegotiate — whoever adds the track must be the one to offer,
  // because a fresh offer carries only the offerer's own m-lines. So this is
  // NOT gated on isOfferer: the deterministic offerer rule governs the
  // *initial* setup only; simultaneous renegotiations are resolved by Perfect
  // Negotiation in onOffer (impolite lower-id offer wins, polite higher-id
  // rolls back implicitly and answers). makingOffer brackets the whole
  // create-and-set window so a remote offer crossing it is detected as a
  // collision even before our offer reaches have-local-offer.
  pc.onnegotiationneeded = () => sendOffer(remoteUserId, pc);

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
    if (pc.connectionState === "connected") applyVideoBitrateCaps(remoteUserId, pc); // encodings are definitely live now
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
  videoIsScreen = false;
  listenOnly = false;
  screenAudioTrack = null; // its track was stopped with the rest of localStream above
}

function notifyState() {
  if (onStateChange) onStateChange({
    inCall: activeChannelId !== null,
    channelId: activeChannelId,
    muted,
    deafened,
    videoMuted: !cameraEnabled,
    sharing: videoIsScreen, // local-only: which video source is live, so the UI lights the right button
    listenOnly,             // joined without a mic: receive-only (UI shows it, disables the mute toggle)
    participants: participants.map(p => ({ user_id: p.user_id, muted: !!p.muted, video_muted: !!p.video_muted, sharing: !!p.sharing })),
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

// (The ring + pending call tones moved to tones.js — see startRingSound /
// startPendingSound there. app.js drives them directly; voice.js, the WebRTC
// engine, no longer synthesizes any audio.)
