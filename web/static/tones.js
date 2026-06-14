// tones.js — every Web Audio synthesis the client makes, behind one
// gesture-primed AudioContext. Three callers used to grow their own oscillator +
// gain-envelope code (the notification chime + greet/farewell in app.js, the
// ring/pending tones in voice.js); this is the single home for all of it.
//
// Browsers require a user gesture before audio can play, so we lazily create and
// resume the context on the first interaction (primeAudio, wired to gesture
// events by the caller). Every player no-ops until that has happened — silent,
// never an error, never an autoplay-policy console warning.

let audioCtx = null;

// primeAudio unlocks/keeps-alive the shared context. Wire it to user-gesture
// events (pointerdown/keydown/click/touchend) — browsers differ on which one
// grants audio activation, and a context the browser auto-suspended (idle or
// backgrounded tab) is resumed on the next interaction.
export function primeAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {
    /* no Web Audio; tones simply won't play */
  }
}

// A small lookahead so the gain envelope's attack is always scheduled in the
// future. resume() can take a few ms to settle; without the cushion the ramp's
// start lands in the past and the browser clips the attack — which read as a
// quieter, decaying tone across rapid suspend/resume cycles.
const TONE_LOOKAHEAD = 0.06;

// boop — a small, soft notification chime (no asset to ship). A gentle downward
// bend reads as a rounded, low-key "boop". Kept a touch baritone, but not so low
// that small speakers (which roll off bass) swallow it; the gain is nudged up to
// compensate for reduced low-frequency loudness.
export function boop() {
  // Only use a context that a prior user gesture already created — never create
  // one here, or the browser logs "AudioContext was prevented from starting".
  if (!audioCtx) return;
  const run = () => {
    const t = audioCtx.currentTime + TONE_LOOKAHEAD;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(380, t + 0.18);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.015); // soft attack
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22); // quick gentle decay
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.23);
  };
  // Always resume()-then-run, not just when state is already "suspended": a
  // call teardown (mic + peers closing) can suspend the context a beat AFTER we
  // check, so an unconditional resume covers that race. resume() on a running
  // context resolves immediately and is harmless.
  audioCtx.resume().then(run).catch(() => {});
}

// playTones plays a short sequence of sine notes ({f: Hz, t: start offset, d:
// duration}) on the gesture-primed shared context. Like boop(), it never creates
// the context itself — silent until a user gesture has primed audio.
function playTones(seq) {
  if (!audioCtx) return;
  const run = () => {
    const t0 = audioCtx.currentTime + TONE_LOOKAHEAD;
    for (const n of seq) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = n.f;
      const s = t0 + n.t;
      gain.gain.setValueAtTime(0.0001, s);
      gain.gain.exponentialRampToValueAtTime(0.14, s + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, s + n.d);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(s);
      osc.stop(s + n.d + 0.02);
    }
  };
  // See boop(): unconditional resume covers the post-teardown suspend race.
  audioCtx.resume().then(run).catch(() => {});
}

// A rising two-note chirp when someone joins the call, falling when they leave —
// the direction makes the two instantly distinguishable without looking.
export function greetTone() { playTones([{ f: 523, t: 0, d: 0.12 }, { f: 784, t: 0.1, d: 0.18 }]); }
export function farewellTone() { playTones([{ f: 784, t: 0, d: 0.12 }, { f: 523, t: 0.1, d: 0.18 }]); }

// --- call ring / pending tones ----------------------------------------------
//
// The incoming-call ringtone (callee) and the call-pending tone (caller waiting
// for pickup) are independent so they never share an interval — a single client
// is only ever one side of a ring, but keeping them separate is cheap and avoids
// any cross-talk. Both run on the same shared audioCtx as the tones above.
let ringInterval = null;
let ringTick = 0; // counts ringtone repeats, to occasionally accent
let pendingInterval = null;

// startRingSound plays the incoming-call ringtone (what the *callee* hears): a
// light, floaty arpeggio of harmonious tones, every few rings adding a brighter
// accent to grab attention. Repeats every 3s.
export function startRingSound() {
  if (ringInterval) stopRingSound();
  ringTick = 0;
  playRingTone(ringTick);
  ringInterval = setInterval(() => playRingTone(++ringTick), 3000);
}

export function stopRingSound() {
  clearInterval(ringInterval);
  ringInterval = null;
  ringTick = 0;
}

// startPendingSound plays the call-pending tone (what the *caller* hears while
// waiting for the other party to pick up): the old two-tone phone ring, which
// reads naturally as a "we're dialing, hold on" sound. Repeats every 3s.
export function startPendingSound() {
  if (pendingInterval) stopPendingSound();
  playPendingTone();
  pendingInterval = setInterval(() => playPendingTone(), 3000);
}

export function stopPendingSound() {
  clearInterval(pendingInterval);
  pendingInterval = null;
}

// playRingTone: a gentle ascending arpeggio over a major-sixth chord (C–E–G–A),
// sine waves with a slow attack and long release so the notes bloom and overlap
// — floaty and harmonious. Every third ring (tick % 3 === 2) adds a sharp,
// bright accent an octave up to catch a distracted ear.
function playRingTone(tick) {
  const ctx = audioCtx;
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
function playPendingTone() {
  const ctx = audioCtx;
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
