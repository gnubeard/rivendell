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
function makeFakeStream({ includeVideo = false } = {}) {
  const audioTrack = {
    kind: "audio",
    enabled: true,
    stop() { timeline.push("mic-stop"); },
  };
  const videoTrack = {
    kind: "video",
    enabled: true,
    stop() { timeline.push("cam-stop"); },
  };
  const tracks = includeVideo ? [audioTrack, videoTrack] : [audioTrack];
  return {
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => includeVideo ? [videoTrack] : [],
    addTrack: () => {},
    removeTrack: () => {},
    getTracks: () => tracks,
  };
}

// Configurable getUserMedia: by default audio-only; tests that need camera can
// set getUserMediaVideo = true before joining.
let getUserMediaVideo = false;
let getUserMediaRejectWith = null;

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  writable: true,
  value: {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        if (getUserMediaRejectWith) throw getUserMediaRejectWith;
        const includeVideo = !!(constraints && constraints.video && getUserMediaVideo);
        if (includeVideo) timeline.push("cam-open");
        timeline.push("mic-open");
        return makeFakeStream({ includeVideo });
      },
    },
  },
});

const voice = await import("../static/voice.js");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  timeline.length = 0;
  getUserMediaVideo = false;
  getUserMediaRejectWith = null;
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

// --- reconnection on peer failure (ICE restart) -----------------------------
// The reconnection policy lives in two pure functions. The timer/RTCPeerConnection
// plumbing is browser-only, but the decisions (who restarts, when, and when to
// give up) are the part that must stay correct.

test("reconnectPlan: a healthy connection clears any pending reconnect", () => {
  for (const st of ["connected", "completed", "closed"]) {
    assert.deepEqual(voice.reconnectPlan(st, true), { action: "clear" });
    assert.deepEqual(voice.reconnectPlan(st, false), { action: "clear" });
  }
});

test("reconnectPlan: offerer restarts on failure (now) and on disconnect (after grace)", () => {
  const failed = voice.reconnectPlan("failed", true);
  assert.equal(failed.action, "restart");
  assert.equal(failed.delayMs, 0); // failed is terminal for that ICE generation — act now

  const disc = voice.reconnectPlan("disconnected", true);
  assert.equal(disc.action, "restart");
  assert.ok(disc.delayMs > 0); // disconnected may self-heal — give it a grace window
});

test("reconnectPlan: answerer never initiates — waits on disconnect, drops a stuck-failed peer", () => {
  assert.deepEqual(voice.reconnectPlan("disconnected", false), { action: "none" });
  const failed = voice.reconnectPlan("failed", false);
  assert.equal(failed.action, "drop");
  assert.ok(failed.delayMs > 0); // safety net only, after a long wait
});

test("reconnectPlan: unknown/transient states do nothing", () => {
  assert.deepEqual(voice.reconnectPlan("new", true), { action: "none" });
  assert.deepEqual(voice.reconnectPlan("connecting", false), { action: "none" });
});

test("restartOutcome: a recovered/closed connection stops the restart loop", () => {
  for (const st of ["connected", "completed", "closed"]) {
    assert.equal(voice.restartOutcome(st, 0, 4, true), "recovered");
  }
});

test("restartOutcome: a peer that left the roster is closed, not restarted", () => {
  assert.equal(voice.restartOutcome("failed", 0, 4, false), "gone");
});

test("restartOutcome: restarts are bounded, then we give up", () => {
  assert.equal(voice.restartOutcome("failed", 0, 4, true), "restart");
  assert.equal(voice.restartOutcome("failed", 3, 4, true), "restart");
  assert.equal(voice.restartOutcome("failed", 4, 4, true), "give-up");
  assert.equal(voice.restartOutcome("disconnected", 5, 4, true), "give-up");
});

// --- push-to-talk gating (pttShouldFire) ------------------------------------
// PTT fires only when enabled, in a call, the physical key matches, AND the
// event isn't from a text field — the editable guard is what keeps the bound
// key (backtick by default) usable for typing in the composer.

