// rtcdebug.js — WebRTC debug telemetry capture.
//
// When enabled (via ?rtcdebug=1, localStorage "rivendell.rtcDebug", or the
// server-advertised /api/instance debug_telemetry flag), this module walks every
// live RTCPeerConnection's getStats() on a timer, builds a compact per-peer
// snapshot, and batches it — together with discrete lifecycle events emitted by
// voice.js — to POST /api/debug/telemetry. The server logs each as one greppable
// logfmt line, so a call's timeline (and a stalled counter — the silent-drop /
// encoder-freeze fingerprint) is reconstructable straight from stdout.
//
// Design rules mirrored from voice.js:
//   - Pure helpers (deltaOf, buildSnapshot, capPayload, rtcDebugEnabled) are
//     exported and unit-tested in web/test/rtcdebug.test.js; the impure timer/
//     transport glue lives in createTelemetry.
//   - Importing this module in node must never touch a browser global at top
//     level — every global access is inside a function and guarded — so voice.js
//     and its tests stay clean.
//   - CANDIDATE IP ADDRESSES ARE NEVER READ. buildSnapshot extracts only the
//     candidate TYPE (host/srflx/relay) + RTT from the selected pair, so no raw
//     address can reach the wire (the server schema has no field for one either).
//   - Telemetry must never throw into a call or slow it: every entry point is
//     wrapped, getStats runs off the media path, and disabled ⇒ zero work.

export const SNAPSHOT_INTERVAL_MS = 3000; // per-peer getStats cadence
const FLUSH_INTERVAL_MS = 5000; // batch POST cadence
const MAX_QUEUED_SNAPSHOTS = 50; // flush early past this
const MAX_BODY_BYTES = 256 * 1024; // normal-flush body cap
const MAX_BEACON_BYTES = 60 * 1024; // unload sendBeacon is much smaller in practice
const STORE_KEY = "rivendell.rtcDebug";

// rtcDebugEnabled decides whether to capture. The server flag (from /api/instance)
// forces it on for everyone; otherwise it's the per-client opt-in. Setting the URL
// param persists to localStorage so it survives reloads (the historical behavior).
export function rtcDebugEnabled(serverFlag) {
  if (serverFlag) return true;
  try {
    if (typeof location !== "undefined" && location.search &&
        new URLSearchParams(location.search).has("rtcdebug")) {
      try { localStorage.setItem(STORE_KEY, "1"); } catch { /* private mode */ }
      return true;
    }
    if (typeof localStorage !== "undefined" && localStorage.getItem(STORE_KEY) === "1") return true;
  } catch { /* no location/localStorage */ }
  return false;
}

// deltaOf returns cur - prev when prev is a finite baseline, else undefined (so the
// first tick carries no delta and the server renders just the current value). Pure.
export function deltaOf(cur, prev) {
  if (typeof cur !== "number" || !Number.isFinite(cur)) return undefined;
  if (typeof prev !== "number" || !Number.isFinite(prev)) return undefined;
  return cur - prev;
}

// codecName resolves an RTP stat's codecId to a short codec label ("VP8") via the
// codec stat's mimeType, dropping the "video/"|"audio/" prefix. "" if unknown.
function codecName(byId, codecId) {
  const c = codecId && byId.get(codecId);
  const m = c && c.mimeType;
  if (!m) return "";
  const slash = m.indexOf("/");
  return slash >= 0 ? m.slice(slash + 1) : m;
}

