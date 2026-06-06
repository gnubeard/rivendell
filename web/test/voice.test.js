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
