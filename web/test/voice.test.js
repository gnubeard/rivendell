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

// Every fake stream handed out by getUserMedia, in creation order — lets a test
// assert which call's stream got stopped (each track flips `stopped` on stop()).
const createdStreams = [];

// A fake mic stream whose track.stop() records "mic-stop" on the timeline.
function makeFakeStream({ includeVideo = false } = {}) {
  const audioTrack = {
    kind: "audio",
    enabled: true,
    stopped: false,
    stop() { this.stopped = true; timeline.push("mic-stop"); },
  };
  const videoTrack = {
    kind: "video",
    enabled: true,
    stopped: false,
    stop() { this.stopped = true; timeline.push("cam-stop"); },
  };
  const tracks = includeVideo ? [audioTrack, videoTrack] : [audioTrack];
  const stream = {
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    addTrack: (t) => { if (t && !tracks.includes(t)) tracks.push(t); },
    removeTrack: (t) => { const i = tracks.indexOf(t); if (i >= 0) tracks.splice(i, 1); },
    getTracks: () => tracks.slice(),
  };
  createdStreams.push(stream);
  return stream;
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

// Minimal in-memory localStorage so the per-channel camera preference (and the
// per-user volume store) persist within a test run instead of silently no-op'ing.
const lsStore = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); },
    removeItem: (k) => { lsStore.delete(k); },
    clear: () => { lsStore.clear(); },
  },
});

const voice = await import("../static/voice.js");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Frames the code under test pushed to the socket (populated by setup()'s send).
let sent = [];

// Reinstalls the default getUserMedia mock after a test swapped it out.
function restoreGetUserMedia() {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (getUserMediaRejectWith) throw getUserMediaRejectWith;
    const includeVideo = !!(constraints && constraints.video && getUserMediaVideo);
    if (includeVideo) timeline.push("cam-open");
    timeline.push("mic-open");
    return makeFakeStream({ includeVideo });
  };
}