// num returns n when it's a finite number, else undefined (so absent getStats
// fields — common cross-browser, e.g. Firefox omits framesPerSecond inbound — are
// simply skipped rather than serialized as null).
function num(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

// cumulative copies a cumulative counter and its delta-vs-previous into the output
// object (keys `name` and `name_d`) and records the current value in raw under
// `rawKey` for next tick's delta. Skips absent values.
function cumulative(out, raw, rawKey, name, cur, prevRaw) {
  const v = num(cur);
  if (v === undefined) return;
  out[name] = v;
  raw[rawKey] = v;
  const d = deltaOf(v, prevRaw ? prevRaw[rawKey] : undefined);
  if (d !== undefined) out[name + "_d"] = d;
}

// buildSnapshot reduces a getStats() report to the wire snapshot's stats-derived
// part (in/out/pair/video_el) plus the `raw` cumulative map to feed back as
// prevRaw next tick. Connection states (ice/conn/sig) and correlation keys are
// added by the caller. Pure; unit-tested. `videoEl` is the remote tile's playback
// state (or null) since getStats can't see it.
export function buildSnapshot(report, prevRaw, videoEl) {
  const byId = new Map();
  report.forEach((s) => { byId.set(s.id, s); });

  const raw = {};
  const data = {};

  let inV = null, inA = null, outV = null, outA = null, pairStat = null;

  byId.forEach((s) => {
    if (s.type === "inbound-rtp") {
      if (s.kind === "video") inV = s; else if (s.kind === "audio") inA = s;
    } else if (s.type === "outbound-rtp") {
      if (s.kind === "video") outV = s; else if (s.kind === "audio") outA = s;
    } else if (s.type === "candidate-pair") {
      // Prefer the nominated/selected pair; fall back to a succeeded one.
      if (s.nominated || s.selected) pairStat = s;
      else if (!pairStat && s.state === "succeeded") pairStat = s;
    }
  });

  if (inV) data.in = { v: inboundRtp(byId, inV, raw, "in.v", prevRaw) };
  if (inA) { data.in = data.in || {}; data.in.a = inboundRtp(byId, inA, raw, "in.a", prevRaw); }
  if (outV) data.out = { v: outboundRtp(byId, outV, raw, "out.v", prevRaw) };
  if (outA) { data.out = data.out || {}; data.out.a = outboundRtp(byId, outA, raw, "out.a", prevRaw); }

  if (pairStat) {
    const local = byId.get(pairStat.localCandidateId);
    const remote = byId.get(pairStat.remoteCandidateId);
    const pair = {};
    // ONLY the candidate type — never address/ip/port/relatedAddress.
    if (local && local.candidateType) pair.local = local.candidateType;
    if (remote && remote.candidateType) pair.remote = remote.candidateType;
    const rtt = num(pairStat.currentRoundTripTime);
    if (rtt !== undefined) pair.rttMs = Math.round(rtt * 1000); // seconds → ms
    data.pair = pair;
  }

  if (videoEl) data.video_el = videoEl;

  return { data, raw };
}

function inboundRtp(byId, s, raw, key, prevRaw) {
  const o = {};
  const codec = codecName(byId, s.codecId);
  if (codec) o.codec = codec;
  if (num(s.framesPerSecond) !== undefined) o.fps = s.framesPerSecond;
  cumulative(o, raw, key + ".framesDecoded", "framesDecoded", s.framesDecoded, prevRaw);
  cumulative(o, raw, key + ".framesReceived", "framesReceived", s.framesReceived, prevRaw);
  if (num(s.keyFramesDecoded) !== undefined) o.keyFramesDecoded = s.keyFramesDecoded;
  cumulative(o, raw, key + ".bytes", "bytes", s.bytesReceived, prevRaw);
  cumulative(o, raw, key + ".packetsLost", "packetsLost", s.packetsLost, prevRaw);
  if (num(s.pliCount) !== undefined) o.pli = s.pliCount;
  if (num(s.jitter) !== undefined) o.jitter = s.jitter;
  return o;
}

function outboundRtp(byId, s, raw, key, prevRaw) {
  const o = {};
  const codec = codecName(byId, s.codecId);
  if (codec) o.codec = codec;
  if (num(s.framesPerSecond) !== undefined) o.fps = s.framesPerSecond;
  cumulative(o, raw, key + ".framesEncoded", "framesEncoded", s.framesEncoded, prevRaw);
  cumulative(o, raw, key + ".framesSent", "framesSent", s.framesSent, prevRaw);
  cumulative(o, raw, key + ".bytes", "bytes", s.bytesSent, prevRaw);
  if (s.qualityLimitationReason) o.qualityLimitation = s.qualityLimitationReason;
  if (num(s.targetBitrate) !== undefined) o.targetBitrate = s.targetBitrate;
  if (num(s.frameWidth) !== undefined) o.w = s.frameWidth;
  if (num(s.frameHeight) !== undefined) o.h = s.frameHeight;
  if (num(s.totalEncodeTime) !== undefined) o.totalEncodeTime = s.totalEncodeTime;
  if (s.encoderImplementation) o.encoderImpl = s.encoderImplementation;
  if (typeof s.powerEfficientEncoder === "boolean") o.powerEfficient = s.powerEfficientEncoder;
  return o;
}

// buildAggregate folds a tick's per-peer snapshot `data` objects into one
// node-level summary: how many peers, total outbound/inbound bitrate (summed
// byte deltas over intervalMs, rendered as kbps), and the worst (highest) RTT
// across all peers. This is the group-call lens — as N grows it makes uplink
// saturation visible at a glance without reading every per-peer line. Returns
// null when there's nothing to summarize. Pure; unit-tested.
export function buildAggregate(datas, intervalMs) {
  if (!datas || datas.length === 0) return null;
  let upBytes = 0, downBytes = 0, worstRtt;
  for (const d of datas) {
    if (!d) continue;
    if (d.out) upBytes += (d.out.v && d.out.v.bytes_d || 0) + (d.out.a && d.out.a.bytes_d || 0);
    if (d.in) downBytes += (d.in.v && d.in.v.bytes_d || 0) + (d.in.a && d.in.a.bytes_d || 0);
    const rtt = d.pair && d.pair.rttMs;
    if (typeof rtt === "number" && (worstRtt === undefined || rtt > worstRtt)) worstRtt = rtt;
  }
  const kbps = (bytes) => (intervalMs > 0 ? Math.round((bytes * 8) / intervalMs) : 0); // bytes*8b / ms = kb/s
  const agg = { peers: datas.length, up_kbps: kbps(upBytes), down_kbps: kbps(downBytes) };
  if (worstRtt !== undefined) agg.worst_rtt_ms = worstRtt;
  return agg;
}

// capPayload trims a batch so its serialized size fits maxBytes, dropping the
// OLDEST snapshots first and never touching events (rarer, higher-value). Returns
// the same batch object (mutated). Pure; unit-tested.
export function capPayload(batch, maxBytes) {
  while (batch.snapshots.length > 0 && JSON.stringify(batch).length > maxBytes) {
    batch.snapshots.shift();
  }
  return batch;
}

// --- impure capture/transport glue ----------------------------------------

// createTelemetry returns the hook object voice.js drives via registerDebug:
// startCall/endCall bracket a call, attachPeer/detachPeer track connections, and
// event() records a lifecycle moment. The returned object is inert until startCall.
export function createTelemetry({
  endpoint = "/api/debug/telemetry",
  intervalMs = SNAPSHOT_INTERVAL_MS,
  getVideoEl = null, // (remoteUserId) -> HTMLVideoElement | undefined
} = {}) {
  let callId = null, channelId = null;
  const peers = new Map();   // remoteUserId -> RTCPeerConnection
  const prevRaw = new Map(); // remoteUserId -> raw cumulative map
  let snapQ = [], evtQ = [], aggQ = [];
  let snapTimer = null, flushTimer = null, unloadWired = false;

  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const now = () => (typeof performance !== "undefined" ? Math.round(performance.now()) : 0);
  const wall = () => Date.now();
  const genId = () => {
    try { return crypto.randomUUID(); } catch { return "c" + now() + "-" + Math.floor(wall() % 1e6); }
  };

  function startCall(ch, _myId) {
    callId = genId();
    channelId = ch;
    snapQ = []; evtQ = []; aggQ = [];
    if (!snapTimer) snapTimer = setInterval(tick, intervalMs);
    if (!flushTimer) flushTimer = setInterval(() => flush(false), FLUSH_INTERVAL_MS);
    wireUnload();
    event(0, "join", { channel_id: ch });
  }

  function endCall() {
    event(0, "leave", {});
    flush(false);
    peers.clear(); prevRaw.clear();
    if (snapTimer) { clearInterval(snapTimer); snapTimer = null; }
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    callId = null; channelId = null;
  }

  function attachPeer(remoteUserId, pc) { peers.set(remoteUserId, pc); }
  function detachPeer(remoteUserId) { peers.delete(remoteUserId); prevRaw.delete(remoteUserId); }

  function event(remoteUserId, kind, data) {
    if (callId === null) return;
    evtQ.push({
      call_id: callId, channel_id: channelId, remote_user_id: remoteUserId || 0,
      t: now(), ts: wall(), kind, data: data || {},
    });
    // A state transition is high-value — flush it promptly rather than waiting.
    if (kind && kind.indexOf("state") >= 0 || kind === "ice-restart-attempt" || kind === "ice-restart-giveup") {
      flush(false);
    }
  }

  function readVideoEl(remoteUserId) {
    if (!getVideoEl) return null;
    let el;
    try { el = getVideoEl(remoteUserId); } catch { return null; }
    if (!el) return null;
    return {
      paused: !!el.paused,
      currentTime: typeof el.currentTime === "number" ? Math.round(el.currentTime * 10) / 10 : undefined,
      readyState: typeof el.readyState === "number" ? el.readyState : undefined,
      w: el.videoWidth || undefined,
      h: el.videoHeight || undefined,
    };
  }

  async function tick() {
    if (callId === null) return;
    const datas = [];
    for (const [id, pc] of peers) {
      try {
        const report = await pc.getStats();
        const { data, raw } = buildSnapshot(report, prevRaw.get(id), readVideoEl(id));
        prevRaw.set(id, raw);
        datas.push(data);
        snapQ.push({
          call_id: callId, channel_id: channelId, remote_user_id: id,
          t: now(), ts: wall(),
          ice: pc.iceConnectionState, conn: pc.connectionState, sig: pc.signalingState,
          ...data,
        });
      } catch { /* never let a stats hiccup affect the call */ }
    }
    // One node-level aggregate per tick: total up/down bitrate, peer count, worst
    // RTT — the group-call uplink-saturation lens as N grows.
    const agg = buildAggregate(datas, intervalMs);
    if (agg) aggQ.push({ call_id: callId, channel_id: channelId, t: now(), ts: wall(), ...agg });
    if (snapQ.length >= MAX_QUEUED_SNAPSHOTS) flush(false);
  }

  function flush(useBeacon) {
    if (snapQ.length === 0 && evtQ.length === 0 && aggQ.length === 0) return;
    const batch = { ua, snapshots: snapQ, events: evtQ, aggregates: aggQ };
    snapQ = []; evtQ = []; aggQ = [];
    try {
      if (useBeacon) {
        capPayload(batch, MAX_BEACON_BYTES);
        const blob = new Blob([JSON.stringify(batch)], { type: "application/json" });
        navigator.sendBeacon(endpoint, blob);
      } else {
        capPayload(batch, MAX_BODY_BYTES);
        fetch(endpoint, {
          method: "POST", credentials: "same-origin", keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch),
        }).catch(() => {});
      }
    } catch { /* best-effort; drop on failure */ }
  }

  function wireUnload() {
    if (unloadWired || typeof window === "undefined") return;
    unloadWired = true;
    const onHide = () => { if (callId !== null) flush(true); };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("visibilitychange", () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") onHide();
    });
  }

  return { startCall, endCall, attachPeer, detachPeer, event };
}