test("pttShouldFire: fires on the bound key when enabled, in a call, outside a field", () => {
  assert.equal(
    voice.pttShouldFire({ enabled: true, inCall: true, code: "Backquote", boundCode: "Backquote", editable: false }),
    true,
  );
});

test("pttShouldFire: off unless PTT is enabled and we're in a call", () => {
  const base = { code: "Backquote", boundCode: "Backquote", editable: false };
  assert.equal(voice.pttShouldFire({ ...base, enabled: false, inCall: true }), false);
  assert.equal(voice.pttShouldFire({ ...base, enabled: true, inCall: false }), false);
});

test("pttShouldFire: a non-matching key never fires", () => {
  assert.equal(
    voice.pttShouldFire({ enabled: true, inCall: true, code: "KeyT", boundCode: "Backquote", editable: false }),
    false,
  );
});

test("pttShouldFire: never fires from inside a text field (key still types there)", () => {
  assert.equal(
    voice.pttShouldFire({ enabled: true, inCall: true, code: "Backquote", boundCode: "Backquote", editable: true }),
    false,
  );
});

test("pttShouldFire: a missing code never fires", () => {
  assert.equal(
    voice.pttShouldFire({ enabled: true, inCall: true, code: "", boundCode: "", editable: false }),
    false,
  );
});

// --- pttKeyLabel ------------------------------------------------------------

test("pttKeyLabel maps common codes to short human labels", () => {
  assert.equal(voice.pttKeyLabel("Backquote"), "`");
  assert.equal(voice.pttKeyLabel("Space"), "Space");
  assert.equal(voice.pttKeyLabel("KeyT"), "T");
  assert.equal(voice.pttKeyLabel("Digit5"), "5");
  assert.equal(voice.pttKeyLabel("Numpad0"), "Num 0");
  assert.equal(voice.pttKeyLabel("ArrowUp"), "Up arrow");
  assert.equal(voice.pttKeyLabel("F8"), "F8"); // unknown -> verbatim
  assert.equal(voice.pttKeyLabel(""), "—");
});

// --- micErrorMessage --------------------------------------------------------
// getUserMedia rejections must surface a friendly, specific line keyed off the
// stable .name, never the raw exception text.

test("micErrorMessage maps known getUserMedia errors to actionable text", () => {
  assert.match(voice.micErrorMessage({ name: "NotAllowedError" }), /blocked/i);
  assert.match(voice.micErrorMessage({ name: "SecurityError" }), /blocked/i);
  assert.match(voice.micErrorMessage({ name: "NotFoundError" }), /no microphone/i);
  assert.match(voice.micErrorMessage({ name: "NotReadableError" }), /in use|unavailable/i);
  // AbortError ("Starting audioinput failed") is a device-start failure, same class.
  assert.match(voice.micErrorMessage({ name: "AbortError" }), /in use|unavailable/i);
});

test("micErrorMessage falls back gracefully for unknown / missing errors", () => {
  assert.match(voice.micErrorMessage({ name: "WeirdError", message: "boom" }), /boom/);
  assert.match(voice.micErrorMessage(null), /Could not access the microphone/);
  assert.match(voice.micErrorMessage({}), /Could not access the microphone/);
});

// --- cameraErrorMessage -----------------------------------------------------

test("cameraErrorMessage maps known getUserMedia errors to actionable text", () => {
  assert.match(voice.cameraErrorMessage({ name: "NotAllowedError" }), /blocked/i);
  assert.match(voice.cameraErrorMessage({ name: "SecurityError" }), /blocked/i);
  assert.match(voice.cameraErrorMessage({ name: "NotFoundError" }), /no camera/i);
  assert.match(voice.cameraErrorMessage({ name: "OverconstrainedError" }), /no camera/i);
  assert.match(voice.cameraErrorMessage({ name: "NotReadableError" }), /in use|unavailable/i);
  // AbortError is Chromium's "Starting videoinput failed" on Android — a device
  // start failure, not a constraints problem. Must not hit the raw-message default.
  assert.match(voice.cameraErrorMessage({ name: "AbortError" }), /in use|rejoin/i);
  assert.doesNotMatch(voice.cameraErrorMessage({ name: "AbortError", message: "Starting videoinput failed" }), /Starting videoinput failed/);
});