function setup() {
  timeline.length = 0;
  sent = [];
  createdStreams.length = 0;
  lsStore.clear();
  getUserMediaVideo = false;
  getUserMediaRejectWith = null;
  voice.initVoice(
    1,                       // myUserId
    (obj) => { sent.push(obj); }, // socketSend — captured for assertions
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

// Regression: a call started during the farewell-tone wait of the previous call
// must keep its own mic. The leave defers the mic release behind the tone; if
// that stale teardown stopped the module-level localStream, it would kill the
// brand-new call's mic (and reuse its half-closed peer — the m-line mismatch
// that flaked the e2e glare test). The generation guard (callGen) prevents it.
test("rapid re-join during the farewell wait keeps the new call's mic live", async () => {
  setup();
  await voice.joinVoiceChannel(42);
  await delay(400);
  const firstStream = createdStreams[createdStreams.length - 1];

  // End the call but DON'T await — leave() is now mid farewell-tone wait.
  const leaving = voice.endCallLocally();
  // Immediately start a new call (the quick hang-up-then-call window).
  await voice.joinVoiceChannel(43);
  const secondStream = createdStreams[createdStreams.length - 1];
  // Let the first call's deferred teardown fire.
  await leaving;
  await delay(50);

  assert.notEqual(firstStream, secondStream, "the new call should acquire a fresh stream");
  assert.ok(
    firstStream.getAudioTracks()[0].stopped,
    "the ended call's mic must be stopped",
  );
  assert.ok(
    !secondStream.getAudioTracks()[0].stopped,
    "the new call's mic must stay live (stale teardown must not stop it)",
  );
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

test("get/setScreenVolumeForUser is independent of the voice volume", () => {
  assert.equal(voice.getScreenVolumeForUser(8888), 1); // never set -> unchanged
  voice.setVolumeForUser(8888, 0.8);
  voice.setScreenVolumeForUser(8888, 0.2); // turning the share down...
  assert.equal(voice.getScreenVolumeForUser(8888), 0.2);
  assert.equal(voice.getVolumeForUser(8888), 0.8); // ...leaves the voice level untouched
  voice.setScreenVolumeForUser(8888, -3); // clamped on the way in
  assert.equal(voice.getScreenVolumeForUser(8888), 0);
});

test("hasScreenAudio is false for a peer with no live shared audio", () => {
  assert.equal(voice.hasScreenAudio(7777), false);
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

// --- media-environment preflight --------------------------------------------
// A context with no usable navigator.mediaDevices (insecure origin / WebView)
// must be caught BEFORE getUserMedia so the user gets an actionable line, not an
// opaque TypeError. iOS standalone is NOT hard-blocked (capture often works);
// its caveat rides on the failure message instead.

test("preflightMediaError: a context with getUserMedia is allowed through", () => {
  assert.equal(
    voice.preflightMediaError({ hasMediaDevices: true, isSecureContext: true, standalone: false }),
    null,
  );
  // standalone still proceeds — mediaDevices is present in a home-screen app.
  assert.equal(
    voice.preflightMediaError({ hasMediaDevices: true, isSecureContext: true, standalone: true }),
    null,
  );
});

test("preflightMediaError: insecure origin is blocked with an HTTPS hint", () => {
  const msg = voice.preflightMediaError({ hasMediaDevices: false, isSecureContext: false, standalone: false });
  assert.match(msg, /HTTPS|https:/i);
});

test("preflightMediaError: a context with no mediaDevices (but secure) is blocked generically", () => {
  const msg = voice.preflightMediaError({ hasMediaDevices: false, isSecureContext: true, standalone: false });
  assert.match(msg, /can't reach the microphone or camera/i);
  // A null/absent env is treated as "worth attempting" (don't false-block).
  assert.equal(voice.preflightMediaError(null), null);
});

// --- mediaErrorHint (iOS standalone caveat) ---------------------------------

test("mediaErrorHint: only standalone gets the open-in-Safari caveat", () => {
  assert.match(voice.mediaErrorHint({ standalone: true }), /Safari/);
  assert.equal(voice.mediaErrorHint({ standalone: false }), "");
  assert.equal(voice.mediaErrorHint(null), "");
});

// --- env-aware error messages -----------------------------------------------

test("micErrorMessage surfaces the preflight rejection verbatim", () => {
  const e = new Error("Voice and video need a secure (HTTPS) connection. Open this site over https:// and try again.");
  e.name = "UnsupportedMediaContextError";
  // No generic "Could not access" prefix — the preflight message is already complete.
  assert.equal(voice.micErrorMessage(e), e.message);
  assert.doesNotMatch(voice.micErrorMessage(e), /Could not access/);
});

test("micErrorMessage appends the standalone caveat when env.standalone is set", () => {
  const env = { standalone: true };
  // The WebKit standalone defect can surface as NotAllowed / NotFound / NotReadable —
  // each should still carry the open-in-Safari pointer.
  assert.match(voice.micErrorMessage({ name: "NotAllowedError" }, env), /blocked.*Safari/is);
  assert.match(voice.micErrorMessage({ name: "NotFoundError" }, env), /Safari/);
  assert.match(voice.micErrorMessage({ name: "NotReadableError" }, env), /Safari/);
  // Without standalone, no caveat is appended (default desktop case).
  assert.doesNotMatch(voice.micErrorMessage({ name: "NotAllowedError" }, { standalone: false }), /Safari/);
});

test("cameraErrorMessage is env-aware too (preflight + standalone caveat)", () => {
  const e = new Error("nope"); e.name = "UnsupportedMediaContextError";
  assert.equal(voice.cameraErrorMessage(e), "nope");
  assert.match(voice.cameraErrorMessage({ name: "NotAllowedError" }, { standalone: true }), /Safari/);
  assert.doesNotMatch(voice.cameraErrorMessage({ name: "NotAllowedError" }, { standalone: false }), /Safari/);
});

test("joinVoiceChannel preflight rejects (and never joins) when getUserMedia is unavailable", async () => {
  setup();
  const orig = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = undefined; // simulate insecure origin / WebView
  try {
    await assert.rejects(
      () => voice.joinVoiceChannel(99),
      (e) => e.name === "UnsupportedMediaContextError" && /microphone or camera|HTTPS/i.test(e.message),
    );
    // The preflight throws BEFORE any state is set, so we're not half-joined.
    assert.equal(voice.voiceChannelId(), null);
    assert.equal(voice.isInCall(), false);
  } finally {
    navigator.mediaDevices.getUserMedia = orig;
    restoreGetUserMedia();
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

// --- join-time state announce + per-channel camera preference ---------------
// A fresh participant is video-muted server-side so peers don't flash a video
// placeholder before anyone turns a camera on (see hub.VoiceJoin). The client
// therefore announces its real state on join so a camera-on caller still shows.

test("joinVoiceChannel announces voice-only state to the server (video_muted:true)", async () => {
  setup();
  await voice.joinVoiceChannel(42, { enableVideo: false });
  const mute = sent.find((m) => m.type === "voice.mute");
  assert.ok(mute, "a voice.mute is sent on join");
  assert.equal(mute.channel_id, 42);
  assert.equal(mute.video_muted, true, "a voice-only join announces video_muted:true");
  await voice.leaveVoiceChannel();
});

test("joinVoiceChannel with camera on announces video_muted:false", async () => {
  setup();
  getUserMediaVideo = true;
  await voice.joinVoiceChannel(42, { enableVideo: true });
  const mute = sent.find((m) => m.type === "voice.mute");
  assert.ok(mute && mute.video_muted === false, "a camera-on join announces video_muted:false");
  await voice.leaveVoiceChannel();
});

// The camera preference is remembered PER channel: turning the camera on in one
// DM and hanging up auto-enables it next time in THAT DM, but a different DM (or
// a brand-new call) starts voice-only.
test("camera preference is remembered per channel, not globally", async () => {
  setup();
  navigator.mediaDevices.getUserMedia = async (constraints) =>
    makeFakeStream({ includeVideo: !!(constraints && constraints.video) });

  await voice.joinVoiceChannel(42, { enableVideo: false });
  await voice.setCameraEnabled(true);
  assert.equal(voice.isCameraEnabled(), true);
  await voice.leaveVoiceChannel();

  assert.equal(voice.loadCameraPreference(42), true, "the DM we used the camera in remembers it");
  assert.equal(voice.loadCameraPreference(99), false, "a different DM stays voice-only");

  restoreGetUserMedia();
});

// Turning the camera back off before hanging up clears the saved preference, so
// the next call to that DM is voice-only again.
test("turning the camera off in a DM clears its saved preference", async () => {
  setup();
  navigator.mediaDevices.getUserMedia = async (constraints) =>
    makeFakeStream({ includeVideo: !!(constraints && constraints.video) });

  await voice.joinVoiceChannel(7, { enableVideo: false });
  await voice.setCameraEnabled(true);
  assert.equal(voice.loadCameraPreference(7), true);
  await voice.setCameraEnabled(false);
  assert.equal(voice.loadCameraPreference(7), false);
  await voice.leaveVoiceChannel();

  restoreGetUserMedia();
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

// --- VP9-first codec ordering (screen-share: sharper text at equal bitrate) ---

test("orderVideoCodecsVP9First puts VP9 then VP8 ahead of H.264", () => {
  const input = [
    { mimeType: "video/H264" },
    { mimeType: "video/VP8" },
    { mimeType: "video/VP9" },
  ];
  const out = voice.orderVideoCodecsVP9First(input).map(c => c.mimeType);
  assert.deepEqual(out, ["video/VP9", "video/VP8", "video/H264"]);
});

test("orderVideoCodecsVP9First keeps all codecs and middle-rank relative order", () => {
  const input = [
    { mimeType: "video/H264" },
    { mimeType: "video/rtx" },
    { mimeType: "video/red" },
    { mimeType: "video/VP9" },
    { mimeType: "video/ulpfec" },
  ];
  const out = voice.orderVideoCodecsVP9First(input).map(c => c.mimeType);
  assert.deepEqual(out, ["video/VP9", "video/rtx", "video/red", "video/ulpfec", "video/H264"]);
});

test("orderVideoCodecsVP9First tolerates junk input", () => {
  assert.deepEqual(voice.orderVideoCodecsVP9First(null), []);
  assert.deepEqual(voice.orderVideoCodecsVP9First(undefined), []);
  assert.deepEqual(voice.orderVideoCodecsVP9First("nope"), []);
  const out = voice.orderVideoCodecsVP9First([{}, { mimeType: "video/VP9" }]);
  assert.equal(out[0].mimeType, "video/VP9");
  assert.equal(out.length, 2);
});

// --- Phase 2 hardening: Perfect Negotiation role + effective state + bitrate cap

test("politeFor: the higher user_id is the polite peer", () => {
  assert.equal(voice.politeFor(1, 2), false); // lower id: impolite (initial offerer)
  assert.equal(voice.politeFor(2, 1), true);  // higher id: polite (answerer)
  // exactly one side of any pair is polite
  assert.notEqual(voice.politeFor(7, 12), voice.politeFor(12, 7));
});

test("effectiveConnectionState: ICE trouble dominates a lagging connectionState", () => {
  // Firefox case: ICE reports failed/disconnected first (or exclusively).
  assert.equal(voice.effectiveConnectionState("connected", "failed"), "failed");
  assert.equal(voice.effectiveConnectionState("connected", "disconnected"), "disconnected");
  assert.equal(voice.effectiveConnectionState("connecting", "failed"), "failed");
});

test("effectiveConnectionState: failed outranks disconnected; closed outranks everything", () => {
  assert.equal(voice.effectiveConnectionState("disconnected", "failed"), "failed");
  assert.equal(voice.effectiveConnectionState("failed", "disconnected"), "failed");
  // closed is read from connectionState only (ICE "closed" is deprecated/unreliable)
  assert.equal(voice.effectiveConnectionState("closed", "failed"), "closed");
  assert.equal(voice.effectiveConnectionState("connected", "closed"), "connected");
});

test("hasUnsentLocalTrack: true only for a local track the negotiation doesn't send", () => {
  const pc = (transceivers) => ({ getTransceivers: () => transceivers });
  const tx = (kind, hasTrack, currentDirection) => ({
    kind, currentDirection, sender: { track: hasTrack ? { kind } : null },
  });
  // A local track stuck recvonly (the glare-rollback case) → needs a re-offer.
  assert.equal(voice.hasUnsentLocalTrack(pc([tx("video", true, "recvonly")])), true);
  assert.equal(voice.hasUnsentLocalTrack(pc([tx("video", true, "inactive")])), true);
  // Already sending (sendrecv/sendonly) → nothing owed, must NOT re-offer.
  assert.equal(voice.hasUnsentLocalTrack(pc([tx("audio", true, "sendrecv")])), false);
  assert.equal(voice.hasUnsentLocalTrack(pc([tx("video", true, "sendonly")])), false);
  // recvonly transceiver with NO local track (we're only receiving) → not ours.
  assert.equal(voice.hasUnsentLocalTrack(pc([tx("video", false, "recvonly")])), false);
  // Mixed: audio sending + our video stuck recvonly → true (the video is owed).
  assert.equal(voice.hasUnsentLocalTrack(pc([tx("audio", true, "sendrecv"), tx("video", true, "recvonly")])), true);
});

test("effectiveConnectionState: healthy states pass through connectionState", () => {
  assert.equal(voice.effectiveConnectionState("connected", "completed"), "connected");
  assert.equal(voice.effectiveConnectionState("connected", "connected"), "connected");
  assert.equal(voice.effectiveConnectionState("new", "checking"), "new");
  assert.equal(voice.effectiveConnectionState("connecting", "checking"), "connecting");
});

const FULL_SHAPE = { maxBitrate: 800000, scaleResolutionDownBy: 1, maxFramerate: 24 };

test("withVideoEncodingCaps: shapes every encoding without mutating the input", () => {
  const params = { transactionId: "t1", encodings: [{ active: true }, { maxBitrate: 250000 }] };
  const out = voice.withVideoEncodingCaps(params, FULL_SHAPE);
  assert.deepEqual(out.encodings.map(e => e.maxBitrate), [800000, 800000]);
  assert.deepEqual(out.encodings.map(e => e.scaleResolutionDownBy), [1, 1]);
  assert.deepEqual(out.encodings.map(e => e.maxFramerate), [24, 24]);
  assert.equal(out.encodings[0].active, true);            // other fields preserved
  assert.equal(out.transactionId, "t1");                  // top-level fields preserved
  assert.equal(params.encodings[0].maxBitrate, undefined); // input untouched
  assert.equal(params.encodings[1].maxBitrate, 250000);
  assert.equal(params.encodings[0].scaleResolutionDownBy, undefined);
});

test("withVideoEncodingCaps: returns null when there is nothing to do", () => {
  // pre-negotiation senders report no encodings — the spec forbids adding them
  assert.equal(voice.withVideoEncodingCaps({ encodings: [] }, FULL_SHAPE), null);
  assert.equal(voice.withVideoEncodingCaps({}, FULL_SHAPE), null);
  assert.equal(voice.withVideoEncodingCaps(null, FULL_SHAPE), null);
  // already shaped everywhere -> no-op signal (skip the setParameters round-trip)
  const shaped = { encodings: [{ maxBitrate: 800000, scaleResolutionDownBy: 1, maxFramerate: 24 }] };
  assert.equal(voice.withVideoEncodingCaps(shaped, FULL_SHAPE), null);
  // a changed resolution alone is enough to re-emit
  assert.notEqual(voice.withVideoEncodingCaps(shaped, { ...FULL_SHAPE, scaleResolutionDownBy: 2 }), null);
});

test("videoScaleForTarget: sheds resolution/framerate as the target falls", () => {
  // At/above the full-res threshold: native capture, full framerate.
  assert.deepEqual(voice.videoScaleForTarget(800000), { scaleResolutionDownBy: 1, maxFramerate: 24 });
  assert.deepEqual(voice.videoScaleForTarget(500000), { scaleResolutionDownBy: 1, maxFramerate: 24 });
  // Mid band: half-scale.
  assert.deepEqual(voice.videoScaleForTarget(400000), { scaleResolutionDownBy: 2, maxFramerate: 20 });
  assert.deepEqual(voice.videoScaleForTarget(300000), { scaleResolutionDownBy: 2, maxFramerate: 20 });
  // Floor band: quarter-scale, trimmed framerate.
  assert.deepEqual(voice.videoScaleForTarget(150000), { scaleResolutionDownBy: 4, maxFramerate: 15 });
  // A missing target falls back to native (fresh sender, no congestion data yet).
  assert.deepEqual(voice.videoScaleForTarget(undefined), { scaleResolutionDownBy: 1, maxFramerate: 24 });
});

test("videoScaleForTarget: a screen steps resolution DOWN willingly on its own thresholds", () => {
  // Native res only with real headroom (≥ SCREEN_FULL = 1.6M, ≈64% of the 2.5M screen
  // ceiling). The key fix vs. the old ladder (700k under an 800k ceiling) is that native
  // now lives across a BROAD band (≈1.6M–2.5M), so a single stress blip — soft ceiling to
  // ~0.85×, target to ~0.75× — stays IN the native band instead of dropping straight off it.
  assert.deepEqual(voice.videoScaleForTarget(2500000, true), { scaleResolutionDownBy: 1, maxFramerate: 30 });
  assert.deepEqual(voice.videoScaleForTarget(1600000, true), { scaleResolutionDownBy: 1, maxFramerate: 30 });
  // The broad middle (600k–1.6M) drops to ½.
  assert.deepEqual(voice.videoScaleForTarget(1500000, true), { scaleResolutionDownBy: 2, maxFramerate: 30 });
  assert.deepEqual(voice.videoScaleForTarget(800000, true), { scaleResolutionDownBy: 2, maxFramerate: 30 });
  assert.deepEqual(voice.videoScaleForTarget(600000, true), { scaleResolutionDownBy: 2, maxFramerate: 30 });
  // Floor (< 600k): the extra step — ¼ res. Detail eases fps to 24.
  assert.deepEqual(voice.videoScaleForTarget(599999, true), { scaleResolutionDownBy: 4, maxFramerate: 24 });
  assert.deepEqual(voice.videoScaleForTarget(150000, true), { scaleResolutionDownBy: 4, maxFramerate: 24 });
  // A fresh sender with no congestion data yet starts at native res, 30fps.
  assert.deepEqual(voice.videoScaleForTarget(undefined, true), { scaleResolutionDownBy: 1, maxFramerate: 30 });
});

test("videoScaleForTarget: a screen playing video (motion) holds framerate at the floor", () => {
  // Same resolution ladder as detail; motion only keeps framerate up at the ¼ floor
  // (smoothness is the point of a video/game share), where detail eases to 24.
  assert.deepEqual(voice.videoScaleForTarget(2500000, true, true), { scaleResolutionDownBy: 1, maxFramerate: 30 });
  assert.deepEqual(voice.videoScaleForTarget(800000, true, true), { scaleResolutionDownBy: 2, maxFramerate: 30 });
  assert.deepEqual(voice.videoScaleForTarget(150000, true, true), { scaleResolutionDownBy: 4, maxFramerate: 30 });
  // motion only applies to a screen source: a camera ignores the flag and uses its ladder.
  assert.deepEqual(voice.videoScaleForTarget(400000, false, true), { scaleResolutionDownBy: 2, maxFramerate: 20 });
  // A screen with motion off is the detail ladder (¼ floor eases to 24, not 30).
  assert.deepEqual(voice.videoScaleForTarget(150000, true, false), { scaleResolutionDownBy: 4, maxFramerate: 24 });
});

test("detectScreenMotion: latches on/off with hysteresis", () => {
  let s = { active: false, ticks: 0 };
  // One high sample isn't enough to engage (needs SCREEN_MOTION_ENTER_TICKS = 2).
  s = voice.detectScreenMotion(s, 24);
  assert.equal(s.active, false);
  // Second consecutive high sample latches ON.
  s = voice.detectScreenMotion(s, 24);
  assert.equal(s.active, true);
  // A single low sample does NOT disengage (needs SCREEN_MOTION_EXIT_TICKS = 3).
  s = voice.detectScreenMotion(s, 1);
  assert.equal(s.active, true);
  s = voice.detectScreenMotion(s, 1);
  assert.equal(s.active, true);
  // Third consecutive low sample disengages.
  s = voice.detectScreenMotion(s, 1);
  assert.equal(s.active, false);
});

test("detectScreenMotion: a mid-range or interrupted sample resets the streak", () => {
  let s = { active: false, ticks: 0 };
  s = voice.detectScreenMotion(s, 24);       // one toward ON
  assert.equal(s.ticks, 1);
  s = voice.detectScreenMotion(s, 9);        // below ENTER_FPS — streak resets, no latch
  assert.deepEqual(s, { active: false, ticks: 0 });
  // A null/absent fps (browser doesn't report it) holds `active` and zeroes the counter,
  // so we never auto-switch on missing data — detail stays the safe default.
  s = { active: true, ticks: 2 };
  s = voice.detectScreenMotion(s, null);
  assert.deepEqual(s, { active: true, ticks: 0 });
  s = voice.detectScreenMotion({ active: false, ticks: 1 }, undefined);
  assert.deepEqual(s, { active: false, ticks: 0 });
});

test("linkStressed: loss or RTT trips, but a CPU-pinned encoder does NOT (the decoupling)", () => {
  assert.equal(voice.linkStressed({ lossFrac: 0.10, rttMs: 100 }), true);  // loss
  assert.equal(voice.linkStressed({ lossFrac: 0, rttMs: 700 }), true);     // RTT
  // CPU limitation is NOT a link signal — the bandwidth soft ceiling must not learn from it.
  assert.equal(voice.linkStressed({ lossFrac: 0, rttMs: 100, cpuLimited: true }), false);
  assert.equal(voice.linkStressed({ lossFrac: 0.01, rttMs: 100 }), false); // healthy
  assert.equal(voice.linkStressed({ lossFrac: null, rttMs: null }), false); // no signal
});

test("uplinkStressed: loss, RTT, or local CPU limitation each trip stress", () => {
  assert.equal(voice.uplinkStressed({ lossFrac: 0.10, rttMs: 100 }), true);  // loss
  assert.equal(voice.uplinkStressed({ lossFrac: 0, rttMs: 700 }), true);     // RTT
  assert.equal(voice.uplinkStressed({ lossFrac: 0, rttMs: 100, cpuLimited: true }), true); // encoder pinned
  assert.equal(voice.uplinkStressed({ lossFrac: 0.01, rttMs: 100 }), false); // healthy
  assert.equal(voice.uplinkStressed({ lossFrac: null, rttMs: null }), false); // no signal
});

test("bitrateCapFor: 1:1 and 2-party calls get the full per-sender ceiling", () => {
  // One video sender (the lone remote peer) — total budget, ceilinged at 800k.
  assert.equal(voice.bitrateCapFor(2, "video"), 800000);
  // A degenerate 0/1-participant count never divides by zero or exceeds the cap.
  assert.equal(voice.bitrateCapFor(1, "video"), 800000);
  assert.equal(voice.bitrateCapFor(0, "video"), 800000);
});

test("bitrateCapFor: per-sender slice shrinks as the roster grows, floored", () => {
  // TOTAL 1.6 Mbps ÷ (N-1) senders, ceilinged 800k, floored 150k.
  assert.equal(voice.bitrateCapFor(3, "video"), 800000);  // 1.6M/2 = 800k (== ceiling)
  assert.equal(voice.bitrateCapFor(4, "video"), 533333);  // 1.6M/3
  assert.equal(voice.bitrateCapFor(5, "video"), 400000);  // 1.6M/4
  assert.equal(voice.bitrateCapFor(6, "video"), 320000);  // 1.6M/5
  // A pathologically large roster still floors instead of collapsing to ~0.
  assert.equal(voice.bitrateCapFor(50, "video"), 150000);
});

test("bitrateCapFor: non-video kinds return the plain ceiling, not the budget", () => {
  assert.equal(voice.bitrateCapFor(6, "audio"), 800000);
  assert.equal(voice.bitrateCapFor(6, "screen"), 800000);
});

test("bitrateCapFor: a screen share rides its own, far higher budget", () => {
  // 2-party DM share (one sender): the full screen ceiling, well above the 800k camera cap.
  assert.equal(voice.bitrateCapFor(2, "video", true), 2500000);
  assert.equal(voice.bitrateCapFor(1, "video", true), 2500000);
  // Group shares still shrink with roster size: SCREEN_TOTAL 4.5M ÷ (N-1), ceilinged 2.5M.
  assert.equal(voice.bitrateCapFor(3, "video", true), 2250000); // 4.5M/2
  assert.equal(voice.bitrateCapFor(4, "video", true), 1500000); // 4.5M/3
  assert.equal(voice.bitrateCapFor(7, "video", true), 750000);  // 4.5M/6
  // The camera path is untouched when isScreen is false / omitted.
  assert.equal(voice.bitrateCapFor(2, "video", false), 800000);
  assert.equal(voice.bitrateCapFor(2, "video"), 800000);
});

test("uplinkLossFraction: delta loss over delta sent, guarding resets", () => {
  // 10 of 100 newly-sent packets lost = 0.10.
  assert.equal(voice.uplinkLossFraction(1100, 60, 1000, 50), 0.1);
  assert.equal(voice.uplinkLossFraction(1000, 0, 900, 0), 0);   // no loss
  assert.equal(voice.uplinkLossFraction(1000, 5, undefined, undefined), null); // no baseline
  assert.equal(voice.uplinkLossFraction(1000, 5, 1000, 5), null); // no traffic this interval
  assert.equal(voice.uplinkLossFraction(50, 1, 1000, 40), null);  // counters reset (sent went down)
  assert.equal(voice.uplinkLossFraction(1100, 2, 1000, 40), null); // lost went down (reset)
});

test("congestionTarget: backs off on loss, RTT, or CPU stress, floored", () => {
  const ceiling = 800000;
  // 10% loss → ×0.75.
  assert.equal(voice.congestionTarget(800000, ceiling, { lossFrac: 0.10, rttMs: 100, limited: false }), 600000);
  // High RTT alone triggers back-off too.
  assert.equal(voice.congestionTarget(800000, ceiling, { lossFrac: 0, rttMs: 700, limited: false }), 600000);
  // A CPU-pinned encoder backs off even with a clean link — the relief is a smaller frame.
  assert.equal(voice.congestionTarget(800000, ceiling, { lossFrac: 0, rttMs: 100, cpuLimited: true }), 600000);
  // Repeated stress floors at MIN, never below.
  assert.equal(voice.congestionTarget(160000, ceiling, { lossFrac: 0.2, rttMs: 100, limited: false }), 150000);
});

test("congestionTarget: climbs only after a long healthy streak; holds when bandwidth-limited", () => {
  const ceiling = 800000;
  const healthy = { lossFrac: 0.01, rttMs: 120, limited: false };
  // A short clean run is NOT enough — recovery is deliberately slow (the relapse fix:
  // loss clears because we backed off, not because the link healed). Need CLIMB_AFTER_HEALTHY=4.
  assert.equal(voice.congestionTarget(400000, ceiling, { ...healthy, healthyStreak: 1 }), 400000);
  assert.equal(voice.congestionTarget(400000, ceiling, { ...healthy, healthyStreak: 3 }), 400000);
  // The fourth consecutive healthy interval → a small +40k creep.
  assert.equal(voice.congestionTarget(400000, ceiling, { ...healthy, healthyStreak: 4 }), 440000);
  // Climb is clamped at the ceiling.
  assert.equal(voice.congestionTarget(780000, ceiling, { lossFrac: 0, rttMs: 100, limited: false, healthyStreak: 4 }), 800000);
  // Encoder already bandwidth-limited → hold (don't push past what it can use).
  assert.equal(voice.congestionTarget(400000, ceiling, { ...healthy, limited: true, healthyStreak: 5 }), 400000);
  // Missing signals (null) are treated as non-stress: a settled sender creeps up.
  assert.equal(voice.congestionTarget(400000, ceiling, { lossFrac: null, rttMs: null, limited: false, healthyStreak: 4 }), 440000);
});

test("congestionTarget: a screen source climbs by the larger screen step", () => {
  const ceiling = 2500000;
  const settled = { lossFrac: 0.01, rttMs: 120, limited: false, healthyStreak: 4 };
  // Over the wider ~2.5M screen range the camera's +40k step would crawl ~3× slower, so a
  // screen climbs +150k instead — same streak gate, just a proportionate step.
  assert.equal(voice.congestionTarget(1600000, ceiling, settled, true), 1750000);
  assert.equal(voice.congestionTarget(1600000, ceiling, settled, false), 1640000);
  // Back-off is unchanged (×0.75 on stress), regardless of source.
  assert.equal(voice.congestionTarget(1600000, ceiling, { lossFrac: 0.2, rttMs: 100 }, true), 1200000);
});

test("softCeilingFor: ratchets down on stress to under the level that broke; re-probes slowly", () => {
  const hard = 800000;
  // No prior ceiling, healthy → stays at the hard ceiling (ideal conditions, no regression).
  assert.equal(voice.softCeilingFor(undefined, hard, 800000, { lossFrac: 0, rttMs: 100, healthyStreak: 4 }), 800000);
  // Stress at 800k → cap drops to 85% of the level that broke (the prevTarget).
  assert.equal(voice.softCeilingFor(800000, hard, 800000, { lossFrac: 0.2, rttMs: 100 }), 680000);
  // Further stress ratchets it down again, never up — relative to the (lower) prevTarget.
  assert.equal(voice.softCeilingFor(680000, hard, 600000, { lossFrac: 0.2, rttMs: 100 }), 510000);
  // A transient stress only nudges down modestly; the cap never goes below MIN.
  assert.equal(voice.softCeilingFor(160000, hard, 160000, { lossFrac: 0.5, rttMs: 100 }), 150000);
  // Settled + healthy → slow upward re-probe (+5k), so a recovered link eventually climbs.
  assert.equal(voice.softCeilingFor(500000, hard, 480000, { lossFrac: 0, rttMs: 100, healthyStreak: 4 }), 505000);
  // Healthy but NOT yet settled (short streak) → hold the learned cap, don't re-probe.
  assert.equal(voice.softCeilingFor(500000, hard, 480000, { lossFrac: 0, rttMs: 100, healthyStreak: 2 }), 500000);
  // Re-probe is clamped at the hard ceiling.
  assert.equal(voice.softCeilingFor(799000, hard, 780000, { lossFrac: 0, rttMs: 100, healthyStreak: 9 }), 800000);
});

test("softCeilingFor: a CPU-pinned encoder does NOT ratchet the bandwidth cap (decoupled)", () => {
  const hard = 800000;
  // CPU stress on a clean link must NOT teach a false link cap. The monitor zeroes the
  // healthyStreak on any uplinkStressed interval (CPU included), so neither branch fires
  // and the learned cap holds — the congestion TARGET still backs off on CPU separately.
  assert.equal(voice.softCeilingFor(680000, hard, 680000, { lossFrac: 0, rttMs: 100, cpuLimited: true, healthyStreak: 0 }), 680000);
  // Contrast: real LINK stress (loss) at the same point still ratchets down to 0.85×.
  assert.equal(voice.softCeilingFor(680000, hard, 680000, { lossFrac: 0.2, rttMs: 100 }), 578000);
});

test("softCeilingFor: a screen source re-probes upward by the larger screen step", () => {
  const hard = 2500000;
  // Settled + healthy on a screen → +20k (vs +5k camera), so the wider range recovers in
  // proportion instead of crawling ~3× slower.
  assert.equal(voice.softCeilingFor(2000000, hard, 1900000, { lossFrac: 0, rttMs: 100, healthyStreak: 4 }, true), 2020000);
  // The camera step is unchanged when isScreen is false.
  assert.equal(voice.softCeilingFor(2000000, hard, 1900000, { lossFrac: 0, rttMs: 100, healthyStreak: 4 }, false), 2005000);
});

test("resolutionWithHysteresis: coarsens immediately, refines one tier at a time with margin", () => {
  // No prior scale: defer to the raw mapping (a fresh sender starts where the target says).
  assert.equal(voice.resolutionWithHysteresis(undefined, 2000000, true).scaleResolutionDownBy, 1);
  // COARSENING is immediate — target cratered from native to the ¼ floor in one step.
  assert.equal(voice.resolutionWithHysteresis(1, 300000, true).scaleResolutionDownBy, 4);
  // REFINING needs headroom: at ½ (prev=2), a target that only just clears the native
  // threshold (1.6M) does NOT upshift — 1.6M×0.8 = 1.28M still maps to ½.
  assert.equal(voice.resolutionWithHysteresis(2, 1600000, true).scaleResolutionDownBy, 2);
  // ...but it keeps the higher framerate the bigger target affords at the held resolution.
  assert.equal(voice.resolutionWithHysteresis(2, 1600000, true).maxFramerate, 30);
  // With real headroom (≥ 1.6M/0.8 = 2.0M) it refines — but only ONE tier per call:
  // ¼ → ½, never ¼ → native in a single jump.
  assert.equal(voice.resolutionWithHysteresis(4, 2500000, true).scaleResolutionDownBy, 2);
  // From ½ with ample headroom, one more tier to native.
  assert.equal(voice.resolutionWithHysteresis(2, 2500000, true).scaleResolutionDownBy, 1);
});
