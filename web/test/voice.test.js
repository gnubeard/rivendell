// voice.test.js — guards the self join/leave tone ORDERING relative to the mic.
//
// This is the bug that regressed three times: the self-greet must play in the
// live-capture steady state (AFTER getUserMedia resolves) and the self-farewell
// must play while the mic is still live (BEFORE the track is stopped). Playing
// either one in the capture start/stop device transition clips/drops it. We
// don't test audio output here (no Web Audio in node) — we record a timeline of
// the relevant events and assert their relative order, which is the invariant
// that broke. See voice.js for the full reasoning.

import test from "node:test";
import assert from "node:assert/strict";

// --- minimal browser-global mocks, installed before importing voice.js -------

const timeline = [];

// A fake mic stream whose track.stop() records "mic-stop" on the timeline.
function makeFakeStream() {
  const track = {
    kind: "audio",
    enabled: true,
    stop() { timeline.push("mic-stop"); },
  };
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
}

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  writable: true,
  value: {
    mediaDevices: {
      // Resolving getUserMedia means the capture is open ("mic-open").
      getUserMedia: async () => {
        timeline.push("mic-open");
        return makeFakeStream();
      },
    },
  },
});

const voice = await import("../static/voice.js");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  timeline.length = 0;
  voice.initVoice(
    1,                       // myUserId
    () => {},                // socketSend — irrelevant here
    () => {},                // onStateChange
    () => timeline.push("greet"),
    () => timeline.push("farewell"),
  );
}

test("self-greet fires AFTER the mic is live (steady-state capture)", async () => {
  setup();
  await voice.joinVoiceChannel(42);
  // The greet is scheduled a short settle after getUserMedia resolves; wait it
  // out. The mic must already be open by the time it fires.
  await delay(400);
  assert.deepEqual(timeline, ["mic-open", "greet"]);
});

test("self-farewell fires BEFORE the mic is torn down (steady-state capture)", async () => {
  setup();
  await voice.joinVoiceChannel(42);
  await delay(400);
  timeline.length = 0; // drop the join events; focus on the leave order
  await voice.leaveVoiceChannel();
  // Farewell must come before the track stop, never after it.
  assert.deepEqual(timeline, ["farewell", "mic-stop"]);
  assert.ok(
    timeline.indexOf("farewell") < timeline.indexOf("mic-stop"),
    "farewell must precede mic teardown",
  );
});

test("endCallLocally also farewells before tearing the mic down", async () => {
  setup();
  await voice.joinVoiceChannel(42);
  await delay(400);
  timeline.length = 0;
  await voice.endCallLocally();
  assert.deepEqual(timeline, ["farewell", "mic-stop"]);
});

// --- speaking detection: computeRMS (pure) ----------------------------------
// The speaking ring fires when an AnalyserNode frame's RMS crosses a threshold.
// The AnalyserNode itself is browser-only, but the RMS math is pure and is the
// part most likely to regress (off-by-one in the mean, NaN on empty frames).

test("computeRMS of an empty or missing frame is 0 (no NaN)", () => {
  assert.equal(voice.computeRMS(new Float32Array(0)), 0);
  assert.equal(voice.computeRMS([]), 0);
  assert.equal(voice.computeRMS(null), 0);
  assert.equal(voice.computeRMS(undefined), 0);
});

test("computeRMS of pure silence is 0", () => {
  assert.equal(voice.computeRMS(new Float32Array(256)), 0);
});

test("computeRMS of a constant signal is its magnitude", () => {
  const f = new Float32Array(100).fill(0.5);
  assert.ok(Math.abs(voice.computeRMS(f) - 0.5) < 1e-9);
});

test("computeRMS of a full-scale square wave is 1", () => {
  const f = Float32Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : -1));
  assert.ok(Math.abs(voice.computeRMS(f) - 1) < 1e-9);
});

test("computeRMS of a sine wave is ~amplitude/sqrt(2)", () => {
  const N = 2048, amp = 0.8;
  const f = Float32Array.from({ length: N }, (_, i) => amp * Math.sin((2 * Math.PI * i) / N));
  assert.ok(Math.abs(voice.computeRMS(f) - amp / Math.SQRT2) < 1e-3);
});

test("computeRMS rises with louder signals (threshold ordering holds)", () => {
  const quiet = new Float32Array(256).fill(0.005);
  const loud = new Float32Array(256).fill(0.05);
  assert.ok(voice.computeRMS(quiet) < voice.computeRMS(loud));
});

// --- per-user volume --------------------------------------------------------
// The playout gain is clamped to [0,1]; anything non-numeric falls back to 1
// (unchanged) so a corrupt stored value can never silence or over-drive a peer.

test("clampVolume keeps in-range values untouched", () => {
  assert.equal(voice.clampVolume(0), 0);
  assert.equal(voice.clampVolume(1), 1);
  assert.equal(voice.clampVolume(0.5), 0.5);
});

test("clampVolume bounds out-of-range values to [0,1]", () => {
  assert.equal(voice.clampVolume(-0.5), 0);
  assert.equal(voice.clampVolume(2), 1);
  assert.equal(voice.clampVolume(Infinity), 1);
});

test("clampVolume falls back to 1 (unchanged) on non-finite input", () => {
  assert.equal(voice.clampVolume(NaN), 1);
  assert.equal(voice.clampVolume(undefined), 1);
  assert.equal(voice.clampVolume(null), 1); // Number(null) === 0, but treat as unset
  assert.equal(voice.clampVolume("nope"), 1);
});

test("get/setVolumeForUser round-trips and defaults unset users to 1", () => {
  assert.equal(voice.getVolumeForUser(9999), 1); // never set -> unchanged
  voice.setVolumeForUser(9999, 0.3);
  assert.equal(voice.getVolumeForUser(9999), 0.3);
  voice.setVolumeForUser(9999, 5); // clamped on the way in
  assert.equal(voice.getVolumeForUser(9999), 1);
});