test("cameraErrorMessage falls back gracefully for unknown / missing errors", () => {
  assert.match(voice.cameraErrorMessage({ name: "WeirdError", message: "kaboom" }), /kaboom/);
  assert.match(voice.cameraErrorMessage(null), /Could not access the camera/);
  assert.match(voice.cameraErrorMessage({}), /Could not access the camera/);
});

// --- shouldRetryRelaxed -----------------------------------------------------

test("shouldRetryRelaxed retries everything except a permission denial", () => {
  // A permission denial won't be fixed by relaxing constraints.
  assert.equal(voice.shouldRetryRelaxed({ name: "NotAllowedError" }), false);
  assert.equal(voice.shouldRetryRelaxed({ name: "SecurityError" }), false);
  // Constraint/transient failures are worth a relaxed `video: true` retry —
  // this is the Android OverconstrainedError case that was failing silently.
  assert.equal(voice.shouldRetryRelaxed({ name: "OverconstrainedError" }), true);
  assert.equal(voice.shouldRetryRelaxed({ name: "NotReadableError" }), true);
  assert.equal(voice.shouldRetryRelaxed({ name: "NotFoundError" }), true);
  // Unknown / missing error names default to retrying (best-effort).
  assert.equal(voice.shouldRetryRelaxed({ name: "WeirdError" }), true);
  assert.equal(voice.shouldRetryRelaxed(null), true);
  assert.equal(voice.shouldRetryRelaxed({}), true);
});

// --- needsLandscapeCoercion / landscapeConstraintLadder ---------------------
// Safety net for cameras that open square/portrait. These pure helpers decide
// when to intervene and what to try; coerceLandscapeCapture (effectful, not
// unit-tested) walks them. The ladder leads with 4:3 because a 4:3-native sensor
// (e.g. the Pixel 7 Pro) has no 16:9 mode to coerce to.

test("needsLandscapeCoercion flags square and portrait, passes landscape", () => {
  assert.equal(voice.needsLandscapeCoercion({ width: 360, height: 360 }), true);  // square
  assert.equal(voice.needsLandscapeCoercion({ width: 480, height: 640 }), true);  // portrait
  assert.equal(voice.needsLandscapeCoercion({ width: 640, height: 360 }), false); // already landscape
  assert.equal(voice.needsLandscapeCoercion({ width: 480, height: 360 }), false); // 4:3 landscape (Pixel native)
  assert.equal(voice.needsLandscapeCoercion({ width: 1280, height: 720 }), false);
});

test("needsLandscapeCoercion doesn't gamble on unknown dimensions", () => {
  // No getSettings support / missing dims → leave the track alone (don't churn
  // applyConstraints on a track we can't measure).
  assert.equal(voice.needsLandscapeCoercion({}), false);
  assert.equal(voice.needsLandscapeCoercion(null), false);
  assert.equal(voice.needsLandscapeCoercion({ width: 640 }), false);
  assert.equal(voice.needsLandscapeCoercion({ height: 360 }), false);
});

test("landscapeConstraintLadder is exact, landscape, and even-dimensioned throughout", () => {
  const ladder = voice.landscapeConstraintLadder();
  assert.ok(ladder.length >= 1);
  // 4:3 is tried first — it's the only family a 4:3-native sensor (Pixel) has.
  assert.deepEqual(ladder[0], { width: { exact: 480 }, height: { exact: 360 } });
  for (const c of ladder) {
    const w = c.width.exact, h = c.height.exact;
    assert.ok(w > h, "every rung is landscape (the whole point — escape the square)");
    // VP8 requires even dimensions; macroblock padding handles non-multiples of 16
    // (360p is the canonical WebRTC profile), so even — not 16-aligned — is the bar.
    assert.equal(w % 2, 0, "width is even");
    assert.equal(h % 2, 0, "height is even");
  }
});

