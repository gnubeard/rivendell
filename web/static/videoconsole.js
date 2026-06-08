// videoconsole.js — admin-panel video debugging console.
//
// A real-time camera/constraints lab: open the camera with arbitrary
// MediaTrackConstraints, see what the hardware actually negotiated
// (getSettings) versus what it CAN do (getCapabilities), and tune the live track
// with applyConstraints() — the same lever voice.js uses to drag the FF-Android
// square-capture wedge into landscape. The point is the feedback loop: change a
// setting, watch the readout update on the running track immediately, no call to
// set up and no rebuild. A tuned profile can be saved as the call default
// (persisted via voice.js's video-constraint override) so the next real voice/DM
// call captures with it.
//
// When a call is already live the console operates on the call's OWN video track
// (tuning the real session); otherwise it opens its own standalone video-only
// capture. In-call encoder/transport stats live in the separate ?rtcdebug HUD —
// this console is capture-side truth.
//
// The pure constraint/format helpers are unit-tested in videoconsole.test.js; the
// initVideoConsole DOM controller is browser-only.

// --- pure helpers (unit-tested) --------------------------------------------

// Common capture resolutions for the preset buttons. Landscape 16:9 except where
// noted; the user picks the constraint mode (ideal/exact/…) separately.
export const RESOLUTION_PRESETS = [
  { label: "360p", width: 640, height: 360 },
  { label: "480p", width: 640, height: 480 },
  { label: "540p", width: 960, height: 540 },
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
  { label: "1440p", width: 2560, height: 1440 },
  { label: "4K", width: 3840, height: 2160 },
];

// Aspect-ratio choices for the dropdown (value is the numeric ratio WebRTC wants).
export const ASPECT_RATIOS = [
  { label: "—", value: "" },
  { label: "16:9", value: 16 / 9 },
  { label: "4:3", value: 4 / 3 },
  { label: "1:1", value: 1 },
  { label: "9:16", value: 9 / 16 },
];

// constraintField builds a single ConstraintLong/Double clause ({ideal: 640},
// {exact: 1280}, …) from a mode + value, or undefined when the field is unset or
// non-numeric. Pure.
export function constraintField(mode, value) {
  if (!mode || mode === "off") return undefined;
  if (value === "" || value == null) return undefined;
  const v = Number(value);
  if (!Number.isFinite(v)) return undefined;
  return { [mode]: v };
}

// buildVideoConstraints turns the console form fields into a MediaTrackConstraints
// object. width/height/frameRate/aspectRatio each honour their own mode so a test
// can exercise them independently; the DOM layer feeds the same mode to all four.
// facingMode is always ideal (an exact facingMode OverconstrainedErrors on a
// single-camera laptop — the project's hard-won "ideal never rejects" lesson). An
// empty result ({}) is a valid "any camera" request. Pure.
export function buildVideoConstraints(f = {}) {
  const c = {};
  const w = constraintField(f.widthMode, f.width); if (w) c.width = w;
  const h = constraintField(f.heightMode, f.height); if (h) c.height = h;
  const fr = constraintField(f.fpsMode, f.fps); if (fr) c.frameRate = fr;
  const ar = constraintField(f.arMode, f.aspectRatio); if (ar) c.aspectRatio = ar;
  if (f.facingMode && f.facingMode !== "off") c.facingMode = { ideal: f.facingMode };
  if (f.resizeMode && f.resizeMode !== "off") c.resizeMode = f.resizeMode;
  if (f.deviceId) c.deviceId = { exact: f.deviceId };
  return c;
}

// parseConstraintsText parses the raw-JSON override box. "" -> null (use the
// fields instead); valid JSON object -> that object; anything else throws (the
// caller surfaces the message). Pure.
export function parseConstraintsText(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const parsed = JSON.parse(t); // SyntaxError on malformed JSON
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("constraints must be a JSON object");
  }
  return parsed;
}

// fmtNum trims a number for display: integers as-is, fractions to ≤3 dp without
// trailing zeros, non-numbers stringified, null -> "?". Pure.
export function fmtNum(n) {
  if (n == null) return "?";
  if (typeof n !== "number") return String(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/\.?0+$/, "");
}

function gcd(a, b) { a = Math.round(a); b = Math.round(b); while (b) { [a, b] = [b, a % b]; } return a || 1; }

// describeResolution renders a one-line headline from a getSettings object:
// "1280 × 720  (0.92 MP, 16:9)". "—" when dimensions are missing. Pure.
export function describeResolution(s) {
  if (!s || !s.width || !s.height) return "—";
  const mp = (s.width * s.height) / 1e6;
  const g = gcd(s.width, s.height);
  const fr = typeof s.frameRate === "number" ? ` @ ${fmtNum(s.frameRate)}fps` : "";
  return `${s.width} × ${s.height}${fr}  (${mp.toFixed(2)} MP, ${Math.round(s.width / g)}:${Math.round(s.height / g)})`;
}

