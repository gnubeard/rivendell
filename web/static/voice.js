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
let myUserId = null;
let muted = false;
let deafened = false;
let sendFn = null;            // (obj) -> void — socket.send wrapper
let onStateChange = null;     // ({inCall, channelId, muted, deafened}) -> void

// Ring-sound state
let ringInterval = null;
let ringAudioCtx = null;

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
  sendFn({ type: "voice.join", channel_id: channelId });
  notifyState();
}

export async function leaveVoiceChannel() {
  if (activeChannelId === null) return;
  const chId = activeChannelId;
  activeChannelId = null;
  sendFn({ type: "voice.leave", channel_id: chId });
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
  const participants = payload.participants || [];
  const remoteIds = new Set(participants.filter(p => p.user_id !== myUserId).map(p => p.user_id));

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
  if (onStateChange) onStateChange({ inCall: activeChannelId !== null, channelId: activeChannelId, muted, deafened });
}

// --- ring sound -----------------------------------------------------------

// startRingSound plays a repeating two-tone phone ring via Web Audio.
// Pass the shared AudioContext from app.js (already primed by a user gesture).
export function startRingSound(audioCtx) {
  if (ringInterval) stopRingSound();
  ringAudioCtx = audioCtx;
  playRingTone(audioCtx);
  ringInterval = setInterval(() => playRingTone(ringAudioCtx), 3000);
}

export function stopRingSound() {
  clearInterval(ringInterval);
  ringInterval = null;
  ringAudioCtx = null;
}

function playRingTone(ctx) {
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
