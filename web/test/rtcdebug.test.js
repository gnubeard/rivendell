// rtcdebug.test.js — pure helpers for WebRTC debug telemetry capture.
//
// The capture/transport glue (createTelemetry) is browser-only and exercised
// manually; these tests pin the pure surface: delta computation, the getStats
// reduction (incl. the invariant that NO candidate IP can reach the wire), the
// payload size cap, and the enable toggle.

import test from "node:test";
import assert from "node:assert/strict";

import { deltaOf, buildSnapshot, capPayload, rtcDebugEnabled } from "../static/rtcdebug.js";

// makeReport builds a Map that quacks like an RTCStatsReport (forEach(value,key)).
function makeReport(stats) {
  const m = new Map();
  for (const s of stats) m.set(s.id, s);
  return m;
}

function fullReport(framesDecoded) {
  return makeReport([
    {
      id: "IV", type: "inbound-rtp", kind: "video", codecId: "CODV",
      framesDecoded, framesReceived: framesDecoded + 10, keyFramesDecoded: 12,
      bytesReceived: 1000000, packetsLost: 3, pliCount: 1, jitter: 0.004, framesPerSecond: 24,
    },
    {
      id: "OV", type: "outbound-rtp", kind: "video", codecId: "CODV",
      framesEncoded: 5300, framesSent: 5305, bytesSent: 900000,
      qualityLimitationReason: "none", targetBitrate: 900000,
      frameWidth: 640, frameHeight: 480, totalEncodeTime: 2.45,
      encoderImplementation: "libvpx", powerEfficientEncoder: false, framesPerSecond: 24,
    },
    { id: "CODV", type: "codec", mimeType: "video/VP8" },
    { id: "CP", type: "candidate-pair", nominated: true, localCandidateId: "LC", remoteCandidateId: "RC", currentRoundTripTime: 0.034 },
    // Candidate stats deliberately carry address/ip/port — buildSnapshot must NOT read them.
    { id: "LC", type: "local-candidate", candidateType: "srflx", address: "192.168.1.50", ip: "192.168.1.50", port: 54321 },
    { id: "RC", type: "remote-candidate", candidateType: "host", address: "203.0.113.7", ip: "203.0.113.7", port: 3478 },
  ]);
}

test("deltaOf returns cur-prev only with a finite baseline", () => {
  assert.equal(deltaOf(5487, 5400), 87);
  assert.equal(deltaOf(3, 3), 0);
  assert.equal(deltaOf(5, undefined), undefined); // first tick, no baseline
  assert.equal(deltaOf(NaN, 1), undefined);
  assert.equal(deltaOf(undefined, 1), undefined);
});

test("buildSnapshot extracts stats, resolves codec, computes deltas", () => {
  const first = buildSnapshot(fullReport(5400), undefined, null);
  assert.equal(first.data.in.v.codec, "VP8");
  assert.equal(first.data.in.v.framesDecoded, 5400);
  assert.equal(first.data.in.v.framesDecoded_d, undefined); // no baseline yet
  assert.equal(first.data.in.v.pli, 1);
  assert.equal(first.data.in.v.jitter, 0.004);
  assert.equal(first.data.out.v.framesEncoded, 5300);
  assert.equal(first.data.out.v.encoderImpl, "libvpx");
  assert.equal(first.data.out.v.powerEfficient, false);
  assert.equal(first.data.out.v.w, 640);
  assert.equal(first.data.pair.local, "srflx");
  assert.equal(first.data.pair.remote, "host");
  assert.equal(first.data.pair.rttMs, 34); // 0.034s → 34ms
  assert.equal(first.raw["in.v.framesDecoded"], 5400);

  // Second tick with the prior raw values produces a delta.
  const second = buildSnapshot(fullReport(5487), first.raw, null);
  assert.equal(second.data.in.v.framesDecoded, 5487);
  assert.equal(second.data.in.v.framesDecoded_d, 87);
});

test("buildSnapshot never leaks a candidate IP address", () => {
  const { data } = buildSnapshot(fullReport(5400), undefined, null);
  const json = JSON.stringify(data);
  assert.ok(!json.includes("192.168"), "leaked local IP: " + json);
  assert.ok(!json.includes("203.0.113"), "leaked remote IP: " + json);
  assert.ok(!json.includes("address"), "leaked an address field: " + json);
  assert.ok(!json.includes("54321"), "leaked a port: " + json);
});

test("buildSnapshot embeds the provided video element state", () => {
  const vel = { paused: false, currentTime: 12.3, readyState: 4, w: 640, h: 480 };
  const { data } = buildSnapshot(fullReport(5400), undefined, vel);
  assert.deepEqual(data.video_el, vel);
});

test("capPayload drops oldest snapshots, never events", () => {
  const batch = { ua: "x", snapshots: [], events: [{ kind: "join" }, { kind: "leave" }] };
  for (let i = 0; i < 20; i++) batch.snapshots.push({ i, blob: "y".repeat(100) });
  capPayload(batch, 500);
  assert.ok(JSON.stringify(batch).length <= 500, "still over cap");
  assert.equal(batch.events.length, 2, "events must be preserved");
  // The newest snapshot is the one kept (oldest dropped from the front).
  if (batch.snapshots.length > 0) {
    assert.equal(batch.snapshots[batch.snapshots.length - 1].i, 19);
  }
});

test("rtcDebugEnabled honours the server flag; off by default in node", () => {
  assert.equal(rtcDebugEnabled(true), true);
  assert.equal(rtcDebugEnabled(false), false); // no location/localStorage in node
});