// Keys surfaced from getSettings(), in display order.
const SETTINGS_KEYS = ["width", "height", "frameRate", "aspectRatio", "facingMode", "resizeMode", "deviceId"];

// summarizeSettings -> [[key, displayValue], …] from a getSettings object. Pure.
export function summarizeSettings(s) {
  if (!s || typeof s !== "object") return [];
  const out = [];
  for (const k of SETTINGS_KEYS) {
    if (s[k] == null || s[k] === "") continue;
    const v = (k === "frameRate" || k === "aspectRatio") ? fmtNum(s[k]) : String(s[k]);
    out.push([k, v]);
  }
  return out;
}

// summarizeCapabilities -> [[key, displayValue], …] from a getCapabilities
// object: {min,max} ranges render as "min – max", string arrays as a CSV. This is
// the readout that answers "my camera can do better than that" — the max width/
// height/frameRate the hardware advertises. Pure.
export function summarizeCapabilities(caps) {
  if (!caps || typeof caps !== "object") return [];
  const out = [];
  for (const k of ["width", "height", "frameRate", "aspectRatio", "facingMode", "resizeMode"]) {
    const v = caps[k];
    if (v == null) continue;
    if (Array.isArray(v)) { if (v.length) out.push([k, v.join(", ")]); continue; }
    if (typeof v === "object" && ("min" in v || "max" in v)) {
      out.push([k, `${fmtNum(v.min)} – ${fmtNum(v.max)}`]);
    }
  }
  return out;
}

// --- DOM controller (browser-only) -----------------------------------------

let voiceApi = null;     // injected voice.js bridge (see initVideoConsole)
let standalone = null;   // MediaStream this console opened itself (vs. a live call)
let pollTimer = null;
let wired = false;

const vq = (id) => document.getElementById(id);

// activeTrack prefers the live call's video track (tune the real session) and
// falls back to the console's own standalone capture.
function activeTrack() {
  const call = voiceApi && voiceApi.getCallTrack ? voiceApi.getCallTrack() : null;
  if (call && call.readyState === "live") return call;
  return standalone ? (standalone.getVideoTracks()[0] || null) : null;
}

function status(msg, isErr) {
  const box = vq("vc-status");
  if (!box) return;
  box.textContent = msg;
  box.classList.toggle("vc-error", !!isErr);
}

function formFields() {
  const mode = vq("vc-mode").value;
  return {
    widthMode: mode, heightMode: mode, fpsMode: mode, arMode: mode,
    width: vq("vc-width").value,
    height: vq("vc-height").value,
    fps: vq("vc-fps").value,
    aspectRatio: vq("vc-ar").value,
    facingMode: vq("vc-facing").value,
    deviceId: vq("vc-device").value || undefined,
  };
}

// currentConstraints resolves the active constraint object: the raw-JSON box wins
// when non-empty, else the structured fields. Throws on malformed JSON.
function currentConstraints() {
  const fromJson = parseConstraintsText(vq("vc-json").value);
  if (fromJson) return fromJson;
  return buildVideoConstraints(formFields());
}

function setRequested(c) {
  const pre = vq("vc-requested");
  if (pre) pre.textContent = Object.keys(c).length ? JSON.stringify(c, null, 2) : "{}  (any camera)";
}

function renderKV(containerId, pairs) {
  const box = vq(containerId);
  if (!box) return;
  box.innerHTML = "";
  if (!pairs.length) { box.textContent = "—"; return; }
  for (const [k, v] of pairs) {
    const row = document.createElement("div");
    row.className = "vc-kv-row";
    const key = document.createElement("span"); key.className = "vc-kv-key"; key.textContent = k;
    const val = document.createElement("span"); val.className = "vc-kv-val"; val.textContent = v;
    row.append(key, val);
    box.append(row);
  }
}