// --- camera toggle lifecycle ------------------------------------------------
// When joining with camera off, track.enabled is not set for video. When camera
// is toggled on later, the video track becomes enabled. This is the state
// transition the onnegotiationneeded path relies on.

test("joinVoiceChannel with camera off: no video track in stream", async () => {
  setup();
  await voice.joinVoiceChannel(42, { enableVideo: false });
  assert.equal(voice.isCameraEnabled(), false);
  await voice.leaveVoiceChannel();
});

test("joinVoiceChannel with camera on: cameraEnabled is true", async () => {
  setup();
  getUserMediaVideo = true;
  await voice.joinVoiceChannel(42, { enableVideo: true });
  assert.equal(voice.isCameraEnabled(), true);
  await voice.leaveVoiceChannel();
});

// Mid-call camera enable: the join-time mic must be RELEASED before the combined
// audio+video acquire, or the acquire fails on Android (the audio HAL is exclusive
// and won't open a second session while the first is live). This guards the
// ordering — stopping the mic only after a successful acquire (the old code) meant
// the acquire never succeeded on Android, which was the recurring bug.
test("mid-call camera enable releases the mic before the combined acquire", async () => {
  setup();
  await voice.joinVoiceChannel(42, { enableVideo: false });
  await delay(400);
  timeline.length = 0;

  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints && constraints.video) {
      timeline.push("combined-acquire");
      return makeFakeStream({ includeVideo: true });
    }
    timeline.push("mic-open");
    return makeFakeStream({ includeVideo: false });
  };

  await voice.setCameraEnabled(true);
  assert.equal(voice.isCameraEnabled(), true);
  assert.ok(timeline.includes("mic-stop"), "the join-time mic must be released");
  assert.ok(timeline.includes("combined-acquire"), "a combined audio+video stream must be acquired");
  assert.ok(
    timeline.indexOf("mic-stop") < timeline.indexOf("combined-acquire"),
    "the mic must be released BEFORE the combined acquire (Android HAL is exclusive)",
  );

  await voice.leaveVoiceChannel();
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const includeVideo = !!(constraints && constraints.video && getUserMediaVideo);
    if (includeVideo) timeline.push("cam-open");
    timeline.push("mic-open");
    return makeFakeStream({ includeVideo });
  };
});

// If the camera acquire fails mid-call, the released mic must be re-acquired so the
// call survives audio-only (rather than going silently mute), and the error must be
// surfaced via the onCameraError callback.
test("mid-call camera failure restores audio-only and reports the error", async () => {
  setup();
  let reported = null;
  voice.setCameraErrorCallback((err) => { reported = err; });

  await voice.joinVoiceChannel(42, { enableVideo: false });
  await delay(400);
  timeline.length = 0;

  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints && constraints.video) {
      const err = new Error("Starting videoinput failed"); err.name = "NotReadableError"; throw err;
    }
    timeline.push("mic-reopen");
    return makeFakeStream({ includeVideo: false });
  };

  await voice.setCameraEnabled(true);
  assert.equal(voice.isCameraEnabled(), false, "camera stays off after a failed acquire");
  assert.ok(voice.isInCall(), "the call must survive a camera failure");
  assert.ok(timeline.includes("mic-stop"), "the original mic was released");
  assert.ok(timeline.includes("mic-reopen"), "audio-only was re-acquired so the call isn't left mute");
  assert.ok(reported && reported.name === "NotReadableError", "the camera error is surfaced to the UI");

  voice.setCameraErrorCallback(null);
  await voice.leaveVoiceChannel();
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const includeVideo = !!(constraints && constraints.video && getUserMediaVideo);
    if (includeVideo) timeline.push("cam-open");
    timeline.push("mic-open");
    return makeFakeStream({ includeVideo });
  };
});

