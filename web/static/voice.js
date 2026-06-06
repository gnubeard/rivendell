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

// Ring-sound state. The incoming-call ringtone (callee) and the call-pending
// tone (caller waiting for pickup) are independent so they never share an
// interval — a single client is only ever one side of a ring, but keeping them
// separate is cheap and avoids any cross-talk.
let ringInterval = null;
let ringAudioCtx = null;
let ringTick = 0;             // counts ringtone repeats, to occasionally accent
let pendingInterval = null;
let pendingAudioCtx = null;

export function initVoice(myId, socketSend, stateChangeCb) {
  myUserId = myId;
  sendFn = socketSend;
  onStateChange = stateChangeCb;
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

  activeChannelId = channelId;
  participants = []; // reset; the server's voice.state will populate the roster
  sendFn({ type: "voice.join", channel_id: channelId });
  notifyState();
}

export async function leaveVoiceChannel() {
  if (activeChannelId === null) return;
  const chId = activeChannelId;
  activeChannelId = null;
  participants = [];
  sendFn({ type: "voice.leave", channel_id: chId });
  closeAllPeers();
  stopLocalStream();
  notifyState();
}

// endCallLocally tears down our side of a call without telling the server we
// left. It's the response to a server voice.end (the other party in a DM hung
// up or dropped, ending the call for both) — we're already being removed
// server-side, so re-sending voice.leave would be redundant.
export function endCallLocally() {
  if (activeChannelId === null) return;
  activeChannelId = null;
  participants = [];
  closeAllPeers();
  stopLocalStream();
  notifyState();
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
    if (e.streams[0]) audio.srcObject = e.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") closePeer(remoteUserId);
  };

  return pc;
}

function closePeer(userId) {
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