function renderReadouts() {
  const track = activeTrack();
  const live = vq("vc-live");
  if (!track) {
    vq("vc-resolution").textContent = "—";
    renderKV("vc-settings", []);
    renderKV("vc-caps", []);
    if (live) live.textContent = "no live track";
    return;
  }
  const settings = track.getSettings ? track.getSettings() : {};
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  vq("vc-resolution").textContent = describeResolution(settings);
  renderKV("vc-settings", summarizeSettings(settings));
  renderKV("vc-caps", summarizeCapabilities(caps));
  if (live) {
    const src = (voiceApi && voiceApi.getCallTrack && voiceApi.getCallTrack() === track) ? "live call" : "standalone";
    live.textContent = `${src} · readyState=${track.readyState} muted=${track.muted} enabled=${track.enabled}`;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(renderReadouts, 1000);
  renderReadouts();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function stopStandalone() {
  if (standalone) {
    standalone.getTracks().forEach((t) => t.stop());
    standalone = null;
  }
  const preview = vq("vc-preview");
  // Only detach the preview if it isn't showing a live call track.
  if (preview && !activeTrack()) preview.srcObject = null;
}

async function refreshDevices() {
  const sel = vq("vc-device");
  if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const cams = devices.filter((d) => d.kind === "videoinput");
  const prev = sel.value;
  sel.innerHTML = "";
  sel.append(new Option("default camera", ""));
  cams.forEach((d, i) => sel.append(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function openCamera() {
  let constraints;
  try { constraints = currentConstraints(); } catch (e) { status(e.message, true); return; }
  if (voiceApi && voiceApi.getCallTrack && voiceApi.getCallTrack()) {
    status("a call is live — use “Apply live” to tune its camera instead of opening a second session", true);
    return;
  }
  stopStandalone();
  status("opening camera…");
  try {
    standalone = await navigator.mediaDevices.getUserMedia({ video: Object.keys(constraints).length ? constraints : true, audio: false });
  } catch (err) {
    status(`getUserMedia failed — ${err.name}: ${err.message}`, true);
    return;
  }
  const vt = standalone.getVideoTracks()[0];
  if (vt) vt.contentHint = "motion";
  vq("vc-preview").srcObject = standalone;
  setRequested(constraints);
  status("camera open");
  await refreshDevices(); // device labels appear once permission is granted
  startPolling();
}

async function applyLive() {
  const track = activeTrack();
  if (!track) { status("no live track — open the camera first", true); return; }
  let constraints;
  try { constraints = currentConstraints(); } catch (e) { status(e.message, true); return; }
  setRequested(constraints);
  status("applying…");
  try {
    await track.applyConstraints(constraints);
    status("applyConstraints ✓");
  } catch (err) {
    status(`applyConstraints failed — ${err.name}: ${err.message}`, true);
  }
  renderReadouts();
}

function saveDefault() {
  let constraints;
  try { constraints = currentConstraints(); } catch (e) { status(e.message, true); return; }
  if (!Object.keys(constraints).length) { status("nothing to save — set at least one constraint", true); return; }
  voiceApi.setOverride(constraints);
  reflectDefault();
  status("saved ✓ — the next call will capture with this profile");
}

function clearDefault() {
  voiceApi.clearOverride();
  reflectDefault();
  status("call default reset to the built-in profile");
}

function reflectDefault() {
  const box = vq("vc-default");
  if (!box) return;
  const override = voiceApi && voiceApi.getOverride ? voiceApi.getOverride() : null;
  const dflt = voiceApi ? voiceApi.defaultConstraints : null;
  box.textContent = override
    ? `override: ${JSON.stringify(override)}`
    : `built-in: ${JSON.stringify(dflt)}`;
}

function wirePresets() {
  const box = vq("vc-presets");
  if (!box) return;
  box.innerHTML = "";
  for (const p of RESOLUTION_PRESETS) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = p.label;
    b.onclick = () => { vq("vc-width").value = p.width; vq("vc-height").value = p.height; };
    box.append(b);
  }
  const clear = document.createElement("button");
  clear.type = "button"; clear.textContent = "clear";
  clear.onclick = () => { vq("vc-width").value = ""; vq("vc-height").value = ""; vq("vc-fps").value = ""; vq("vc-ar").value = ""; };
  box.append(clear);

  const arSel = vq("vc-ar");
  if (arSel && !arSel.options.length) {
    for (const a of ASPECT_RATIOS) arSel.append(new Option(a.label, a.value === "" ? "" : String(a.value)));
  }
}

// initVideoConsole wires the console once and refreshes its live state. Call it
// each time the admin panel opens (it's idempotent — controls are wired only on
// the first call). `bridge` injects the voice.js coupling so this module stays
// DOM-only and its pure helpers import cleanly under node.
export function initVideoConsole(bridge) {
  voiceApi = bridge;
  if (typeof document === "undefined" || !vq("video-console")) return;
  if (!wired) {
    wired = true;
    wirePresets();
    vq("vc-open").onclick = openCamera;
    vq("vc-apply").onclick = applyLive;
    vq("vc-stop").onclick = () => { stopStandalone(); stopPolling(); renderReadouts(); status("standalone capture stopped"); };
    vq("vc-save").onclick = saveDefault;
    vq("vc-clear").onclick = clearDefault;
    vq("vc-device").onchange = () => { if (standalone) openCamera(); };
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", () => { refreshDevices(); });
    }
  }
  refreshDevices();
  reflectDefault();
  // If a call is live, start reading its track straight away.
  if (activeTrack()) { startPolling(); status("reading the live call camera"); }
  else renderReadouts();
}

// stopVideoConsole releases the console's own camera and stops polling. Called
// when the admin panel closes so the camera light doesn't stay on. A live call's
// own track is left untouched.
export function stopVideoConsole() {
  stopStandalone();
  stopPolling();
}
