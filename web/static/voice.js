// voice.js — WebRTC audio calling for Rivendell.
//
// Phase 2: DM calls (2-party). Phase 3 will extend to multi-party voice channels.
//
// Peer connection role: the participant with the LOWER numeric user_id is the
// offerer. This deterministic rule avoids signaling glare when both sides join
// at roughly the same time, without requiring a separate negotiation step.
//
// Topology: full P2P mesh (just two nodes in Phase 2). The server never touches
// media; it only relays offer/answer/ICE via the existing WS hub.

let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
let localStream = null;
let peerConns = new Map();    // remoteUserId -> RTCPeerConnection
let audioEls = new Map();     // remoteUserId -> <audio> element
let activeChannelId = null;
let participants = [];         // latest voice.state roster for the active channel
let myUserId = null;
let muted = false;
let deafened = false;
let sendFn = null;            // (obj) -> void — socket.send wrapper
let onStateChange = null;     // ({inCall, channelId, muted, deafened}) -> void
let onSpeaking = null;        // (userId, speaking: bool) -> void — see setSpeakingCallback
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

// joinVoiceChannel acquires the microphone, informs the server (voice.join),
// and waits for voice.state updates to establish peer connections.
export async function joinVoiceChannel(channelId) {
  if (activeChannelId === channelId) return;
  if (activeChannelId !== null) await leaveVoiceChannel();

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
    },
    video: false,
  });

  if (muted) localStream.getAudioTracks().forEach(t => { t.enabled = false; });

  // Meter our own mic so our roster row pulses while we talk (a disabled/muted
  // track reads as silence, so muting naturally clears our own speaking ring).
  addMeter(myUserId, localStream);

  activeChannelId = channelId;
  participants = []; // reset; the server's voice.state will populate the roster
  sendFn({ type: "voice.join", channel_id: channelId });
  notifyState();

  // Greet AFTER the mic is live and the AEC has settled — this lands the tone in
  // steady-state capture (where remote-peer tones play loud), not in the
  // capture-START device transition that clipped it to near-silence before.
  // Fire-and-forget via setTimeout so join doesn't block on the settle window.
  if (onSelfJoinTone) setTimeout(onSelfJoinTone, SELF_TONE_SETTLE_MS);
}

export async function leaveVoiceChannel() {
  if (activeChannelId === null) return;
  const chId = activeChannelId;
  activeChannelId = null;
  participants = [];
  sendFn({ type: "voice.leave", channel_id: chId });
  notifyState();
  // Farewell BEFORE teardown, while the capture is still live and the output
  // device is in the same steady state where remote-peer tones play loud. Then
  // wait for it to ring out before releasing the mic — stopping the track first
  // (as we used to) dropped the tone into the capture-STOP device transition.
  if (onSelfLeaveTone) onSelfLeaveTone();
  await delay(SELF_TONE_FINISH_MS);
  stopAllMeters();
  closeAllPeers();
  stopLocalStream();
}

// endCallLocally tears down our side of a call without telling the server we
// left. It's the response to a server voice.end (the other party in a DM hung
// up or dropped, ending the call for both) — we're already being removed
// server-side, so re-sending voice.leave would be redundant.
export async function endCallLocally() {
  if (activeChannelId === null) return;
  activeChannelId = null;
  participants = [];
  notifyState();
  // See leaveVoiceChannel: farewell BEFORE teardown so it plays in steady-state
  // capture, then wait for it to finish before releasing the mic.
  if (onSelfLeaveTone) onSelfLeaveTone();
  await delay(SELF_TONE_FINISH_MS);
  stopAllMeters();
  closeAllPeers();
  stopLocalStream();
}

export function setVoiceMuted(m) {
  muted = m;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  if (activeChannelId !== null) sendFn({ type: "voice.mute", channel_id: activeChannelId, muted });
  notifyState();
}

export function setVoiceDeafened(d) {
  deafened = d;
  audioEls.forEach(el => { el.muted = deafened; });
  notifyState();
}

// setSpeakingCallback registers cb(userId, speaking) for speaking-indicator UI.
export function setSpeakingCallback(cb) { onSpeaking = cb; }

export function isVoiceMuted() { return muted; }
export function isVoiceDeafened() { return deafened; }
export function voiceChannelId() { return activeChannelId; }
export function isInCall() { return activeChannelId !== null; }

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

// --- peer connection lifecycle --------------------------------------------

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
      // Lower user_id is the offerer.
      if (myUserId < p.user_id) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendFn({ type: "voice.offer", to_user_id: p.user_id, channel_id: activeChannelId, sdp: offer.sdp });
      }
    }
  }

  // Close connections for participants who left.
  for (const userId of [...peerConns.keys()]) {
    if (!remoteIds.has(userId)) closePeer(userId);
  }
}

async function onOffer(payload) {
  if (activeChannelId === null) return;
  const fromId = payload.from_user_id;
  let pc = peerConns.get(fromId);
  if (!pc) pc = createPC(fromId);
  // If we already have a local offer (glare), the lower ID wins: if we're the
  // lower ID we're the offerer — ignore their offer. Otherwise rollback.
  if (pc.signalingState === "have-local-offer") {
    if (myUserId < fromId) return; // we're the offerer, ignore
    // We're the answerer; rollback our incorrect offer
    try { await pc.setLocalDescription({ type: "rollback" }); } catch {}
  }
  await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendFn({ type: "voice.answer", to_user_id: fromId, channel_id: activeChannelId, sdp: answer.sdp });
}

async function onAnswer(payload) {
  const fromId = payload.from_user_id;
  const pc = peerConns.get(fromId);
  if (!pc || pc.signalingState !== "have-local-offer") return;
  await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
}

async function onICE(payload) {
  const fromId = payload.from_user_id;
  const pc = peerConns.get(fromId);
  if (!pc || !payload.candidate) return;
  try { await pc.addIceCandidate(payload.candidate); } catch {}
}

function createPC(remoteUserId) {
  const pc = new RTCPeerConnection({ iceServers });
  peerConns.set(remoteUserId, pc);

  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate && activeChannelId !== null) {
      sendFn({ type: "voice.ice", to_user_id: remoteUserId, channel_id: activeChannelId, candidate: e.candidate.toJSON() });
    }
  };

  pc.ontrack = (e) => {
    let audio = audioEls.get(remoteUserId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.muted = deafened;
      document.body.appendChild(audio);
      audioEls.set(remoteUserId, audio);
    }
    if (e.streams[0]) {
      audio.srcObject = e.streams[0];
      addMeter(remoteUserId, e.streams[0]); // pulse their row while they talk
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") closePeer(remoteUserId);
  };

  return pc;
}

function closePeer(userId) {
  removeMeter(userId);
  const pc = peerConns.get(userId);
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
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
}

function closeAllPeers() {
  for (const uid of [...peerConns.keys()]) closePeer(uid);
}

function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
}

function notifyState() {
  if (onStateChange) onStateChange({
    inCall: activeChannelId !== null,
    channelId: activeChannelId,
    muted,
    deafened,
    participants: participants.map(p => ({ user_id: p.user_id, muted: !!p.muted })),
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