test("camera failure on join falls back to audio-only, call still works", async () => {
  setup();
  // Simulate getUserMedia rejecting only for video (first call fails, second succeeds)
  let callCount = 0;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    callCount++;
    if (callCount === 1 && constraints.video) {
      const err = new Error("blocked"); err.name = "NotAllowedError"; throw err;
    }
    timeline.push("mic-open");
    return makeFakeStream({ includeVideo: false });
  };
  await voice.joinVoiceChannel(42, { enableVideo: true });
  // Camera failure should have fallen back: cameraEnabled is false, call is live
  assert.equal(voice.isCameraEnabled(), false);
  assert.ok(voice.isInCall());
  await voice.leaveVoiceChannel();
  // Restore mock
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    timeline.push("mic-open");
    return makeFakeStream({ includeVideo: getUserMediaVideo && !!(constraints && constraints.video) });
  };
});

// --- VP8-first codec ordering (Firefox-Android HW H.264 encoder workaround) ---

test("orderVideoCodecsVP8First puts VP8 then VP9 ahead of H.264", () => {
  const input = [
    { mimeType: "video/H264" },
    { mimeType: "video/VP9" },
    { mimeType: "video/VP8" },
  ];
  const out = voice.orderVideoCodecsVP8First(input).map(c => c.mimeType);
  assert.deepEqual(out, ["video/VP8", "video/VP9", "video/H264"]);
});

test("orderVideoCodecsVP8First keeps all codecs and middle-rank relative order", () => {
  const input = [
    { mimeType: "video/H264" },
    { mimeType: "video/rtx" },
    { mimeType: "video/red" },
    { mimeType: "video/VP8" },
    { mimeType: "video/ulpfec" },
  ];
  const out = voice.orderVideoCodecsVP8First(input).map(c => c.mimeType);
  // VP8 first, H264 last; rtx/red/ulpfec retained in their original relative order.
  assert.deepEqual(out, ["video/VP8", "video/rtx", "video/red", "video/ulpfec", "video/H264"]);
});

test("orderVideoCodecsVP8First is a pure copy (does not mutate input)", () => {
  const input = [{ mimeType: "video/H264" }, { mimeType: "video/VP8" }];
  const before = input.map(c => c.mimeType);
  voice.orderVideoCodecsVP8First(input);
  assert.deepEqual(input.map(c => c.mimeType), before);
});

test("orderVideoCodecsVP8First tolerates junk input", () => {
  assert.deepEqual(voice.orderVideoCodecsVP8First(null), []);
  assert.deepEqual(voice.orderVideoCodecsVP8First(undefined), []);
  assert.deepEqual(voice.orderVideoCodecsVP8First("nope"), []);
  // entries without mimeType keep middle rank and don't throw
  const out = voice.orderVideoCodecsVP8First([{}, { mimeType: "video/VP8" }]);
  assert.equal(out[0].mimeType, "video/VP8");
  assert.equal(out.length, 2);
});

// --- fmtDelta (RTC HUD counter deltas) --------------------------------------

test("fmtDelta shows cur(+delta) against the previous refresh value", () => {
  assert.equal(voice.fmtDelta(13, 7), "13(+6)");   // advancing
  assert.equal(voice.fmtDelta(7, 7), "7(+0)");     // stalled — the freeze signal
  assert.equal(voice.fmtDelta(21643, 10642), "21643(+11001)"); // bytes climbing
});

test("fmtDelta handles first-sample and missing counters", () => {
  assert.equal(voice.fmtDelta(7, null), "7(+?)");        // no baseline yet
  assert.equal(voice.fmtDelta(7, undefined), "7(+?)");
  assert.equal(voice.fmtDelta(undefined, 5), "?");       // counter absent (e.g. Firefox)
  assert.equal(voice.fmtDelta(null, 5), "?");
});

test("fmtDelta renders a counter reset as a negative delta, not a crash", () => {
  // A counter going backwards (reconnect / stat reset) shows a signed negative.
  assert.equal(voice.fmtDelta(2, 9), "2(-7)");
});
