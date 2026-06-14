// app.js — the rivendell web client. Wires the API, websocket, formatter, and the
// pure state reducer to the DOM. Deliberately framework-free.

import { api } from "./api.js?v=__RIVENDELL_VERSION__";
import { connectRealtime } from "./ws.js?v=__RIVENDELL_VERSION__";
import { formatMessage, mentionsUser, permalinkHash, parsePermalink, extractHideURL, replySnippet, dataUriToFile, BUILTIN_EMOJI } from "./format.js?v=__RIVENDELL_VERSION__";
import * as S from "./state.js?v=__RIVENDELL_VERSION__";
import {
  shouldNotify,
  showNotification,
  showViaServiceWorker,
  closeNotificationsByTag,
  requestNotificationPermission,
  currentPermission,
  notificationsSupported,
  pushSupported,
  ensureServiceWorker,
  subscribeToPush,
  unsubscribeFromPush,
  pushSubscriptionPayload,
} from "./notify.js?v=__RIVENDELL_VERSION__";
import {
  initSecret,
  isSecretSupported,
  getSession,
  clearEndedSession,
  terminateSessionForPeer,
  sendEndAllOnUnload,
  sendSecretMessage,
  handleSecretEvent,
} from "./secret.js?v=__RIVENDELL_VERSION__";
import {
  initVoice,
  fetchIceServers,
  joinVoiceChannel,
  leaveVoiceChannel,
  endCallLocally,
  setVoiceMuted,
  setVoiceDeafened,
  setCameraEnabled,
  isCameraEnabled,
  cameraErrorMessage,
  loadCameraPreference,
  getVideoEl,
  getLocalVideoEl,
  isVoiceMuted,
  isVoiceDeafened,
  isInCall,
  voiceChannelId,
  setSpeakingCallback,
  setCameraErrorCallback,
  setVolumeForUser,
  getVolumeForUser,
  handleVoiceSignal,
  startRingSound,
  stopRingSound,
  startPendingSound,
  stopPendingSound,
  pttShouldFire,
  pttKeyLabel,
  micErrorMessage,
  registerDebug,
  reconcilePeers,
} from "./voice.js?v=__RIVENDELL_VERSION__";
import { rtcDebugEnabled, createTelemetry } from "./rtcdebug.js?v=__RIVENDELL_VERSION__";
import { createUnreadTracker, unreadCountAfter, classifyIncomingMessage } from "./unread.js?v=__RIVENDELL_VERSION__";
import { regularChannelOrder, sidebarChannelOrder, dmDisplayName, channelReorderPatches } from "./channelorder.js?v=__RIVENDELL_VERSION__";
import { createDraftStore } from "./drafts.js?v=__RIVENDELL_VERSION__";
import { upgradeComposerField } from "./composer-field.js?v=__RIVENDELL_VERSION__";
import { humanBytes, formatTime, overSizeLimit } from "./util.js?v=__RIVENDELL_VERSION__";
import { createPrefs, normalizeTheme } from "./prefs.js?v=__RIVENDELL_VERSION__";
import { createAttachmentTray, composeMessageBody } from "./attachments.js?v=__RIVENDELL_VERSION__";
import { createAutocomplete } from "./autocomplete.js?v=__RIVENDELL_VERSION__";
import { createSearch } from "./search.js?v=__RIVENDELL_VERSION__";
import { createEmojiPicker } from "./emoji.js?v=__RIVENDELL_VERSION__";
import { createChannelDrag } from "./channeldrag.js?v=__RIVENDELL_VERSION__";
import { presenceClass, presenceDecision } from "./presence.js?v=__RIVENDELL_VERSION__";
import { createImageWarmer } from "./imagewarm.js?v=__RIVENDELL_VERSION__";
import { createLinkPreviews } from "./linkpreview.js?v=__RIVENDELL_VERSION__";
import { createAdminPanel } from "./admin.js?v=__RIVENDELL_VERSION__";
import { createSecretUI } from "./secretui.js?v=__RIVENDELL_VERSION__";
import { createForward } from "./forward.js?v=__RIVENDELL_VERSION__";
import { createPins } from "./pins.js?v=__RIVENDELL_VERSION__";
import { createModals } from "./modals.js?v=__RIVENDELL_VERSION__";
import { createMobileCtx } from "./mobilectx.js?v=__RIVENDELL_VERSION__";

// --- module state ------------------------------------------------------------
// All mutable module-level state, grouped by concern. `state` is the immutable
// world model (state.js); everything else is ephemeral session bookkeeping that
// resets on reload. `state` is reassigned on every update — read it fresh, never
// capture it. (TDZ isn't a concern: every read happens inside a function called
// later, not at module-eval; the only eval-time reads are the prefs.loadX seeds,
// and `prefs` is declared before them.)

// Core app shell.
let state = S.initialState();
let socket = null;
let wasOffline = false; // tracks realtime disconnects so a reconnect can resync
let isIdle = false;     // client-side idle state, re-signaled on reconnect
let baseTitle = document.title; // brand title, sans any "(N)" notification prefix
let appVersion = "";    // server-reported semantic version, shown in the About dialog
let debugTelemetryFlag = false; // server switch (GET /api/instance) forcing WebRTC telemetry on for all clients
// Server-reported upload size ceilings (bytes) for the client-side pre-check.
// 0 = unknown (instance fetch failed) → skip it and let the server enforce.
let maxImageBytes = 0;
let maxAvatarBytes = 0;

// Browser-local preferences (notifications + push-to-talk). prefs.js handles
// load/persist + localStorage fail-safety; app.js holds the live values. `prefs`
// must precede the values seeded from it.
const prefs = createPrefs();
// Desktop-notification opt-in (per browser). The OS permission is separate and
// browser-owned; this is the in-app preference that gates it.
let notifEnabled = prefs.loadNotif();
// Push-to-talk: when enabled the mic stays muted in a call until the bound key is
// held (see wirePushToTalk). pttKeyCode is a layout-independent KeyboardEvent.code
// (default backtick); pttTransmitting is true only while held; pttCapturing is
// true while the profile-modal rebind UI awaits a keypress.
let pttEnabled = prefs.loadPttEnabled();
let pttKeyCode = prefs.loadPttKeyCode();
let pttTransmitting = false;
let pttCapturing = false;

// Ephemeral bookkeeping owned by sibling modules (not part of `state`).
const unread = createUnreadTracker(); // divider cursor, mark-unread suppression, mark-read POST dedupe
const drafts = createDraftStore();    // per-channel composer scratch (draft text + pending uploads)
let composerTray = null;              // attachments.js upload tray; null until wireComposer builds it (guard with ?.)
// Per-user avatar cache-bust token: bumped on user.update(avatar) to force a
// re-fetch of the otherwise-stable, cached avatar URL.
const avatarVersion = {};
// Message ids deleted *during this session* (seen live via message.delete); only
// these earn a tombstone, so a fresh history load isn't littered with them.
const liveDeleted = new Set();

// Composer: inline message editing + reply target. renderMessages is the source
// of truth — when a message's id == editingMessageId it draws an inline editor
// (not body+actions) seeded from editDraft; editDraft + caret are captured and
// restored across re-renders so an incoming event mid-edit can't blow the editor
// away (see renderMessages).
let editingMessageId = null;  // id of the message being edited inline, or null
let editDraft = "";           // current text of the inline editor, preserved on re-render
let editFocusPending = false; // focus the editor on the next render (it just opened)
let replyingToId = null;      // id of the message the composer is replying to, or null

// Active-channel membership: member ids when the channel is private (incl. DMs);
// null means "show everyone" (public channels have no membership rows). (Which
// DMs are open is server-authoritative via the dm_open table: the channel list
// endpoint only returns open DMs, so state.channels holds just those — closeDM
// hides one per-user across devices, startDM / a fresh message reopens it.)
let activeMemberIds = null;

// Scrollback: messages load a page at a time as you scroll.
const PAGE = 50;
let loadingOlder = false; // guards overlapping back-paging fetches
let loadingNewer = false; // guards overlapping forward-paging fetches
const historyComplete = new Set(); // channelIds whose oldest message is loaded
const viewingHistory = new Set();  // channelIds whose loaded bottom isn't the live tail
let flashMessageId = null;         // id of a jumped-to message to highlight; survives re-renders

// Voice / call state. (Secret-chat banner state lives in secretui.js; app.js
// reads the pending request via secretUI.getSecretRequest().)
let ringState = null; // in-progress ring: { channelId, direction: "outgoing"|"incoming", fromUserId }
let voiceCallState = { inCall: false, channelId: null, muted: false, deafened: false, videoMuted: true, participants: [] }; // live from voice.js (via callback)
let videoViewHidden = false; // mobile user tapped 💬 to view chat mid video call; cleared on end / channel switch / both-cameras-off
let voiceRosters = {};       // channelId → [{user_id, joined_at, muted}] for sidebar display
let callParticipantIds = new Set(); // user ids on our active call (self incl.), from voiceCallState; drives the on-call cue + greet/farewell tones
let speakingIds = new Set(); // user ids currently speaking (voice.js metering via onSpeaking); pulses a ring on roster rows
let voiceTelemetry = null;   // rtcdebug capture hook when enabled, else null; records app-side voice events alongside voice.js's
// DM partner volume: the header 🔊 toggles a compact slider for the other DM
// participant (reusing voice.js per-user playout gain). These track which DM it's
// bound to and whether it's expanded, so a re-render doesn't collapse it
// mid-adjust, while a channel switch / the partner leaving does reset it (see
// renderChannelHeader).
let dmVolumeChannelId = null;
let dmVolumeOpen = false;

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    // Skip null/undefined AND boolean false: setAttribute("disabled", false)
    // still yields disabled="false", which disables the element (any presence of
    // the attribute does). Boolean false must mean "omit the attribute".
    else if (v != null && v !== false) node.setAttribute(k, v);
  }
  for (const kid of kids) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

function show(view) {
  for (const v of document.querySelectorAll("[data-view]")) {
    v.hidden = v.dataset.view !== view;
  }
  // Auth views are never preceded by a loading phase — clear the overlay now so
  // it doesn't hide the login/signup form. The app view keeps the overlay until
  // enterApp() finishes its async work and calls dismissLoadingScreen() itself.
  if (view !== "app") dismissLoadingScreen();
}

// guard runs an async action and surfaces any failure as an alert() — the shared
// shape for the "fire-and-tell-me-if-it-breaks" API calls. Actions that recover
// from failure themselves (revert optimistic state, restore a composer, return
// early) keep their own try/catch rather than using this.
async function guard(action) {
  try {
    await action();
  } catch (ex) {
    alert(ex.message);
  }
}

// --- mobile viewport height --------------------------------------------------
// Pin a --app-height var to the *visual* viewport so the app fits the area not
// covered by the on-screen keyboard. Without this, focusing the composer makes
// the browser scroll the whole page and the header disappears off the top.
function trackViewportHeight() {
  const vv = window.visualViewport;
  const set = () => {
    // If the reader was pinned to the bottom, keep them there: shrinking the
    // viewport for the on-screen keyboard otherwise leaves the newest messages
    // hidden behind it. Measure before applying the new height.
    const ml = $("#message-list");
    const atBottom = ml && ml.scrollHeight - ml.scrollTop - ml.clientHeight < 80;
    const h = Math.round(vv ? vv.height : window.innerHeight);
    document.documentElement.style.setProperty("--app-height", `${h}px`);
    if (atBottom && ml) {
      // After the layout reflows to the new height, re-pin to the bottom.
      requestAnimationFrame(() => { ml.scrollTop = ml.scrollHeight; });
    }
  };
  set();
  if (vv) {
    vv.addEventListener("resize", set);
    vv.addEventListener("scroll", set);
  }
  window.addEventListener("orientationchange", set);
}

// --- notification chime ------------------------------------------------------
// A small, soft "boop" synthesized with the Web Audio API (no asset to ship).
// Browsers require a user gesture before audio can play, so we lazily create and
// resume the context on the first interaction.
let audioCtx = null;
function primeAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {
    /* no Web Audio; chime simply won't play */
  }
}
// tabUnfocused reports whether the user isn't actually looking here — the tab is
// backgrounded/minimized (document.hidden) or another window/app has focus
// (!document.hasFocus()).
function tabUnfocused() {
  return document.hidden || !document.hasFocus();
}

// A small lookahead so the gain envelope's attack is always scheduled in the
// future. resume() can take a few ms to settle; without the cushion the ramp's
// start lands in the past and the browser clips the attack — which read as a
// quieter, decaying tone across rapid suspend/resume cycles.
const TONE_LOOKAHEAD = 0.06;

function boop() {
  // Only use a context that a prior user gesture already created — never create
  // one here, or the browser logs "AudioContext was prevented from starting".
  if (!audioCtx) return;
  const run = () => {
    const t = audioCtx.currentTime + TONE_LOOKAHEAD;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    // A gentle downward bend reads as a rounded, low-key "boop". Kept a touch
    // baritone, but not so low that small speakers (which roll off bass) swallow
    // it; the gain is nudged up to compensate for reduced low-frequency loudness.
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
function greetTone() { playTones([{ f: 523, t: 0, d: 0.12 }, { f: 784, t: 0.1, d: 0.18 }]); }
function farewellTone() { playTones([{ f: 784, t: 0, d: 0.12 }, { f: 523, t: 0.1, d: 0.18 }]); }

// --- bootstrapping -----------------------------------------------------------

async function boot() {
  trackViewportHeight();
  // Unlock/keep-alive audio on user gestures (autoplay policy). Several event
  // types because browsers differ on which one grants audio activation (Safari
  // favours click/touchend over pointerdown). Not {once} so a context the
  // browser auto-suspended (idle/backgrounded tab) is resumed on next interaction.
  for (const ev of ["pointerdown", "keydown", "click", "touchend"]) {
    window.addEventListener(ev, primeAudio);
  }
  await applyInstanceName();
  // Set-password route: /set-password#<token>
  if (location.pathname === "/set-password") {
    return bootSetPassword();
  }
  // Invitation signup route: /invite#<token>
  if (location.pathname === "/invite") {
    return bootSignup();
  }
  try {
    const me = await api.me();
    state = S.setMe(state, me);
    await enterApp();
  } catch {
    show("login");
    wireLogin();
  }
}

// applyInstanceName brands the page (title + every .brand) from the server's
// configured instance name, so an operator can call their instance whatever they
// like. Best-effort: a failed fetch just leaves the default markup.
async function applyInstanceName() {
  try {
    const inst = await api.instance();
    if (inst.version) {
      appVersion = inst.version;
      const vEl = $("#about-version");
      if (vEl) vEl.textContent = "v" + inst.version;
    }
    if (inst.name) {
      baseTitle = inst.name;
      document.title = inst.name;
      for (const node of document.querySelectorAll(".brand")) node.textContent = inst.name;
    }
    if (inst.max_image_bytes) maxImageBytes = inst.max_image_bytes;
    if (inst.max_avatar_bytes) maxAvatarBytes = inst.max_avatar_bytes;
    debugTelemetryFlag = !!inst.debug_telemetry;
  } catch {
    /* keep the default branding */
  }
}

// fileTooLarge is the DOM adapter over the pure overSizeLimit check (util.js):
// it fails fast when a chosen file exceeds the server's upload ceiling, alerting
// the user instead of spending the upload bandwidth on a doomed POST. Returns
// true if the file was rejected.
function fileTooLarge(file, limit, label) {
  if (!overSizeLimit(file.size, limit)) return false;
  alert(`That ${label} is ${humanBytes(file.size)}, which is over the ${humanBytes(limit)} limit.`);
  return true;
}

function wireLogin() {
  const form = $("#login-form");
  const err = $("#login-error");
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      const me = await api.login($("#login-username").value.trim(), $("#login-password").value);
      state = S.setMe(state, me);
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
}

async function bootSetPassword() {
  show("set-password");
  const token = location.hash.replace(/^#/, "");
  const intro = $("#sp-intro");
  const err = $("#sp-error");
  if (!token) {
    err.textContent = "This link is missing its token.";
    return;
  }
  try {
    const { purpose } = await api.checkMagic(token);
    intro.textContent = purpose === "reset_password" ? "Choose a new password." : "Welcome! Set a password to get started.";
  } catch {
    err.textContent = "This link is invalid or has expired. Ask an admin for a new one.";
    $("#sp-form").hidden = true;
    return;
  }
  $("#sp-form").onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    const pw = $("#sp-password").value;
    const pw2 = $("#sp-password2").value;
    if (pw !== pw2) {
      err.textContent = "Passwords don't match.";
      return;
    }
    if (pw.length < 10) {
      err.textContent = "Password must be at least 10 characters.";
      return;
    }
    try {
      const me = await api.setPassword(token, pw);
      state = S.setMe(state, me);
      history.replaceState(null, "", "/");
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
}

// bootSignup drives the invitation route: validate the token, then let the new
// person choose a username + password. On success the server creates the member
// account, logs them in, and we drop straight into the app.
async function bootSignup() {
  show("signup");
  const token = location.hash.replace(/^#/, "");
  const err = $("#su-error");
  if (!token) {
    err.textContent = "This invitation link is missing its token.";
    $("#su-form").hidden = true;
    return;
  }
  try {
    await api.checkInvitation(token);
  } catch {
    err.textContent = "This invitation is invalid or has expired. Ask an admin for a new one.";
    $("#su-form").hidden = true;
    return;
  }
  $("#su-form").onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    const username = $("#su-username").value.trim().toLowerCase();
    const pw = $("#su-password").value;
    const pw2 = $("#su-password2").value;
    if (!/^[a-z0-9_]{2,32}$/.test(username)) {
      err.textContent = "Username must be 2-32 characters: lowercase letters, digits, or underscore.";
      return;
    }
    if (pw !== pw2) {
      err.textContent = "Passwords don't match.";
      return;
    }
    if (pw.length < 10) {
      err.textContent = "Password must be at least 10 characters.";
      return;
    }
    try {
      const me = await api.signup(token, username, pw);
      state = S.setMe(state, me);
      history.replaceState(null, "", "/");
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
}

async function enterApp() {
  show("app");
  const [users, channels] = await Promise.all([api.users(), api.channels()]);
  state = S.setUsers(state, users);
  state = S.setChannels(state, channels);
  imageWarm.preloadAvatars(); // warm the avatar cache so channel switches paint without jank
  // Custom emojis power :shortcode: rendering; best-effort so a failure here
  // never blocks the app from loading (messages just render the literal text).
  try {
    state = S.setEmojis(state, await api.emojis());
  } catch (e) {
    /* non-fatal: :shortcode: tokens stay literal until the list loads */
  }
  // Seed durable unread/mention counts from the server so badges and the global
  // total survive a refresh (best-effort: a failure just leaves them empty).
  try {
    const summary = await api.unread();
    state = S.setUnreadSummary(state, summary.channels);
    state = S.setMutedChannels(state, summary.muted);
  } catch (e) {
    /* non-fatal: counts will populate as realtime events arrive */
  }
  // Seed voice rosters so the sidebar shows who's already in voice on load.
  try {
    const vs = await api.voiceState();
    for (const { channel_id, participants } of vs) {
      voiceRosters[channel_id] = participants;
    }
  } catch (e) {
    /* non-fatal: sidebar voice cues populate from realtime events */
  }
  // Restore the channel the user last had open (if it's still accessible);
  // otherwise prefer a real channel over a DM on first load.
  let saved = null;
  try {
    saved = localStorage.getItem("rivendell.activeChannel");
  } catch (e) {
    /* localStorage may be unavailable (private mode / blocked) */
  }
  // Use the channel's own id (a number) — localStorage hands back a string,
  // which would fail the `===` comparisons used throughout rendering/realtime.
  // A closed DM isn't in state.channels (the server omits it), so it can't be
  // restored as the active channel.
  const restore = saved && state.channels[saved] ? state.channels[saved].id : null;
  const firstChannel = restore || regularChannelOrder(state)[0] || state.channelOrder[0];
  if (firstChannel) {
    state = S.setActiveChannel(state, firstChannel);
  }
  renderMe();
  rerenderSidebar();
  renderAdminVisibility();
  renderNotificationTotal();
  // Check for a permalink hash (#c<channelId>/m<messageId>) before loading
  // the default channel — if present, jump there instead.
  const permalink = parsePermalink(location.hash);
  if (permalink) {
    history.replaceState(null, "", "/");
    const plChannel = permalink.channelId;
    const plMessage = permalink.messageId;
    if (state.channels[plChannel]) {
      await jumpToMessage(plChannel, plMessage);
    } else if (state.activeChannelId) {
      await loadChannel(state.activeChannelId);
    }
  } else if (state.activeChannelId) {
    await loadChannel(state.activeChannelId);
    markActiveChannelRead();
  }
  // Warm any images already rendered in the active channel, then fade out the
  // loading screen so the first visible frame has content fully painted.
  await imageWarm.warmViewportImages();
  dismissLoadingScreen();
  imageWarm.startBackgroundImageWarm(); // fire-and-forget; warms blob images across all channels
  // Voice: init module with our user id and the socket send function. Ice servers
  // are fetched in the background — they'll be ready well before any call starts.
  initVoice(state.me.id, (msg) => socket && socket.send(msg), onVoiceStateChange, greetTone, farewellTone);
  // WebRTC debug telemetry: opt-in per client (?rtcdebug=1 / localStorage) or
  // forced on for everyone by the server flag. When enabled, capture batches
  // getStats() + lifecycle events to POST /api/debug/telemetry (logged server-side).
  if (rtcDebugEnabled(debugTelemetryFlag)) {
    voiceTelemetry = createTelemetry({ getVideoEl });
    registerDebug(voiceTelemetry);
  }
  setSpeakingCallback(onSpeaking);
  setCameraErrorCallback((err) => alert(cameraErrorMessage(err)));
  fetchIceServers(); // best-effort; falls back to public STUN on error
  wireVoiceControls();
  // Secret chat: init module, wire controls, check browser support.
  initSecret(state.me.id, (msg) => socket && socket.send(msg), onSecretEvent);
  wireSecretControls();
  isSecretSupported().then((ok) => {
    const btn = $("#secret-btn");
    if (!ok) btn.title = "Secret chat needs a current browser (Ed25519/X25519 WebCrypto)";
    btn.dataset.supported = ok ? "1" : "0";
    // Publish our identity key at boot (idempotent) so any peer can offer us a
    // secret chat without a prior handshake — avoids the chicken-and-egg where
    // neither side can make the first offer because the other has no key yet.
    if (ok) secretUI.publishMyKey();
  });
  // Wire interactive controls BEFORE realtime, so a transport problem can never
  // leave the composer/admin/avatar handlers unattached.
  wireComposer();
  wireControls();
  wireSwipe();
  wireIdleDetection();
  // Web Push: register the service worker + refresh the subscription if
  // notifications are on, and route SW notification clicks to the message.
  initPushRouting();
  // Returning to the tab clears the open channel's unread (you're looking now).
  window.addEventListener("focus", onWindowFocus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onWindowFocus();
  });
  // Best-effort: notify peers that this session is ending when the page unloads.
  // The server-side WS-disconnect cleanup is the fallback for both.
  window.addEventListener("beforeunload", () => {
    sendEndAllOnUnload();
    // Send voice.leave so the server ends the DM call before the WS closes.
    // cleanupVoiceForUser (on WS close) only fires when this was the user's
    // last connection — the beforeunload path has no such condition.
    if (isInCall()) {
      const chId = voiceChannelId();
      if (chId !== null) {
        try { socket && socket.send({ type: "voice.leave", channel_id: chId }); } catch {}
      }
    }
  });
  try {
    startRealtime();
  } catch (e) {
    console.warn("rivendell: realtime unavailable:", e && e.message);
  }
}

// onWindowFocus marks the active channel read when the user returns to the tab.
function onWindowFocus() {
  if (state.activeChannelId) markActiveChannelRead();
}

// --- realtime ----------------------------------------------------------------

function startRealtime() {
  if (socket) socket.close();
  socket = connectRealtime(
    (evt) => {
      // Presence is debounced (see schedulePresenceUpdate): a transient flip that
      // reverts within ~1s never paints, so dots don't flicker on brief blips.
      if (evt.type === "presence.update") { schedulePresenceUpdate(evt); return; }
      // member.remove's side effects below need to know whether the channel was
      // still present *before* applyEvent folds the removal in — so a removal we
      // already did locally (leaveActiveChannel) doesn't trigger a redundant reload.
      const hadChannel = evt.type === "member.remove" && !!state.channels[evt.payload.channel_id];
      state = S.applyEvent(state, evt);
      // Targeted re-renders based on event type.
      if (evt.type.startsWith("presence") || evt.type === "user.update") {
        if (evt.type === "user.update" && evt.payload && evt.payload.has_avatar) {
          // Their avatar may have changed — force a re-fetch on next render.
          avatarVersion[evt.payload.id] = Date.now();
          imageWarm.preloadAvatars(); // warm the new versioned URL ahead of the repaint
        }
        renderMembers();
        renderMe();
        renderDMs(); // a DM row shows the other participant's name + presence
        // Author display name / avatar in the open message list may have changed.
        if (evt.type === "user.update") renderMessages();
      }
      if (evt.type.startsWith("channel")) {
        renderChannels();
        renderDMs();
        // Membership may have changed (e.g. someone was invited) — re-scope the
        // members panel if the event concerns the channel we're viewing. A topic
        // edit by another mod also arrives here, so repaint the header (unless I'm
        // mid-edit, to avoid clobbering my own input).
        if (evt.payload && evt.payload.id === state.activeChannelId) {
          if (!$("#channel-topic").querySelector("input")) {
            renderChannelHeader(state.channels[state.activeChannelId]);
          }
          refreshActiveMembers();
        }
      }
      if (evt.type === "member.remove") {
        const { channel_id, user_id } = evt.payload;
        if (user_id === state.me.id) {
          // applyEvent dropped the channel for me (non-admin); render the
          // consequences — unless it was already gone before the fold (e.g.
          // leaveActiveChannel handled it), which hadChannel guards.
          if (hadChannel && !S.isAdmin(state.me)) {
            renderChannels();
            renderDMs();
            renderNotificationTotal();
            // removeChannel re-pointed activeChannelId; load the new active one.
            if (state.activeChannelId) loadChannel(state.activeChannelId);
          } else if (hadChannel && channel_id === state.activeChannelId) {
            // Admin lost membership on the active channel (via another session or
            // another admin) but keeps bypass access — hide the leave button and
            // re-fetch so the roster is accurate.
            $("#leave-btn").hidden = true;
            refreshActiveMembers();
          }
        } else if (channel_id === state.activeChannelId && activeMemberIds) {
          // Someone else left the channel I'm viewing — drop them from the roster
          // immediately (no re-fetch).
          activeMemberIds.delete(user_id);
          renderMembers();
        }
      }
      if (evt.type === "hello") {
        // The server greets each connection with its version. If it differs from
        // the build we loaded, a newer server is running (a deploy happened) —
        // offer a graceful reload rather than yanking the page out from under.
        if (appVersion && evt.payload && evt.payload.version && evt.payload.version !== appVersion) {
          $("#update-banner").hidden = false;
        }
      }
      if (evt.type === "read.update" || evt.type === "read.unread" || evt.type === "mute.update") {
        // A session caught up on / marked unread / muted a channel (state.applyEvent
        // already folded it in); reflect the badges and the global total.
        renderChannels();
        renderDMs();
        renderNotificationTotal();
        // Keep 👁 button labels current in the open channel.
        if ((evt.type === "read.update" || evt.type === "read.unread") &&
            evt.payload.channel_id === state.activeChannelId) {
          renderMessages();
        }
      }
      if (evt.type === "typing.update") {
        if (evt.payload.channel_id === state.activeChannelId) renderTypingIndicator();
      }
      if (evt.type === "emoji.add" || evt.type === "emoji.delete") {
        // The registry changed: re-render the open messages so :shortcode: tokens
        // start/stop rendering as images, and refresh any open emoji surfaces.
        renderMessages();
        if (emojiPicker.isOpen()) emojiPicker.rerender();
        refreshEmojiManagerIfOpen();
      }
      if (evt.type === "reaction.update") {
        // applyEvent already folded the new groups into the message; just repaint
        // the open channel (and the pins panel, which renders reactions too).
        if (evt.payload.channel_id === state.activeChannelId) {
          renderMessages();
          refreshPinsIfOpen();
        }
      }
      if (evt.type.startsWith("voice.")) {
        onVoiceEvent(evt);
      }
      if (evt.type.startsWith("secret.")) {
        handleSecretEvent(evt, (userId) => {
          const u = state.users[userId];
          return u ? u.identity_key || null : null;
        }).catch((e) => console.warn("secret: event handler error:", e && e.message));
      }
      if (evt.type.startsWith("message")) {
        // A delete seen live earns a tombstone (unlike already-deleted history).
        if (evt.type === "message.delete") liveDeleted.add(evt.payload.id);
        const cid = evt.payload.channel_id;
        const ch = state.channels[cid];
        const active = cid === state.activeChannelId;
        const focused = !tabUnfocused();
        // The unread/mention/ping decision matrix is a pure function of state +
        // event + these three view booleans (see unread.js). isNewFromMe/Other
        // come back too, for the DOM side effects below.
        const d = classifyIncomingMessage(state, evt, {
          active,
          focused,
          adminPanelOpen: !$("#admin-panel").hidden,
        });
        // applyEvent bumped last_message_at so the DM list stays sorted by
        // recency; reflect a DM I just sent (ch is post-fold, already current).
        if (d.isNewFromMe && ch && ch.is_dm) renderDMs();
        if (active) {
          if (d.isNewFromMe && viewingHistory.has(cid)) {
            // I sent while viewing a history window (below the live tail): reload
            // the channel so my message shows at the bottom in proper context,
            // not appended after a gap of unloaded messages.
            loadChannel(cid);
          } else {
            renderMessages(d.isNewFromMe); // mine forces a jump to the newest
          }
          refreshPinsIfOpen(); // a pin/unpin arrives as a message.update
          if (focused && d.isNewFromOther) {
            // You're looking right at it — keep the read cursor current. If the
            // user is scrolled up, plant the marker at the current read position
            // so they see where new messages begin when they scroll down.
            if (!unread.markerFor(cid)) {
              const ml = $("#message-list");
              if (ml && ml.scrollHeight - ml.scrollTop - ml.clientHeight > 80) {
                unread.pinMarkerIfUnset(cid, state.lastRead[cid]);
              }
            }
            markActiveChannelRead();
          }
        }
        // Raise the unread badge for a message I won't immediately see read, and
        // separately the mention badge so @-mentions stand out. (A message landing
        // in a closed DM resurfaces it server-side, arriving as a channel.new just
        // before this event — so the row is already back.)
        if (d.countUnread) {
          state = S.bumpUnread(state, cid);
          if (d.countMention) state = S.bumpMention(state, cid);
          renderChannels();
          renderDMs();
          renderNotificationTotal();
        }
        // Chime + (if opted in) an OS notification for pings; plain channel
        // chatter stays silent with just the badge.
        if (d.ping) firePing(evt, ch);
      }
    },
    (online) => {
      $("#conn-status").className = online ? "conn online" : "conn offline";
      $("#conn-status").title = online ? "Connected" : "Reconnecting…";
      // Reconnecting only resumes the *stream* of new events; anything that
      // happened while we were dead is a gap. On a genuine reconnect (online
      // after having been offline), resync so the view isn't stale.
      if (online && wasOffline) resync();
      wasOffline = !online;
    }
  );
}

// resync re-pulls server state after a reconnect: rosters (presence may have
// changed), the channel list (new/archived channels, membership), and the
// active channel's latest messages — closing the gap left by a dead socket.
// (Unread for channels missed while offline isn't recomputed — there's no
// server-side unread record yet; that's what push notifications will cover.)
async function resync() {
  // Drop any deferred presence flips — the roster we're about to pull is the
  // authoritative truth; a stale debounced update must not fire over it.
  flushPendingPresence();
  try {
    const [users, channels] = await Promise.all([api.users(), api.channels()]);
    state = S.setUsers(state, users);
    state = S.setChannels(state, channels);
    imageWarm.preloadAvatars(); // re-warm the avatar cache after a reconnect roster refresh
    try {
      state = S.setEmojis(state, await api.emojis());
    } catch (e) {
      /* non-fatal */
    }
    // Re-pull durable unread counts: events missed while the socket was dead are
    // exactly the gap this closes (the old code couldn't recompute unread here).
    try {
      const summary = await api.unread();
      state = S.setUnreadSummary(state, summary.channels);
      state = S.setMutedChannels(state, summary.muted);
    } catch (e) {
      /* non-fatal */
    }
    // The channel we were on may have been archived while we were away.
    if (state.activeChannelId && !state.channels[state.activeChannelId]) {
      const next = regularChannelOrder(state)[0] || state.channelOrder[0] || null;
      state = S.setActiveChannel(state, next);
    }
    renderMe();
    rerenderSidebar();
    renderNotificationTotal();
    if (state.activeChannelId) {
      await loadChannel(state.activeChannelId);
      if (!tabUnfocused()) markActiveChannelRead();
    }
    // A reconnect is a fresh connection (server defaults it to active); re-signal
    // idle over the new socket so the dot stays correct.
    if (isIdle) socket && socket.send({ type: "idle", idle: true });
    // If we were in a call when the WS dropped, verify the server still has us
    // listed. voice.end is a targeted send — it's lost if our WS was dead when
    // it was sent. Checking here closes that gap: if the server ended the call
    // while we were offline we clean up now rather than waiting for ICE to fail.
    if (isInCall()) {
      try {
        const pts = await api.voiceParticipants(voiceChannelId());
        if (!pts.some((p) => p.user_id === state.me.id)) {
          endCallLocally();
        } else {
          // Close any peer connection whose user left while our WS was down.
          reconcilePeers(pts.map((p) => p.user_id));
        }
      } catch { /* non-fatal; if the check fails we'll eventually clean up via ICE */ }
    }
  } catch (ex) {
    console.warn("rivendell: resync failed:", ex && ex.message);
  }
}

// --- rendering ---------------------------------------------------------------

// applyTheme paints the chosen UI theme by setting data-theme on <html>; the CSS
// re-points its color variables for that theme (style.css). normalizeTheme
// (prefs.js) falls back to the dark default so a bad value can't leave the UI
// unstyled. The allow-list mirrors the <select> in index.html and validThemes
// on the server.
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", normalizeTheme(theme));
}

// myTheme is the persisted theme for the current user (the source of truth the
// profile-modal preview reverts to when closed without saving).
function myTheme() {
  const me = state.me ? state.users[state.me.id] || state.me : null;
  return me ? me.theme : "default";
}

function renderMe() {
  const me = state.users[state.me.id] || state.me;
  $("#me-name").textContent = me.display_name;
  $("#me-status-text").textContent = me.status_text || "";
  $("#me-avatar").style.backgroundImage = me.has_avatar ? `url(${avatarSrc(me.id)})` : "";
  $("#me-avatar").textContent = me.has_avatar ? "" : initials(me.display_name);
  $("#status-select").value = me.status;
  applyTheme(me.theme);
}

// navigateChannels moves the selection one row up (delta -1) or down (delta +1)
// through the sidebar order. Clamps at the ends (no wrap).
function navigateChannels(delta) {
  const next = S.nextChannelId(sidebarChannelOrder(state), state.activeChannelId, delta);
  if (next != null) selectChannel(next);
}

// navigateUnread jumps to the nearest unread conversation above (delta -1) or
// below (delta +1) the current one in sidebar order. No-op if there's none in
// that direction.
function navigateUnread(delta) {
  const next = S.nextUnreadChannelId(sidebarChannelOrder(state), state.activeChannelId, state.unread, delta);
  if (next != null) selectChannel(next);
}

// muteToggle builds the per-row mute control. It lives in the hover controls and
// flips the channel between silenced and not. 🔔 = notifications on (click to
// mute), 🔕 = muted (click to restore).
function muteToggle(id) {
  const muted = S.isMuted(state, id);
  return el("button", {
    class: "ch-ctl", title: muted ? "Unmute" : "Mute",
    onclick: (e) => { e.stopPropagation(); toggleMute(id); },
  }, muted ? "🔕" : "🔔");
}

function renderChannels() {
  // Don't repaint mid-drag: we mutate the row order in the DOM live while a mod
  // is dragging, and a rebuild from state would yank the row out from under the
  // pointer. The drop's broadcasts re-render once the drag has ended.
  if (channelDrag.isActive()) return;
  const list = $("#channel-list");
  list.innerHTML = "";
  const isMod = S.canModerate(state.me);
  // Mods can reorder by dragging a row (mouse) or long-pressing then dragging
  // (touch); the grab cursor is the affordance that replaced the ↑/↓ glyphs.
  list.classList.toggle("reorderable", isMod);
  const order = regularChannelOrder(state);
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const ch = state.channels[id];
    const active = id === state.activeChannelId;
    const controls = el("span", { class: "ch-controls" },
      muteToggle(id),
      isMod ? el("button", { class: "ch-ctl danger", title: "Delete channel",
        onclick: (e) => { e.stopPropagation(); deleteChannel(id); } }, "✕") : null);
    const unread = state.unread[id] || 0;
    const mentioned = state.mentions[id] || 0;
    const cls = "channel" + (active ? " active" : "") + (unread ? " unread" : "") + (S.isMuted(state, id) ? " muted" : "");
    const roster = voiceRosters[id] || [];
    const voiceRow = roster.length ? el("span", { class: "ch-voice" },
      "🔊 " + roster.map(p => (state.users[p.user_id] || {}).display_name || "?").join(", ")
    ) : null;
    const li = el("li", { class: cls, "data-ch-id": String(id), onclick: () => selectChannel(id) },
      el("span", { class: "ch-hash" }, ch.is_private ? "🔒" : "#"),
      el("span", { class: "ch-name" }, ch.name),
      unread ? el("span", { class: mentioned ? "unread-badge mention" : "unread-badge" }, mentioned ? `@${unread}` : String(unread)) : null,
      controls,
      voiceRow
    );
    if (isMod) channelDrag.wire(li, id);
    list.append(li);
  }
}

function renderDMs() {
  const list = $("#dm-list");
  list.innerHTML = "";
  // state.channels only holds DMs the server reports as open for us, so a plain
  // is_dm filter is the open set — no client-side hidden bookkeeping needed.
  const dms = state.channelOrder.filter((id) => state.channels[id].is_dm);
  $("#dm-head").hidden = dms.length === 0;
  for (const id of dms) {
    const ch = state.channels[id];
    const active = id === state.activeChannelId;
    const otherId = S.otherDMParticipant(ch, state.me.id);
    const other = otherId != null ? state.users[otherId] : null;
    const unread = state.unread[id] || 0;
    const secretReq = secretUI.getSecretRequest();
    const hasSecretReq = !!(secretReq && secretReq.dmChannelId === id);
    const cls = "channel" + (active ? " active" : "") + (unread ? " unread" : "") + (S.isMuted(state, id) ? " muted" : "");
    list.append(
      el("li", { class: cls, onclick: () => selectChannel(id) },
        el("span", { class: `dot ${other ? presenceClass(other) : "offline"}` }),
        el("span", { class: "ch-name" }, dmDisplayName(state, ch)),
        hasSecretReq ? el("span", { class: "secret-req-badge", title: "Secret chat request" }, "🔒") : null,
        unread ? el("span", { class: "unread-badge" }, String(unread)) : null,
        el("span", { class: "ch-controls" },
          muteToggle(id),
          // Anyone can close their own copy of a DM; reopen by clicking the name.
          el("button", { class: "ch-ctl danger", title: "Close DM",
            onclick: (e) => { e.stopPropagation(); closeDM(id); } }, "✕"))
      )
    );
  }
}

function renderMembers() {
  const list = $("#member-list");
  list.innerHTML = "";
  // Ordinary users don't see disabled accounts (matches the server roster);
  // admins keep seeing them so they can manage them.
  const isAdmin = S.isAdmin(state.me);
  const isMod = S.canModerate(state.me);
  let users = Object.values(state.users).filter((u) => isAdmin || u.is_active !== false);
  // In a private channel/DM, restrict the panel to that channel's members.
  if (activeMemberIds) users = users.filter((u) => activeMemberIds.has(u.id));
  // Moderators+ can remove others from a real private channel (not DMs/public).
  const activeCh = state.channels[state.activeChannelId];
  const canRemove = isMod && !!(activeCh && activeCh.is_private && !activeCh.is_dm);
  // Bots are hidden from public channel rosters; they show normally in private
  // channels they belong to, and remain visible in the invite list.
  if (activeCh && !activeCh.is_private) users = users.filter((u) => !u.is_bot);
  // On-call cue: only meaningful when the channel we're viewing is the call's own
  // channel (the roster we hold is for that channel). null = show no cue.
  const callIds = voiceCallState.inCall && voiceCallState.channelId === state.activeChannelId
    ? callParticipantIds : null;
  users.sort((a, b) => {
    if (!!b.online !== !!a.online) return b.online ? 1 : -1;
    return a.display_name.localeCompare(b.display_name);
  });
  for (const u of users) {
    const isSelf = u.id === state.me.id;
    const presence = !u.online ? "offline" : u.status === "dnd" ? "do not disturb" : u.idle ? "idle" : u.status;
    // Show the user's custom status text when they've set one; otherwise fall
    // back to the presence word. The title always carries the presence state.
    const statusLine = u.status_text ? u.status_text : presence;
    const titleParts = [presence];
    if (!isSelf) titleParts.unshift(`Message ${u.display_name}`);
    // Mods get a remove (✕) control on everyone but themselves (self uses Leave).
    const remove = canRemove && !isSelf
      ? el("button", { class: "ch-ctl danger", title: `Remove ${u.display_name}`,
          onclick: (e) => { e.stopPropagation(); removeMember(activeCh.id, u.id, u.display_name); } }, "✕")
      : null;
    const onCall = !!(callIds && callIds.has(u.id));
    const callCue = onCall
      ? el("span", { class: "member-call", title: isSelf ? "You're on the call" : "On the call" }, "🔊")
      : null;
    const speaking = onCall && speakingIds.has(u.id);
    // Per-user volume slider: only for remote participants on our current call
    // (their <audio> element exists only then). Adjusts that one person's
    // playout level (voice.js setVolumeForUser), persisted across calls.
    const volume = onCall && !isSelf ? volumeSlider(u) : null;
    list.append(
      el("li", {
        "data-user-id": String(u.id),
        class: "member clickable" + (onCall ? " on-call" : "") + (speaking ? " speaking" : ""),
        title: titleParts.join(" · "),
        onclick: () => startDM(u.id),
      },
        el("span", { class: `dot ${presenceClass(u)}` }),
        el("div", { class: "member-text" },
          el("span", { class: "member-name" }, u.display_name),
          el("span", { class: "member-status", title: u.status_text || null }, statusLine),
          volume),
        callCue,
        remove
      )
    );
  }
}

// rerenderSidebar repaints all three sidebar lists at once. Use it for a full
// refresh (initial render, post-reload) where the whole roster is in flux.
// Targeted event handlers deliberately call only the lists they affect (e.g. a
// presence change touches members + DMs but not channels) — don't widen those
// to this; the surgical scoping is intentional.
function rerenderSidebar() {
  renderChannels();
  renderDMs();
  renderMembers();
}

// volumeSlider builds the per-user playout-volume control shown under an on-call
// remote member's name. Clicks are kept off the row (which would open a DM); the
// title tracks the live percentage. The value is applied + persisted by voice.js.
function volumeSlider(u) {
  const pct = (v) => `Volume — ${Math.round(v * 100)}%`;
  return el("input", {
    type: "range", min: "0", max: "1", step: "0.05",
    value: String(getVolumeForUser(u.id)),
    class: "member-volume",
    title: pct(getVolumeForUser(u.id)),
    "aria-label": `Volume for ${u.display_name}`,
    onclick: (e) => e.stopPropagation(),
    oninput: (e) => {
      const v = Number(e.target.value);
      setVolumeForUser(u.id, v);
      e.target.title = pct(v);
    },
  });
}

// removeMember (moderator+) removes another user from the active private channel.
// The server's member.remove broadcast updates everyone's roster; we also drop
// them locally so it's instant even for a mod viewing via the not-a-member bypass.
async function removeMember(channelId, userId, displayName) {
  if (!confirm(`Remove ${displayName} from this channel?`)) return;
  await guard(async () => {
    await api.removeChannelMember(channelId, userId);
    if (activeMemberIds) {
      activeMemberIds.delete(userId);
      renderMembers();
    }
  });
}

function renderAdminVisibility() {
  const isAdmin = S.isAdmin(state.me);
  const isMod = S.canModerate(state.me);
  $("#admin-btn").hidden = !isAdmin;
  $("#new-channel-btn").hidden = !isMod;
}

// --- channel reordering (moderator+) -----------------------------------------
// Channel drag-reorder is its own controller (channeldrag.js); it owns the live
// gesture and persists the dropped order (the order math lives in channelorder.js).
// renderChannels uses channelDrag.isActive() to skip a mid-drag repaint and
// channelDrag.wire(li, id) to arm each mod-visible row.
const channelDrag = createChannelDrag({
  $,
  getState: () => state,
  setChannels: (updated) => { state = S.setChannels(state, updated); },
  renderChannels,
  resync,
});

// --- channel & DM actions ----------------------------------------------------

async function deleteChannel(id) {
  const ch = state.channels[id];
  if (!ch) return;
  if (!confirm(`Delete #${ch.name}? It will be removed for everyone.`)) return;
  await guard(() => api.archiveChannel(id));
}

// toggleMute silences or un-silences a channel/DM for this user. Optimistic:
// flip locally and render now, reconcile with the server, revert on failure.
// Muting also drops any pending unread/mention badges for that channel.
async function toggleMute(id) {
  const wasMuted = S.isMuted(state, id);
  state = S.setMuted(state, id, !wasMuted);
  if (!wasMuted) {
    state = S.clearUnread(state, id);
    state = S.clearMention(state, id);
  }
  renderChannels();
  renderDMs();
  renderNotificationTotal();
  try {
    if (wasMuted) await api.unmuteChannel(id);
    else await api.muteChannel(id);
  } catch (ex) {
    state = S.setMuted(state, id, wasMuted); // revert
    renderChannels();
    renderDMs();
    renderNotificationTotal();
    alert(ex.message);
  }
}

// leaveActiveChannel removes the current user from the active private channel.
// The server also broadcasts a self-scoped channel.archive, but we drop it
// locally too so the UI updates instantly even if the socket is down.
async function leaveActiveChannel() {
  const ch = state.channels[state.activeChannelId];
  if (!ch || !ch.is_private || ch.is_dm) return;
  const isAdmin = S.isAdmin(state.me);
  if (!isAdmin && !confirm(`Leave #${ch.name}? You'll need an invite to rejoin.`)) return;
  try {
    await api.removeChannelMember(ch.id, state.me.id);
    if (isAdmin) {
      // Admins retain bypass access so the channel stays in their list, but they
      // are no longer a member — hide the leave button immediately and drop self
      // from the roster without waiting for the WS round-trip.
      $("#leave-btn").hidden = true;
      if (activeMemberIds) {
        activeMemberIds.delete(state.me.id);
        renderMembers();
      }
    } else {
      state = S.removeChannel(state, ch.id); // also re-points activeChannelId
      renderChannels();
      renderDMs();
      renderNotificationTotal();
      if (state.activeChannelId) await loadChannel(state.activeChannelId);
    }
  } catch (ex) {
    alert(ex.message);
  }
}

// closeDM hides a DM from the sidebar. The close is server-authoritative and
// per-user (DELETE /api/dms/{id}), so it sticks across this user's devices; the
// channel, its membership, and its history stay intact, and the other
// participant is unaffected. We drop it from local state so the row disappears
// immediately, and if it was the open channel fall back to a regular one so the
// reader isn't left staring at a closed DM.
async function closeDM(id) {
  try {
    await api.closeDM(id);
  } catch (ex) {
    alert(ex.message);
    return;
  }
  const wasActive = id === state.activeChannelId;
  state = S.removeChannel(state, id);
  if (wasActive) {
    const next = regularChannelOrder(state)[0] || state.channelOrder[0] || null;
    if (next != null) {
      selectChannel(next); // re-renders the DM list for us
      return;
    }
  }
  renderChannels();
  renderDMs();
}

// startDM create-or-finds the DM channel with a user and opens it. Doubles as the
// "resurrect a closed DM" path — opening reopens it server-side (createDM marks
// it open), so it reappears here and on the user's other devices.
async function startDM(userId) {
  await guard(async () => {
    const ch = await api.createDM(userId);
    state = S.upsertChannel(state, ch);
    await selectChannel(ch.id);
  });
}

// ensureDMOpen guarantees that a DM channel is present in state before navigation.
// If the user had closed the DM, it won't be in state.channels; re-opening it
// (createDM is idempotent and marks the row open server-side) makes selectChannel
// render correctly. fromUserId is the other party's user ID.
async function ensureDMOpen(channelId, fromUserId) {
  if (state.channels[channelId]) return;
  try {
    const ch = await api.createDM(fromUserId);
    state = S.upsertChannel(state, ch);
  } catch (e) {
    // Non-fatal: selectChannel will still navigate, just with a degraded header.
    console.warn("ensureDMOpen: could not re-open DM", e && e.message);
  }
}

// refreshActiveMembers re-scopes the members panel to the active channel:
// private channels (incl. DMs) show only their members; public channels show
// everyone (activeMemberIds = null).
async function refreshActiveMembers() {
  const ch = state.channels[state.activeChannelId];
  if (ch && ch.is_private) {
    try {
      const members = await api.channelMembers(ch.id);
      activeMemberIds = new Set(members.map((m) => m.id));
    } catch {
      activeMemberIds = null;
    }
  } else {
    activeMemberIds = null;
  }
  renderMembers();
  updateLeaveBtn();
}

// --- channel selection + read state ------------------------------------------

async function selectChannel(id) {
  // Picking a channel leaves the admin panel (the conversation reclaims the space).
  $("#admin-panel").hidden = true;
  // Save the composer draft for the channel we're leaving.
  const leaving = state.activeChannelId;
  if (leaving && leaving !== id) {
    drafts.saveText(leaving, $("#composer-input").value);
    composerTray?.stash(leaving);
  }
  // Leaving a channel abandons any inline edit or pending reply in progress.
  editingMessageId = null;
  editDraft = "";
  editFocusPending = false;
  replyingToId = null;
  renderReplyBanner();
  state = S.setActiveChannel(state, id);
  try {
    localStorage.setItem("rivendell.activeChannel", id);
  } catch (e) {
    /* non-fatal: persistence is best-effort */
  }
  // Snapshot whether there were unreads *before* clearing them, so we only
  // show the "New messages" marker when the user actually had unread messages.
  // Setting the cursor to 0 suppresses the marker entirely for channels the
  // user was already caught up on (prevents it from popping on new arrivals).
  const hadUnreads = !!(state.unread[id] || state.mentions[id] || unread.isManualUnread(id));
  state = S.clearUnread(state, id);
  state = S.clearMention(state, id);
  // Place the "New messages" divider and lift any earlier mark-unread suppression
  // (re-opening honors that mark by jumping to the divider, then marks read from here).
  unread.openChannel(id, hadUnreads, state.lastRead[id]);
  renderChannels();
  renderDMs();
  renderNotificationTotal();
  videoViewHidden = false;
  renderVideoGrid();
  closeDrawers(); // on mobile, reveal the conversation after a pick
  await loadChannel(id);
  imageWarm.startBackgroundImageWarm(); // reprioritizes from the new active channel outward
  // Restore any saved draft and attachments for this channel.
  const composerInput = $("#composer-input");
  composerInput.value = drafts.restoreText(id);
  composerTray?.unstash(id);
  // (No JS sizing: the contenteditable composer auto-grows between its CSS
  // min/max-height.)
  if (!window.matchMedia("(hover: none)").matches) {
    composerInput.focus();
    // Caret after the restored draft — the old textarea's .value setter left
    // it there; a freshly-focused contenteditable starts at offset 0.
    const len = composerInput.value.length;
    composerInput.setSelectionRange(len, len);
  }
  // Persist the read cursor server-side using the newest loaded message.
  markActiveChannelRead();
}

// markActiveChannelRead advances the server read cursor for the open channel to
// its newest loaded message and clears its local counts. The mark-read POST is
// deduped per (channel, newest id) so refocusing the tab doesn't spam the server.
async function markActiveChannelRead() {
  const cid = state.activeChannelId;
  if (!cid) return;
  // The user deliberately marked this channel unread; leave the cursor where
  // they put it. The flag is cleared when they leave and re-open the channel.
  if (unread.isManualUnread(cid)) return;
  const msgs = state.messages[cid] || [];
  if (!msgs.length) return;
  const newest = msgs[msgs.length - 1].id; // messages are kept sorted ascending
  if (state.unread[cid] || state.mentions[cid]) {
    state = S.clearUnread(state, cid);
    state = S.clearMention(state, cid);
    renderChannels();
    renderDMs();
    renderNotificationTotal();
  }
  if (unread.alreadyMarked(cid, newest)) return; // server already knows
  unread.recordMarked(cid, newest);
  state = S.setLastRead(state, cid, newest);
  renderMessages(); // update 👁 button labels now that cursor advanced
  try {
    await api.markRead(cid, newest);
  } catch (e) {
    unread.forgetMarked(cid); // let a later attempt retry
  }
}

// scrollToUnreadMarker scrolls the message list so the "New messages" divider
// is at the top of the visible area. Returns true if a marker was found and
// scrolled to, false if no marker exists (caller should fall back to bottom).
function scrollToUnreadMarker() {
  const wrap = $("#message-list");
  const marker = wrap.querySelector(".unread-marker");
  if (!marker) return false;
  wrap.scrollTop = marker.offsetTop - wrap.offsetTop - 8;
  return true;
}

// toggleMessageRead marks a message read or unread depending on its current
// state relative to the channel's live read cursor.
async function toggleMessageRead(m) {
  const cid = m.channel_id;
  const cursor = state.lastRead[cid] || 0;
  if (m.id > cursor) {
    // Unread → mark read: advance cursor to include this message.
    state = S.setLastRead(state, cid, m.id);
    unread.recordMarked(cid, m.id);
    unread.clearManualUnread(cid); // an explicit mark-read cancels mark-unread suppression
    if (cid === state.activeChannelId) {
      state = S.clearUnread(state, cid);
      state = S.clearMention(state, cid);
      renderChannels();
      renderDMs();
      renderNotificationTotal();
      // Advance the "New messages" divider to the new cursor. Dismiss it entirely
      // if the next unread message is already visible in the viewport.
      const loadedMsgs = state.messages[cid] || [];
      const nextUnread = loadedMsgs.find(x => x.id > m.id && !x.deleted_at);
      let dismissDivider = !nextUnread;
      if (!dismissDivider) {
        const listEl = $("#message-list");
        const nextEl = listEl && listEl.querySelector(`[data-msg-id="${nextUnread.id}"]`);
        if (nextEl) {
          const listRect = listEl.getBoundingClientRect();
          const msgRect = nextEl.getBoundingClientRect();
          dismissDivider = msgRect.top < listRect.bottom && msgRect.bottom > listRect.top;
        }
      }
      unread.setMarker(cid, dismissDivider ? 0 : m.id);
    }
    if (cid === state.activeChannelId) renderMessages();
    try {
      await api.markRead(cid, m.id);
    } catch (e) {
      unread.forgetMarked(cid);
    }
  } else {
    // Read → mark unread: move cursor before this message.
    const newCursor = m.id - 1;
    state = S.setLastRead(state, cid, newCursor);
    unread.forgetMarked(cid); // forget the dedupe so a later re-read re-POSTs
    // Suppress auto-mark-read until the user leaves and re-opens this channel,
    // and surface a sidebar badge for the now-unread messages (from others) so
    // the channel reads as unread and re-opening jumps to the "New messages"
    // marker. Counting from loaded messages matches the server's tally closely
    // enough; a reconnect re-syncs the exact figure.
    unread.setManualUnread(cid);
    const unreadCount = unreadCountAfter(state.messages[cid], newCursor, state.me && state.me.id);
    state = S.setUnread(state, cid, unreadCount);
    renderChannels();
    renderDMs();
    renderNotificationTotal();
    if (cid === state.activeChannelId) {
      unread.setMarker(cid, newCursor);
      renderMessages();
    }
    try {
      await api.markUnread(cid, m.id);
    } catch (e) {
      /* non-fatal: cursor will re-sync on next load */
    }
  }
}

// isModPlus reports whether the current user is a moderator or admin. Thin
// no-arg convenience over S.canModerate for the call sites (and emoji.js) that
// gate on the live `state.me`.
function isModPlus() {
  return S.canModerate(state.me);
}

// --- channel header ----------------------------------------------------------

// updateLeaveBtn syncs the leave-button visibility for the active channel.
// Admins retain read-only bypass access to private channels they haven't
// joined — the leave button must be hidden in that case.
function updateLeaveBtn() {
  const ch = state.channels[state.activeChannelId];
  const realPrivate = !!(ch && ch.is_private && !ch.is_dm);
  const adminNonMember = S.isAdmin(state.me) && !!(activeMemberIds && !activeMemberIds.has(state.me.id));
  $("#leave-btn").hidden = !realPrivate || adminNonMember;
}

// renderChannelHeader paints the active channel's title + topic into the header.
// For a real channel (not a DM) a moderator+ may click the topic to edit it inline;
// the span advertises that and shows a prompt to add one when the topic is empty.
function renderChannelHeader(ch) {
  const topicEl = $("#channel-topic");
  const dmDot = $("#channel-dm-dot");
  const dmCall = $("#channel-dm-call");
  const callBtn = $("#call-btn");
  const secretBtn = $("#secret-btn");
  if (ch && ch.is_dm) {
    $("#channel-title").textContent = "@ " + dmDisplayName(state, ch);
    topicEl.textContent = "";
    topicEl.classList.remove("editable", "placeholder");
    topicEl.removeAttribute("title");
    const otherId = S.otherDMParticipant(ch, state.me && state.me.id);
    const other = otherId && state.users[otherId];
    dmDot.className = `dot ${other ? presenceClass(other) : "offline"}`;
    dmDot.hidden = false;
    // On-call cue: the member roster (which carries the 🔊 cue elsewhere) is
    // hidden in DM view, so surface "the other person is connected to this call"
    // here in the header — the analog of the DM presence dot for call state.
    const otherOnCall = !!(voiceCallState.inCall && voiceCallState.channelId === ch.id
      && otherId && callParticipantIds.has(otherId));
    dmCall.hidden = !otherOnCall;
    // Clicking the 🔊 reveals a slider for the partner's playout volume. It only
    // makes sense while they're on the call (their <audio> element — the thing
    // .volume drives — exists only then), so bind/collapse it to that lifecycle.
    const dmVol = $("#dm-volume");
    if (otherOnCall) {
      if (dmVolumeChannelId !== ch.id) { dmVolumeChannelId = ch.id; dmVolumeOpen = false; }
      const v = getVolumeForUser(otherId);
      dmVol.value = String(v);
      dmVol.title = `Volume — ${Math.round(v * 100)}%`;
      dmVol.hidden = !dmVolumeOpen;
    } else {
      dmVolumeChannelId = null; dmVolumeOpen = false; dmVol.hidden = true;
    }
    // Self-DM scratch pad: calling yourself or starting a secret session with
    // yourself makes no sense — hide both buttons.
    const isSelfDM = otherId === (state.me && state.me.id);
    if (isSelfDM) {
      callBtn.hidden = true;
      secretBtn.hidden = true;
    } else {
      // Show/update the call button for DM channels.
      if (ringState && ringState.channelId === ch.id && ringState.direction === "incoming") {
        callBtn.textContent = "✅";
        callBtn.title = "Answer call";
      } else if (ringState && ringState.channelId === ch.id && ringState.direction === "outgoing") {
        callBtn.textContent = "📵";
        callBtn.title = "Cancel call";
      } else if (isInCall() && voiceCallState.channelId === ch.id) {
        callBtn.textContent = "📵";
        callBtn.title = "Leave call";
      } else {
        callBtn.textContent = "📞";
        callBtn.title = "Start voice call";
      }
      callBtn.hidden = false;
      // Secret chat button: visible on DMs if browser supports WebCrypto.
      const supported = secretBtn.dataset.supported !== "0";
      const sess = getSession(ch.id);
      secretBtn.className = "icon-btn" + ((sess && sess.phase === "active") ? " secret-btn-active" : "");
      if (sess && sess.phase === "active") {
        secretBtn.textContent = "🔒";
        secretBtn.title = sess.verified ? "Secret session — verified (click to view safety number)" : "Secret session — unverified (click to view safety number)";
        secretBtn.classList.add(sess.verified ? "secret-btn-verified" : "secret-btn-unverified");
      } else {
        secretBtn.textContent = "🔒";
        secretBtn.title = supported ? "Start secret chat" : "Secret chat needs a current browser (Ed25519/X25519 WebCrypto)";
      }
      secretBtn.hidden = !supported;
    }
    // Video/chat toggle: mobile-only (CSS hides on desktop). During a DM video
    // call, 💬 lets the user switch to chat; 📺 returns them to the video view.
    const headerCamBtn = $("#header-camera-btn");
    if (isInCall() && voiceCallState.channelId === ch.id) {
      const hcbOtherId = S.otherDMParticipant(ch, state.me && state.me.id);
      const hcbOtherP = voiceCallState.participants.find(p => p.user_id === hcbOtherId);
      const hasVideo = !voiceCallState.videoMuted || (hcbOtherP && !hcbOtherP.video_muted);
      if (hasVideo || videoViewHidden) {
        headerCamBtn.textContent = videoViewHidden ? "📺" : "💬";
        headerCamBtn.title = videoViewHidden ? "Show video" : "Show chat";
        headerCamBtn.hidden = false;
      } else {
        headerCamBtn.hidden = true;
      }
    } else {
      headerCamBtn.hidden = true;
    }
    return;
  }
  dmDot.hidden = true;
  dmCall.hidden = true;
  secretBtn.hidden = true;
  $("#header-camera-btn").hidden = true;
  $("#dm-volume").hidden = true;
  dmVolumeChannelId = null; dmVolumeOpen = false;
  if (ch && !ch.is_dm) {
    if (isInCall() && voiceCallState.channelId === ch.id) {
      callBtn.textContent = "🔴";
      callBtn.title = "Leave voice";
      // Same mobile-only 💬/📺 chat↔video toggle as DM calls, but for a group
      // video call: shown once any participant (us or a peer) has a camera on.
      const headerCamBtn = $("#header-camera-btn");
      const groupHasVideo = !voiceCallState.videoMuted ||
        voiceCallState.participants.some(p => p.user_id !== (state.me && state.me.id) && !p.video_muted);
      if (groupHasVideo || videoViewHidden) {
        headerCamBtn.textContent = videoViewHidden ? "📺" : "💬";
        headerCamBtn.title = videoViewHidden ? "Show video" : "Show chat";
        headerCamBtn.hidden = false;
      }
    } else {
      callBtn.textContent = "🔊";
      callBtn.title = "Join voice";
    }
    callBtn.hidden = false;
  } else {
    callBtn.hidden = true;
  }
  $("#channel-title").textContent = ch ? (ch.is_private ? "🔒 " : "# ") + ch.name : "";
  const canEdit = !!(ch && !ch.is_dm && isModPlus());
  topicEl.classList.toggle("editable", canEdit);
  if (canEdit) {
    topicEl.textContent = ch.topic || "Add a topic…";
    topicEl.classList.toggle("placeholder", !ch.topic);
    topicEl.title = "Click to edit the channel topic";
  } else {
    topicEl.textContent = ch ? ch.topic : "";
    topicEl.classList.remove("placeholder");
    topicEl.removeAttribute("title");
  }
}

// beginTopicEdit swaps the topic text for an input so a moderator+ can set the
// active channel's topic in place (no popup). Enter or blur saves; Escape cancels.
// The PATCH broadcasts channel.update, so everyone with access sees the new topic.
function beginTopicEdit() {
  const ch = state.channels[state.activeChannelId];
  if (!ch || ch.is_dm || !isModPlus()) return;
  const topicEl = $("#channel-topic");
  if (topicEl.querySelector("input")) return; // already editing
  const input = el("input", {
    class: "topic-edit", type: "text", maxlength: "256",
    placeholder: "Channel topic", value: ch.topic || "",
  });
  topicEl.textContent = "";
  topicEl.classList.remove("placeholder");
  topicEl.append(input);
  input.focus();
  input.select();
  let settled = false; // guards the Enter→save→blur double-fire
  const restore = () => {
    if (settled) return;
    settled = true;
    renderChannelHeader(state.channels[state.activeChannelId]);
  };
  const save = async () => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    if (next !== (ch.topic || "")) {
      try {
        const updated = await api.updateChannel(ch.id, { topic: next });
        state = S.upsertChannel(state, updated);
      } catch (ex) {
        alert(ex.message);
      }
    }
    renderChannelHeader(state.channels[state.activeChannelId]);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); restore(); }
  };
  input.onblur = save;
}

// --- message loading, history & scrolling ------------------------------------

async function loadChannel(id) {
  // Startup path calls loadChannel directly without selectChannel, so the divider
  // may not be set yet — seed it from the live cursor only when there are actual
  // unreads (same rule as selectChannel; idempotent).
  unread.seedMarker(id, state.unread[id] || state.mentions[id], state.lastRead[id]);
  const ch = state.channels[id];
  renderChannelHeader(ch);
  renderSecretBanner();
  // Invite + leave affordances only make sense for a real private channel
  // (not DMs/public). Inviting is moderator+ only.
  const realPrivate = !!(ch && ch.is_private && !ch.is_dm);
  $("#invite-btn").hidden = !realPrivate || !isModPlus();
  $("#leave-btn").hidden = !realPrivate;
  $("#pins-btn").hidden = !ch;
  // A DM is 1:1 — there's no roster worth showing, so collapse the members
  // column and hide its toggle (CSS keys off body.dm-active).
  document.body.classList.toggle("dm-active", !!(ch && ch.is_dm));
  // Reset scroll/history flags immediately so sentinels can't fire while in-flight.
  loadingOlder = false;
  loadingNewer = false;
  viewingHistory.delete(id);
  renderHistoryBanner();
  try {
    const [, msgs] = await Promise.all([refreshActiveMembers(), api.messages(id, { limit: PAGE })]);
    if (id !== state.activeChannelId) return; // user switched away while fetching
    state = S.setMessages(state, id, msgs);
    // A short first page means there's nothing older to scroll back to.
    if (msgs.length < PAGE) historyComplete.add(id);
    else historyComplete.delete(id);
    // Use holdPosition so scrollToBottom's rAF callbacks don't fire and
    // override the unread-marker scroll. We control the final position here.
    renderMessages(false, true);
    if (!scrollToUnreadMarker()) {
      // No unread marker (channel was caught up): pin to the newest message.
      const wrap = $("#message-list");
      wrap.scrollTop = wrap.scrollHeight;
    }
    renderTypingIndicator(); // reset indicator for the newly opened channel
  } catch (ex) {
    if (id !== state.activeChannelId) return;
    $("#message-list").innerHTML = "";
    $("#message-list").append(el("div", { class: "notice" }, ex.message));
  }
}

// loadOlderMessages fetches the previous page when the user scrolls near the top
// and splices it in, preserving the scroll position so the view doesn't jump.
async function loadOlderMessages() {
  const cid = state.activeChannelId;
  if (!cid || loadingOlder || historyComplete.has(cid)) return;
  const oldest = S.oldestMessageId(state, cid);
  if (oldest == null) return;
  loadingOlder = true;
  const wrap = $("#message-list");
  const prevHeight = wrap.scrollHeight;
  const prevTop = wrap.scrollTop;
  try {
    const older = await api.messages(cid, { before: oldest, limit: PAGE });
    if (older.length < PAGE) historyComplete.add(cid); // reached the beginning
    if (older.length && cid === state.activeChannelId) {
      state = S.prependMessages(state, cid, older);
      renderMessages();
      // Keep the message that was under the viewport in place: the prepended
      // content grew the list above us by exactly this delta.
      wrap.scrollTop = prevTop + (wrap.scrollHeight - prevHeight);
    } else if (older.length) {
      // User switched channels mid-fetch; merge quietly, no re-render.
      state = S.prependMessages(state, cid, older);
    }
  } catch (ex) {
    console.warn("rivendell: could not load older messages:", ex && ex.message);
  } finally {
    loadingOlder = false;
  }
}

// loadNewerMessages is the forward counterpart to loadOlderMessages: when the user
// scrolls near the bottom while viewing a history window (below the live tail), it
// fetches the next page forward and appends it. A short page means we've caught up
// to the newest message — drop the history flag so normal live-follow resumes.
async function loadNewerMessages() {
  const cid = state.activeChannelId;
  if (!cid || loadingNewer || !viewingHistory.has(cid)) return;
  const newest = S.newestMessageId(state, cid);
  if (newest == null) return;
  loadingNewer = true;
  try {
    const newer = await api.messages(cid, { after: newest, limit: PAGE });
    if (newer.length < PAGE) viewingHistory.delete(cid); // caught up to the live tail
    if (newer.length && cid === state.activeChannelId) {
      // Hold position: the new messages land below the viewport, so the reader
      // stays put and scrolls down into them (rather than being snapped to the
      // new bottom, which on mobile left no room to trigger the next page).
      state = S.appendMessages(state, cid, newer);
      renderMessages(false, true);
    }
    if (cid === state.activeChannelId) renderHistoryBanner();
  } catch (ex) {
    console.warn("rivendell: could not load newer messages:", ex && ex.message);
  } finally {
    loadingNewer = false;
  }
}

function renderHistoryBanner() {
  const banner = $("#history-banner");
  if (!banner) return;
  banner.hidden = !viewingHistory.has(state.activeChannelId);
}

async function jumpToMessage(channelId, messageId) {
  // If the channel isn't in local state (e.g. a closed DM), fetch it and, for
  // DMs, reopen it server-side so it appears in the sidebar.
  if (!state.channels[channelId]) {
    let ch;
    try { ch = await api.getChannel(channelId); } catch (_) {
      flashNotice("That message is in a channel you can't access.");
      return;
    }
    if (ch.is_dm) {
      const [a, b] = S.dmParticipants(ch);
      const otherId = a === state.me.id ? b : a;
      try { ch = await api.createDM(otherId); } catch (_) { /* fall through with fetched ch */ }
    }
    state = S.upsertChannel(state, ch);
  }
  // Switch channel header/state if needed without triggering a full loadChannel.
  if (state.activeChannelId !== channelId) {
    state = S.setActiveChannel(state, channelId);
    try { localStorage.setItem("rivendell.activeChannel", channelId); } catch (e) { /* non-fatal */ }
    state = S.clearUnread(state, channelId);
    state = S.clearMention(state, channelId);
    renderChannels();
    renderDMs();
    renderNotificationTotal();
    closeDrawers();
    const ch = state.channels[channelId];
    renderChannelHeader(ch);
    const realPrivate = !!(ch && ch.is_private && !ch.is_dm);
    $("#invite-btn").hidden = !realPrivate || !isModPlus();
    $("#leave-btn").hidden = !realPrivate;
    $("#pins-btn").hidden = !ch;
    document.body.classList.toggle("dm-active", !!(ch && ch.is_dm));
    await refreshActiveMembers();
  }
  try {
    const msgs = await api.messages(channelId, { around: messageId });
    if (channelId !== state.activeChannelId) return; // user switched away while fetching
    state = S.setMessages(state, channelId, msgs);
    historyComplete.delete(channelId);
    // Assume history until a forward probe proves otherwise. The around-window
    // only loads a partial page after the anchor, so the live tail — and, in a
    // brief conversation, the last few messages — may be missing.
    viewingHistory.add(channelId);
    flashMessageId = messageId; // highlight is applied in renderMessages so it survives re-renders
    // Hold position so the rebuild doesn't snap to the bottom; we center below.
    renderMessages(false, true);
    // Return the URL bar to clean SPA state — we've arrived, so the permalink hash
    // (whether from a shared link on load or an in-app click) is now just junk.
    // Sharing still works via the timestamp anchors' href (permalinkHash).
    history.replaceState(null, "", "/");
    const target = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (target) {
      target.scrollIntoView({ block: "center" }); // instant: a smooth scroll races the fill below
    } else {
      // The around-window fetch returns the anchor even if it's deleted, but one
      // that arrived already-deleted renders as nothing (no data-msg-id), so
      // distinguish "deleted" from "truly gone".
      const anchor = (state.messages[channelId] || []).find((m) => m.id === messageId);
      flashNotice(anchor && anchor.deleted_at
        ? "That message was deleted."
        : "Message not found — it may have been deleted.");
    }
    // Probe forward once. loadNewerMessages holds the scroll position, so the
    // anchor stays put while any missing newer messages fill in below. A short
    // page means we've reached the live tail (it clears the history flag, hiding
    // the banner); a full page confirms a real gap, and the bottom sentinel pages
    // the rest as the reader scrolls down.
    await loadNewerMessages();
    renderHistoryBanner();
    setTimeout(() => {
      flashMessageId = null;
      const n = $("#message-list").querySelector(".msg-anchor");
      if (n) n.classList.remove("msg-anchor");
    }, 2500);
  } catch (ex) {
    console.warn("rivendell: jumpToMessage failed:", ex && ex.message);
    flashNotice("Message not found — it may have been deleted.");
  }
}

// flashNotice drops a transient .notice line into the message list (same idiom as
// loadChannel's error path) and removes it after a few seconds, so a failed jump
// gives feedback without permanently wedging into the conversation.
function flashNotice(text) {
  const wrap = $("#message-list");
  if (!wrap) return;
  const n = el("div", { class: "notice" }, text);
  wrap.append(n);
  n.scrollIntoView({ block: "nearest" });
  setTimeout(() => n.remove(), 4000);
}

// Infinite scroll is driven by two zero-height sentinels that renderMessages
// places at the very top and bottom of the list. When a sentinel nears the
// viewport the matching page loads. We use an IntersectionObserver rather than
// scrollTop math because the latter fired unreliably on mobile (momentum
// scrolling and the dynamic viewport) and could strand the reader at the end so
// the next forward page never loaded. rootMargin "100%" prefetches ~a screen
// early in both directions, so reading in either direction stays seamless.
let scrollObserver = null;
function observeScrollSentinels(topSentinel, bottomSentinel) {
  if (!scrollObserver) {
    scrollObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (e.target.dataset.sentinel === "top") loadOlderMessages();
        else loadNewerMessages();
      }
    }, { root: $("#message-list"), rootMargin: "100% 0px" });
  }
  // Sentinels are fresh nodes each render (innerHTML is cleared), so rebind.
  scrollObserver.disconnect();
  scrollObserver.observe(topSentinel);
  scrollObserver.observe(bottomSentinel);
}

// scrollToBottom pins the message list to the newest message. It re-pins across
// the next couple of frames because layout can keep settling after the first
// assignment — text wrapping, and on mobile the visual viewport / URL bar — which
// would otherwise leave the view a few pixels short of the bottom.
function scrollToBottom(wrap) {
  wrap.scrollTop = wrap.scrollHeight;
  requestAnimationFrame(() => {
    wrap.scrollTop = wrap.scrollHeight;
    requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
  });
  // Images load asynchronously and expand the container after the rAF pass.
  // Re-pin when each one finishes, but only if the reader hasn't manually
  // scrolled away since we pinned.
  // We capture the target scrollTop now (= scrollHeight − clientHeight, the max
  // possible value). After the pin, wrap.scrollTop == targetTop. When the image
  // loads, wrap.scrollHeight grows but scrollTop stays put — so checking
  // "scrollTop is still near targetTop" reliably tells us whether the user
  // scrolled away (vs. checking distance-from-new-bottom, which would be the
  // image height and could easily exceed any fixed pixel threshold).
  const targetTop = wrap.scrollHeight - wrap.clientHeight;
  wrap.querySelectorAll("img").forEach(media => {
    if (media.complete) return;
    media.addEventListener("load", () => {
      if (!wrap.contains(media)) return; // image is from a prior channel render
      if (wrap.scrollTop >= targetTop - 5)
        wrap.scrollTop = wrap.scrollHeight;
    }, { once: true });
  });
}

// --- message rendering -------------------------------------------------------

function renderTypingIndicator() {
  const el = $("#typing-indicator");
  if (!el) return;
  const typers = state.typing[state.activeChannelId] || {};
  const names = Object.keys(typers)
    .filter((uid) => Number(uid) !== state.me?.id)
    .map((uid) => { const u = state.users[uid]; return u ? (u.display_name || u.username) : null; })
    .filter(Boolean);
  if (!names.length) {
    el.textContent = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (names.length === 1) {
    el.textContent = `${names[0]} is typing…`;
  } else if (names.length === 2) {
    el.textContent = `${names[0]} and ${names[1]} are typing…`;
  } else {
    el.textContent = `${names[0]}, ${names[1]}, and ${names.length - 2} more are typing…`;
  }
}

function renderMessages(forceBottom = false, holdPosition = false) {
  const wrap = $("#message-list");
  // forceBottom (channel open) always lands at the newest message; otherwise we
  // only follow the conversation if the reader is already near the bottom.
  // holdPosition wins over both: when paging forward through history (or jumping)
  // we must NOT snap to the bottom — that would strand the reader past the content
  // they just loaded. The caller restores/sets the scroll position itself.
  const atBottom = !holdPosition && (forceBottom || wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80);
  const prevTop = wrap.scrollTop; // clearing innerHTML resets scrollTop; restore it below
  // Capture an in-progress inline edit before innerHTML wipes the textarea, so a
  // re-render triggered by an incoming event keeps the draft, caret, and focus.
  let editRestore = null;
  if (editingMessageId != null) {
    const live = wrap.querySelector(".msg-edit-input");
    if (live) {
      editDraft = live.value;
      editRestore = { focused: document.activeElement === live, start: live.selectionStart, end: live.selectionEnd };
    }
  }
  wrap.innerHTML = "";
  const activeCh = state.channels[state.activeChannelId];
  const secretSess = activeCh && activeCh.is_dm ? getSession(state.activeChannelId) : null;
  // Secret session mode: render the in-memory encrypted message list instead
  // of the server-backed history. The notice at top makes the context clear.
  // Hide the image attach button in an active or ended secret session.
  const attachBtn = $("#attach-btn");
  const inSecretView = !!(secretSess && (secretSess.phase === "active" || secretSess.phase === "ended"));
  if (attachBtn) attachBtn.hidden = inSecretView;
  // Reset the composer if we're not in a secret view (e.g. switching channels).
  if (!inSecretView) {
    const inp = $("#composer-input");
    if (inp && inp.disabled) { inp.disabled = false; inp.placeholder = "Message…"; }
  }

  if (inSecretView) {
    if (secretSess.phase === "active") {
      wrap.append(el("div", {
        class: "secret-header" + (secretSess.verified ? " verified" : ""),
        title: "View safety number",
        onclick: () => openSafetyModal(state.activeChannelId, secretSess),
      },
        secretSess.verified
          ? "🔒 End-to-end encrypted · verified — messages are not saved"
          : "🔒 End-to-end encrypted — messages are not saved · safety number unverified"));
    }
    for (const m of secretSess.messages) {
      const u = state.users[m.fromUserId];
      const avatar = u && u.has_avatar
        ? el("div", { class: "msg-avatar", style: `background-image:url(${avatarSrc(m.fromUserId)})` })
        : el("div", { class: "msg-avatar" }, initials(u ? u.display_name : "?"));
      const body = el("div", { class: "msg-body" });
      body.innerHTML = formatMessage(m.text, state.me.username, state.emojis, { embedImages: true, channels: state.channels, users: state.users });
      wrap.append(
        el("div", { class: "msg secret" },
          avatar,
          el("div", { class: "msg-main" },
            el("div", { class: "msg-head" },
              el("span", { class: "msg-author" }, u ? (u.display_name || u.username) : "?"),
              el("span", { class: "msg-time" }, new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))),
            body)));
    }
    if (secretSess.phase === "ended") {
      const activeCh = state.channels[state.activeChannelId];
      const otherId = activeCh && S.otherDMParticipant(activeCh, state.me && state.me.id);
      const peer = otherId && state.users[otherId];
      const peerName = peer ? (peer.display_name || peer.username) : "The other person";
      wrap.append(el("div", { class: "secret-ended-notice" },
        el("span", {}, "🔒 " + peerName + " has left this session — messages were not saved"),
        el("button", {
          class: "link small",
          onclick: () => {
            clearEndedSession(state.activeChannelId);
            renderMessages(true);
            renderChannelHeader(state.channels[state.activeChannelId]);
            const inp = $("#composer-input");
            if (inp) { inp.disabled = false; inp.placeholder = "Message…"; }
          },
        }, "Return to chat")));
    }
    const inp = $("#composer-input");
    if (inp) {
      inp.disabled = secretSess.phase === "ended";
      inp.placeholder = secretSess.phase === "ended" ? "Session ended" : "Message…";
    }
    if (atBottom) wrap.scrollTop = wrap.scrollHeight;
    else wrap.scrollTop = prevTop;
    return;
  }
  const msgs = state.messages[state.activeChannelId] || [];
  const isMod = S.canModerate(state.me);
  // In a DM, either participant may pin (mirrors the server rule); elsewhere
  // pinning is moderator+.
  const canPin = isMod || !!(activeCh && activeCh.is_dm);
  // Marker: the cursor position captured when this channel was opened. Any
  // message with id > markerAt is "new since you last visited."
  const markerAt = unread.markerFor(state.activeChannelId);
  let markerInserted = false;
  let lastUser = null;
  let lastTime = 0;
  let i = 0;
  while (i < msgs.length) {
    // Walk a run of consecutive deleted messages. Only those deleted live this
    // session (in liveDeleted) get a collapsed "N deleted" tombstone; ones that
    // arrived already-deleted from history render as nothing — so reopening a
    // channel isn't cluttered with old tombstones.
    if (msgs[i].deleted_at) {
      let j = i;
      let live = 0;
      while (j < msgs.length && msgs[j].deleted_at) {
        if (liveDeleted.has(msgs[j].id)) live++;
        j++;
      }
      if (live > 0) {
        wrap.append(
          el("div", { class: "msg deleted-run" },
            el("div", { class: "msg-gutter" }),
            el("div", { class: "msg-main" },
              el("div", { class: "msg-body deleted" }, live === 1 ? "message deleted" : `${live} messages deleted`)))
        );
        lastUser = null;
        lastTime = 0;
      }
      // A run with no live deletions is invisible and doesn't break grouping.
      i = j;
      continue;
    }

    const m = msgs[i];

    if (m.is_system) {
      wrap.append(el("div", { class: "msg msg-system", "data-msg-id": m.id },
        el("span", { class: "msg-system-text" }, m.content),
        el("span", { class: "msg-system-time" }, formatTime(m.created_at))));
      lastUser = null;
      lastTime = 0;
      i++;
      continue;
    }

    // Insert the "New messages" divider before the first message that is newer
    // than the read cursor captured when this channel was opened.
    if (!markerInserted && markerAt > 0 && m.id > markerAt) {
      markerInserted = true;
      wrap.append(el("div", { class: "unread-marker" },
        el("span", { class: "unread-marker-label" }, "New messages")));
    }

    const author = state.users[m.user_id];
    const t = new Date(m.created_at).getTime();
    // A reply always starts a fresh (non-grouped) block so its quote sits cleanly
    // under the author header it belongs to, rather than being tucked under a
    // same-author run above it.
    const grouped = m.user_id === lastUser && t - lastTime < 5 * 60 * 1000 && !m.reply_to_id;
    lastUser = m.user_id;
    lastTime = t;

    const editing = m.id === editingMessageId;
    const replyQuote = editing ? null : buildReplyQuote(m);
    const preview = editing ? null : buildLinkPreview(m.content);
    const hideUrl = preview
      ? (extractHideURL(m.content, location.origin) || preview._previewUrl || null)
      : null;
    const body = editing
      ? editorFor(m)
      : el("div", { class: "msg-body", html: formatMessage(m.content, state.me.username, state.emojis, { hideUrl, channels: state.channels, users: state.users }) + (m.edited_at ? ' <span class="edited">(edited)</span>' : "") });
    const mentionsMe = m.user_id !== state.me.id &&
      (mentionsUser(m.content, state.me.username) || m.reply_to_user_id === state.me.id);

    const isOwn = m.user_id === state.me.id;
    const canDelete = isOwn || isMod; // non-mods can only delete their own
    // Anyone who can see a message can react to it, so "react" is always present;
    // edit/pin/delete stay conditional.
    const isRead = m.id <= (state.lastRead[state.activeChannelId] || 0);
    const actions = el("div", { class: "msg-actions" },
      el("button", { class: "msg-act", title: "Add reaction",
        onclick: (e) => { e.stopPropagation(); emojiPicker.openForReaction(m.id, e.currentTarget); } }, "😄"),
      el("button", { class: "msg-act", title: "Reply", onclick: () => startReply(m) }, "↩"),
      !m.deleted_at ? el("button", { class: "msg-act", title: "Forward to another channel", onclick: () => openForwardModal(m) }, "↗") : null,
      el("button", { class: "msg-act", title: isRead ? "Mark unread" : "Mark read", onclick: () => toggleMessageRead(m) }, "👁"),
      isOwn ? el("button", { class: "msg-act", title: "Edit", onclick: () => startEdit(m) }, "✏") : null,
      canPin ? el("button", { class: "msg-act", title: m.pinned_at ? "Unpin" : "Pin", onclick: () => togglePin(m) }, "📌") : null,
      canDelete ? el("button", { class: "msg-act danger", title: "Delete", onclick: () => deleteMessage(m) }, "🗑") : null);
    const reactions = editing ? null : reactionsRow(m);
    const rowActions = editing ? null : actions;
    const pinMark = m.pinned_at ? el("span", { class: "pin-mark", title: "Pinned" }, "📌") : null;
    let cls = "msg";
    if (m.pinned_at) cls += " pinned";
    if (mentionsMe) cls += " mentioned";
    if (m.id === flashMessageId) cls += " msg-anchor"; // jumped-to highlight, applied each render

    const permalink = el("a", {
      class: "msg-time",
      href: permalinkHash(state.activeChannelId, m.id),
      title: "Permalink",
      onclick: (e) => { e.preventDefault(); jumpToMessage(state.activeChannelId, m.id); },
    }, formatTime(m.created_at));

    if (grouped) {
      wrap.append(el("div", { class: cls + " grouped", "data-msg-id": m.id }, el("div", { class: "msg-gutter" }, pinMark), el("div", { class: "msg-main" }, replyQuote, body, preview, reactions, rowActions)));
    } else {
      // Clicking the avatar or name opens the author's profile card.
      const openCard = author ? () => openUserCard(author.id) : null;
      const avatarAttrs = author
        ? { class: "msg-avatar clickable", title: "View profile", onclick: openCard }
        : { class: "msg-avatar" };
      const avatar = author && author.has_avatar
        ? el("div", { ...avatarAttrs, style: `background-image:url(${avatarSrc(author.id)})` })
        : el("div", avatarAttrs, initials(author ? author.display_name : "?"));
      wrap.append(
        el("div", { class: cls, "data-msg-id": m.id },
          avatar,
          el("div", { class: "msg-main" },
            el("div", { class: "msg-head" },
              el("span", author
                ? { class: "msg-author clickable", title: "View profile", onclick: openCard }
                : { class: "msg-author" }, author ? author.display_name : "unknown"),
              permalink,
              pinMark
            ),
            replyQuote,
            body,
            preview,
            reactions,
            rowActions
          )
        )
      );
    }
    i++;
  }
  // Zero-height sentinels at each end drive infinite scroll via IntersectionObserver
  // (see observeScrollSentinels). They're re-created every render, so rebind each time.
  const topSentinel = el("div", { class: "scroll-sentinel", "data-sentinel": "top" });
  const bottomSentinel = el("div", { class: "scroll-sentinel", "data-sentinel": "bottom" });
  wrap.prepend(topSentinel);
  wrap.append(bottomSentinel);
  observeScrollSentinels(topSentinel, bottomSentinel);
  // Follow the conversation when already at the bottom; otherwise hold the
  // reader's position (loadOlderMessages adjusts further for prepended history).
  if (atBottom) scrollToBottom(wrap);
  else wrap.scrollTop = prevTop;
  // Re-establish the inline editor's size and (if it was focused, or just opened)
  // its focus + caret after the rebuild. If the edited message is gone (e.g. a mod
  // deleted it mid-edit), drop the pending-focus flag.
  if (editingMessageId != null) {
    const ta = wrap.querySelector(".msg-edit-input");
    if (ta) {
      autoGrowEdit(ta);
      if (editFocusPending) {
        ta.focus();
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
      } else if (editRestore && editRestore.focused) {
        ta.focus();
        ta.setSelectionRange(editRestore.start, editRestore.end);
      }
    }
    editFocusPending = false;
  }
}

// --- replies -----------------------------------------------------------------

// buildReplyQuote renders the small "↪ Author: snippet" reference shown above a
// reply. The parent is looked up in the loaded window; if it isn't loaded (it may
// predate the current page) we still render a clickable stub — jumpToMessage fetches
// the surrounding window on click. A soft-deleted parent shows a tombstone. The
// snippet is plain text (text node), so it carries no XSS risk.
function buildReplyQuote(m) {
  if (!m.reply_to_id) return null;
  const msgs = state.messages[state.activeChannelId] || [];
  const parent = msgs.find((p) => p.id === m.reply_to_id);
  let label;
  if (parent && parent.deleted_at) {
    label = el("span", { class: "reply-quote-text deleted" }, "original message deleted");
  } else if (parent) {
    const author = state.users[parent.user_id];
    label = el("span", { class: "reply-quote-text" },
      el("span", { class: "reply-quote-author" }, author ? author.display_name : "unknown"),
      " ",
      replySnippet(parent.content) || "(no text)");
  } else {
    label = el("span", { class: "reply-quote-text" }, "show original message");
  }
  return el("div", {
    class: "reply-quote",
    title: "Jump to the replied-to message",
    onclick: () => jumpToMessage(state.activeChannelId, m.reply_to_id),
  }, el("span", { class: "reply-quote-arrow" }, "↪"), label);
}

// renderReplyBanner paints (or hides) the "Replying to …" bar above the composer
// from replyingToId. It's a single paint point: every state change calls it.
function renderReplyBanner() {
  const bar = $("#composer-reply");
  if (!bar) return;
  if (replyingToId == null) { bar.hidden = true; bar.innerHTML = ""; return; }
  const msgs = state.messages[state.activeChannelId] || [];
  const parent = msgs.find((m) => m.id === replyingToId);
  const author = parent ? state.users[parent.user_id] : null;
  bar.innerHTML = "";
  bar.append(
    el("span", { class: "composer-reply-label" },
      "Replying to ",
      el("span", { class: "composer-reply-who" }, author ? author.display_name : "a message")),
    parent ? el("span", { class: "composer-reply-snippet" }, replySnippet(parent.content)) : null,
    el("button", {
      class: "composer-reply-cancel", type: "button",
      title: "Cancel reply (Esc)", "aria-label": "Cancel reply",
      onclick: cancelReply,
    }, "✕")
  );
  bar.hidden = false;
}

function startReply(m) {
  if (!m || m.deleted_at) return; // can't reply to a deleted message
  replyingToId = m.id;
  renderReplyBanner();
  const input = $("#composer-input");
  if (input) input.focus();
}

function cancelReply() {
  replyingToId = null;
  renderReplyBanner();
}

// --- inline autocomplete binding (widget in autocomplete.js) -----------------

// mkAutocomplete builds an @-mention / :emoji / #channel completion widget bound
// to the live app state, for a field + its popup <ul>. The composer and every
// inline edit box each create one. The host's keydown must defer to the returned
// handleKeydown first (see autocomplete.js).
const mkAutocomplete = (input, popup) =>
  createAutocomplete({
    input, popup, el,
    getState: () => state,
    getActiveMemberIds: () => activeMemberIds,
    emojiURL: (code) => api.emojiURL(code),
  });

// --- contenteditable composer wiring (facade in composer-field.js) -----------

// The composer is a contenteditable="plaintext-only" <div>, not a <textarea>:
// GeckoView (Firefox for Android) never delivers image clipboard content to a
// textarea through any mechanism — no DOM event, no long-press paste for
// image-only clips, and Gboard refuses outright because the field's input
// connection doesn't advertise image MIME types. A plaintext-only editable
// region receives image pastes (see the three channels in wireComposer).
//
// Everything else in this file — drafts, the shared autocomplete, emoji
// insertion, the URL-wrap paste, the Enter/ArrowUp handlers — was written
// against textarea semantics (.value / .selectionStart / .setSelectionRange).
// upgradeComposerField (composer-field.js) grafts those exact properties onto
// the div so none of those callers change. The content model is deliberately
// flat: text nodes plus <br> (counted as "\n"); the composer's input handler
// strips anything richer, so the facade's offset math stays exact.
function wireComposer() {
  const input = $("#composer-input");
  upgradeComposerField(input); // before anything reads .value / .selectionStart
  const popup = $("#mention-popup");
  // @-mention / :emoji inline completion, shared with the inline edit boxes.
  // The composer's keydown defers to ac.handleKeydown before its own send logic.
  const ac = mkAutocomplete(input, popup);
  const TYPING_INTERVAL_MS = 1500;
  let lastTypingSent = 0;

  // True while the open channel is an active OTR secret session. Images are
  // never sent in one, so every paste channel suppresses them silently.
  const secretActive = () => {
    const ch = state.channels[state.activeChannelId];
    const sess = ch && ch.is_dm ? getSession(state.activeChannelId) : null;
    return !!(sess && sess.phase === "active");
  };

  input.addEventListener("input", () => {
    // Channel 3 of the image-paste harvest (channels 1 and 2 are the paste and
    // beforeinput handlers below): the browser natively inserted the pasted
    // image as an <img> node while every event carried empty data. Capture the
    // src, strip the node, and decode data: URIs into Files ourselves.
    //
    // Channel 3 depends on Gecko inserting rich content into a
    // plaintext-only field, which is a spec violation observed on
    // FF Android 151 (2026-06-11). If Mozilla fixes it, traffic should
    // shift to channel 2 (beforeinput files) or this flavor regresses
    // upstream; either way this handler degrades to a no-op. Do not
    // "simplify" by removing channels 1 or 2.
    for (const node of input.querySelectorAll("img")) {
      const src = node.getAttribute("src") || "";
      const scheme = (src.split(":")[0] || "").toLowerCase();
      if (scheme !== "data" && scheme !== "blob") node.src = ""; // cancel any pending browser load
      node.remove(); // remove first; harvest proceeds from the captured src
      if (secretActive()) continue; // images never enter a secret session
      if (scheme === "data") {
        try { composerTray.uploadAndInsert(dataUriToFile(src)); }
        catch (err) { console.warn("composer: undecodable pasted data: image", err); }
      } else if (scheme === "blob") {
        composerTray.canvasRecover(src);
      }
      // Any other scheme: stripped above, never fetched.
    }
    // Legacy fallback only (plaintext-only unsupported → full contenteditable):
    // flatten any other element a rich paste smuggled in to its text.
    for (const n of [...input.children]) {
      if (n.nodeName !== "BR") n.replaceWith(document.createTextNode(n.textContent));
    }
    // Emptying a plaintext-only field can strand a lone <br>, which defeats
    // :empty (and with it the placeholder); normalize it away.
    if (input.innerHTML === "<br>" || input.textContent === "\n") input.innerHTML = "";

    if (state.activeChannelId && input.value.trim()) {
      const now = Date.now();
      if (now - lastTypingSent >= TYPING_INTERVAL_MS) {
        lastTypingSent = now;
        socket && socket.send({ type: "typing", channel_id: state.activeChannelId });
      }
    }
  });

  // The attachment-upload tray (attachments.js): staged image tiles above the
  // composer, uploaded in the background, their markdown appended on send. It
  // owns the pending-uploads list + per-channel stash/unstash; the input events
  // below (paste/drop/attach + channel-3 harvest) feed it via uploadAndInsert.
  composerTray = createAttachmentTray({
    tray: $("#composer-attachments"),
    el,
    uploadBlob: (file) => api.uploadBlob(file),
    rejectOversized: (file) => fileTooLarge(file, maxImageBytes, "image"),
    drafts,
  });

  // Channel 1: image files on the paste event's clipboardData — the desktop
  // path. preventDefault cancels the native insertion, so channels 2 and 3
  // structurally cannot double-stage the same paste. Plain-text pastes fall
  // through to the URL-wrap logic below.
  input.addEventListener("paste", async (e) => {
    const items = Array.from((e.clipboardData || window.clipboardData)?.items || []);
    const imageItems = items.filter((i) => i.kind === "file" && i.type.startsWith("image/"));
    if (imageItems.length) {
      e.preventDefault();
      // Images can't be sent in a secret session — suppress silently.
      if (secretActive()) return;
      for (const it of imageItems) {
        const file = it.getAsFile();
        if (file) composerTray.uploadAndInsert(file);
      }
      return;
    }
    // Paste a single URL onto a non-empty selection → wrap it as a [text](url)
    // markdown link. Only fires when the clipboard is exactly one URL and there's a
    // selection; otherwise the default paste runs untouched.
    const url = ((e.clipboardData || window.clipboardData)?.getData("text") || "").trim();
    if (!/^https?:\/\/\S+$/.test(url)) return;
    const start = input.selectionStart, end = input.selectionEnd;
    if (start === end) return; // no selection — let the URL paste as plain text
    e.preventDefault();
    const md = `[${input.value.slice(start, end)}](${url})`;
    input.value = input.value.slice(0, start) + md + input.value.slice(end);
    const caret = start + md.length;
    input.setSelectionRange(caret, caret);
  });

  // Channel 2: Firefox on Android delivers some clipboard flavors (e.g.
  // screenshot-copy PNGs) not on the paste event but on beforeinput, as
  // e.dataTransfer.files. preventDefault cancels the native insertion, so
  // channel 3 never sees this paste.
  input.addEventListener("beforeinput", (e) => {
    if (e.inputType !== "insertFromPaste") return;
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    e.preventDefault();
    if (secretActive()) return; // suppress, matching channel 1
    files.forEach((f) => composerTray.uploadAndInsert(f));
  });

  input.onkeydown = async (e) => {
    // Locked composer (ended secret session): contentEditable=false already
    // makes the div unfocusable, so this shouldn't fire — but a stale focus
    // or synthetic event mustn't send into a locked field.
    if (input.disabled) return;
    if (ac.handleKeydown(e)) return;
    // Esc on the composer cancels a pending reply (when no autocomplete is open).
    if (e.key === "Escape" && replyingToId != null && popup.hidden) {
      e.preventDefault();
      cancelReply();
      return;
    }
    // Up arrow on an empty composer → edit the most recent own message. Ctrl/Meta
    // is the channel-navigation shortcut (handled globally), not an edit trigger.
    if (e.key === "ArrowUp" && !e.ctrlKey && !e.metaKey && !input.value && !editingMessageId) {
      const msgs = state.messages[state.activeChannelId] || [];
      const own = msgs.filter((m) => m.user_id === state.me.id && !m.deleted_at);
      if (own.length) { e.preventDefault(); startEdit(own[own.length - 1]); }
    }
    // !isComposing: Enter during IME composition (Gboard, CJK input) commits
    // the composition, it must not send — contenteditable surfaces this where
    // the old textarea path happened to mask it.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (composerTray.hasUploading()) return; // an image is still uploading — don't send a half-baked message
      const text = input.value;
      // Secret session: send encrypted via WS; no attachments, replies, or API call.
      const activeCh = state.channels[state.activeChannelId];
      const secretSess = activeCh && activeCh.is_dm ? getSession(state.activeChannelId) : null;
      if (secretSess && secretSess.phase === "active") {
        if (!text.trim()) return;
        input.value = "";
        lastTypingSent = 0;
        try {
          await sendSecretMessage(state.activeChannelId, text.trim());
          renderMessages(false);
        } catch (ex) {
          input.value = text;
          alert("Secret message failed: " + ex.message);
        }
        return;
      }
      // Message body = the typed text followed by each done attachment's image
      // markdown (spoiler-marked ones wrapped in ||..||), one per line; either
      // part alone is enough to send.
      const content = composeMessageBody(text, composerTray.doneUploads());
      if (!content.trim()) return;
      input.value = ""; // the div collapses back to a single line on its own
      lastTypingSent = 0; // allow next keystroke to fire a fresh typing frame immediately
      const sent = composerTray.takeAll();
      const replyId = replyingToId; // capture, then clear the banner optimistically
      replyingToId = null;
      renderReplyBanner();
      try {
        await api.sendMessage(state.activeChannelId, content, replyId);
        sent.forEach((u) => u.objectUrl && URL.revokeObjectURL(u.objectUrl));
      } catch (ex) {
        input.value = text;
        composerTray.putBack(sent); // put the attachments back so the send can be retried
        replyingToId = replyId; // restore the reply context too
        renderReplyBanner();
        alert(ex.message);
      }
    }
  };

  // Attach button: click triggers the hidden file input.
  const attachInput = $("#attach-input");
  const attachBtn = $("#attach-btn");
  if (attachBtn && attachInput) {
    attachBtn.addEventListener("click", () => attachInput.click());
    attachInput.addEventListener("change", () => {
      for (const file of attachInput.files) composerTray.uploadAndInsert(file);
      attachInput.value = ""; // reset so the same file(s) can be re-selected
    });
  }

  // Drag-and-drop: accept image files dropped onto the composer area.
  const composerEl = input.closest(".composer");
  if (composerEl) {
    composerEl.addEventListener("dragover", (e) => {
      if ([...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) {
        e.preventDefault();
      }
    });
    composerEl.addEventListener("drop", (e) => {
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        if (secretActive()) return; // images never enter a secret session
        // A non-editable div still receives drop events (unlike a disabled
        // textarea, which the browser inerts) — honor the lockout here too.
        if (input.disabled) return;
        for (const file of files) composerTray.uploadAndInsert(file);
      }
    });
  }
}

// --- emoji picker ------------------------------------------------------------

// The emoji popup is its own controller (emoji.js): it owns the active target
// and the floating-popup placement math. We pass it the element builder, a
// state getter, and the hooks it routes picks through; call sites use its
// toggle / openForReaction / openForInput / isOpen / rerender methods.
const emojiPicker = createEmojiPicker({
  el,
  $,
  getState: () => state,
  isModPlus,
  toggleReaction,
  // Lazy: this factory runs at module-eval, before adminPanel is initialized.
  openEmojiManager: () => adminPanel.openEmojiManager(),
});

// --- inline message editing --------------------------------------------------

// autoGrowEdit sizes the inline-edit textarea to its content (capped by CSS).
function autoGrowEdit(ta) {
  // Save and restore the message-list scroll position: setting height="auto"
  // shrinks the textarea momentarily, causing the browser to auto-scroll the
  // focused element into view and jump the message list unexpectedly.
  const list = ta.closest(".message-list");
  const savedTop = list ? list.scrollTop : null;
  ta.style.height = "auto";
  // Add the vertical border back: scrollHeight is content+padding only, and the
  // box is border-box, so height = scrollHeight would under-size by the border
  // and the cursor would scroll into the slack.
  ta.style.height = ta.scrollHeight + (ta.offsetHeight - ta.clientHeight) + "px";
  if (list && savedTop !== null) list.scrollTop = savedTop;
}

// editorFor builds the inline editor that replaces a message's body while editing.
// Enter saves, Shift+Enter inserts a newline, Escape cancels — mirroring the
// composer. Typing updates editDraft so the text survives re-renders.
function editorFor(m) {
  const ta = el("textarea", { class: "msg-edit-input", rows: "1", "aria-label": "Edit message" });
  ta.value = editDraft;
  // Own popup element (anchored to this edit box, not the composer) so @-mention
  // and :emoji completion work while editing. keydown defers to the popup first.
  const popup = el("ul", { class: "mention-popup", hidden: true });
  const ac = mkAutocomplete(ta, popup);
  ta.addEventListener("input", () => { editDraft = ta.value; autoGrowEdit(ta); });
  ta.addEventListener("keydown", (e) => {
    if (ac.handleKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(m); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
  });
  // stopPropagation keeps the document-level click handler from re-closing the
  // picker on the same event that opens it (mirrors the composer's 😀 button).
  const emojiBtn = el("button", {
    type: "button", class: "msg-edit-emoji", title: "Insert emoji", "aria-label": "Insert emoji",
    onclick: (e) => { e.stopPropagation(); emojiPicker.openForInput(ta, emojiBtn); },
  }, "😀");
  return el("div", { class: "msg-edit" },
    popup,
    ta,
    el("div", { class: "msg-edit-controls" },
      emojiBtn,
      el("button", { class: "link", onclick: () => commitEdit(m) }, "save"),
      el("button", { class: "link", onclick: cancelEdit }, "cancel"),
      el("span", { class: "msg-edit-hint" }, "Enter to save · Esc to cancel")));
}

// startEdit opens the inline editor on a message (own, non-deleted). renderMessages
// then draws the editor in place and focuses it (editFocusPending).
function startEdit(m) {
  if (m.deleted_at) return;
  editingMessageId = m.id;
  editDraft = m.content;
  editFocusPending = true;
  renderMessages();
}

// cancelEdit discards the inline edit and repaints the message normally.
function cancelEdit() {
  editingMessageId = null;
  editDraft = "";
  editFocusPending = false;
  renderMessages();
  if (!window.matchMedia("(hover: none)").matches) {
    const input = $("#composer-input");
    if (input) input.focus();
  }
}

// --- link previews -----------------------------------------------------------

// Inline link/embed previews (message-permalink embeds, YouTube thumbs, og:
// cards). See linkpreview.js for the contract; it owns its two fetch caches and
// the render-coalescing debounce, and reaches back only through rerender. el is
// passed by value (defined above); jumpToMessage/renderMessages are wrapped in
// arrows so their late definitions resolve at call time.
const linkPreviews = createLinkPreviews({
  el,
  getState: () => state,
  api,
  jumpToMessage: (channelId, messageId) => jumpToMessage(channelId, messageId),
  rerender: () => renderMessages(),
});
const buildLinkPreview = linkPreviews.buildLinkPreview;

// commitEdit saves the inline edit. An empty draft on the most recent own message
// deletes it; empty on any other message just cancels. Unchanged draft cancels.
// On failure the editor stays open so the draft isn't lost; on success the
// message.update broadcast re-renders with the new content.
async function commitEdit(m) {
  const next = editDraft.trim();
  if (!next) {
    const msgs = state.messages[state.activeChannelId] || [];
    const own = msgs.filter((msg) => msg.user_id === state.me.id && !msg.deleted_at);
    if (own.length && own[own.length - 1].id === m.id) {
      cancelEdit();
      await guard(() => api.deleteMessage(m.id));
    } else {
      cancelEdit();
    }
    return;
  }
  if (next === m.content.trim()) { cancelEdit(); return; }
  try {
    await api.editMessage(m.id, next);
    editingMessageId = null;
    editDraft = "";
    renderMessages();
  } catch (ex) {
    alert(ex.message);
    editFocusPending = true; // keep the editor and restore focus for a retry
    renderMessages();
  }
}

async function deleteMessage(m) {
  if (!confirm("Delete this message?")) return;
  await guard(() => api.deleteMessage(m.id));
}

// togglePin pins/unpins a message (mod+). The resulting message.update broadcast
// refreshes the message list and any open pins panel.
async function togglePin(m) {
  await guard(() => (m.pinned_at ? api.unpinMessage(m.id) : api.pinMessage(m.id)));
}

// --- reactions ---------------------------------------------------------------

// findMessage locates a loaded message in the active channel by id.
function findMessage(messageId) {
  const arr = state.messages[state.activeChannelId] || [];
  return arr.find((m) => m.id === messageId) || null;
}

// SHORTCODE_RE matches the custom-emoji shortcode namespace: [a-z0-9_]{2,32}.
// Used to distinguish orphaned shortcodes (in reactions but no longer in the
// registry) from literal Unicode graphemes, which don't match this pattern.
const SHORTCODE_RE = /^[a-z0-9_]{2,32}$/;

// Reverse of BUILTIN_EMOJI (glyph → shortcode name), so a Unicode reaction can
// surface its `:shortcode:` in the hover tooltip alongside the names.
const BUILTIN_GLYPH_TO_NAME = Object.fromEntries(
  Object.entries(BUILTIN_EMOJI).map(([name, glyph]) => [glyph, name]),
);

// reactionsRow renders the pill row under a message, or null if it has none. Each
// pill shows the emoji (custom shortcode → image, else the literal Unicode glyph)
// and its count, is highlighted when I'm among the reactors, and toggles on click.
// When the backing custom emoji has been deleted the pill shows a 🪦 tombstone:
// mine reactors may still click to remove (the server now allows it); non-mine
// pills are disabled since adding a deleted emoji would be rejected anyway.
function reactionsRow(m) {
  if (!m.reactions || !m.reactions.length) return null;
  const row = el("div", { class: "reactions" });
  for (const g of m.reactions) {
    const ids = g.user_ids || [];
    const mine = ids.includes(state.me.id);
    const names = ids.map((id) => (state.users[id] ? state.users[id].display_name : "someone")).join(", ");
    // An orphaned reaction: value looks like a shortcode but is no longer in the
    // emoji registry (the custom emoji was deleted after the reaction was placed).
    const isCustom = !!state.emojis[g.emoji];
    const isOrphan = !isCustom && SHORTCODE_RE.test(g.emoji);
    const glyph = isCustom
      ? el("img", { class: "emoji", src: api.emojiURL(g.emoji), alt: `:${g.emoji}:` })
      : isOrphan
        ? el("span", { class: "r-emoji" }, "🪦")
        : el("span", { class: "r-emoji" }, g.emoji);
    // Tooltip leads with the emoji's identity — its `:shortcode:` where one
    // exists (custom/orphan store the bare code; builtin glyphs reverse-map to
    // theirs), prefixed by the glyph for Unicode reactions — then the reactors.
    const code = isCustom || isOrphan
      ? `:${g.emoji}:`
      : BUILTIN_GLYPH_TO_NAME[g.emoji]
        ? `:${BUILTIN_GLYPH_TO_NAME[g.emoji]}:`
        : null;
    const ident = isCustom || isOrphan ? code : code ? `${g.emoji} ${code}` : g.emoji;
    const titleText = isOrphan
      ? `${ident} — ${names} (emoji deleted${mine ? " — click to remove" : ""})`
      : `${ident} — ${names}`;
    row.append(el("button", {
      class: "reaction" + (mine ? " mine" : "") + (isOrphan ? " orphan" : ""),
      title: titleText,
      disabled: isOrphan && !mine,
      // Pass the rendered "mine" so the toggle is correct even when the message
      // isn't in the active window (the pins modal renders pins it fetched itself).
      onclick: isOrphan && !mine ? null : () => toggleReaction(m.id, g.emoji, mine),
    }, glyph, el("span", { class: "r-count" }, String(ids.length))));
  }
  return row;
}

// toggleReaction adds my reaction, or removes it if I've already reacted with that
// emoji. The reaction.update broadcast re-renders everyone (including me). knownMine
// is the caller's already-computed "did I react" (the pill knows it); when omitted
// (the picker path) we look it up in the active window, defaulting to add.
async function toggleReaction(messageId, emoji, knownMine) {
  let mine = knownMine;
  if (mine === undefined) {
    const m = findMessage(messageId);
    const grp = m && m.reactions && m.reactions.find((g) => g.emoji === emoji);
    mine = !!(grp && (grp.user_ids || []).includes(state.me.id));
  }
  await guard(() => (mine ? api.removeReaction(messageId, emoji) : api.addReaction(messageId, emoji)));
}

// --- feature-module wiring ---------------------------------------------------
//
// Each of these features lives in its own module behind a createX(deps) surface;
// app.js instantiates it here and re-exports the handful of methods the call sites
// and wire* functions use. Full contracts live in each module's header comment.

// Forward modal + pure cores (forwardBody/forwardTargets/makeCanSee) — forward.js,
// e2e/forward.spec, web/test/forward.test.
const forward = createForward({
  el,
  $,
  getState: () => state,
  api,
  jumpToMessage: (channelId, messageId) => jumpToMessage(channelId, messageId),
});
const openForwardModal = forward.openForwardModal;

// Mobile long-press action sheet — mobilectx.js, e2e/mobile-ctx.spec. The gesture
// detection + backdrop wiring stay in app.js (wireMobileContextMenu).
const mobileCtx = createMobileCtx({
  el,
  $,
  getState: () => state,
  api,
  emojiPicker,
  startReply,
  openForwardModal,
  startEdit,
  togglePin,
  toggleMessageRead,
  deleteMessage,
});
const openMobileCtx = mobileCtx.openMobileCtx;
const closeMobileCtx = mobileCtx.closeMobileCtx;

// Pinned-messages panel — pins.js, e2e/pins.spec. reactionsRow is injected because
// reactions stay in app.js (the `mine` invariant); togglePin stays with rendering.
const pins = createPins({
  el,
  $,
  getState: () => state,
  api,
  jumpToMessage: (channelId, messageId) => jumpToMessage(channelId, messageId),
  closeDrawers,
  reactionsRow,
});
const openPinsModal = pins.openPinsModal;
const refreshPinsIfOpen = pins.refreshPinsIfOpen;

// Message-search modal — search.js, e2e/search.spec. Owns its racy state
// (generation token, query, keyset cursor, debounce); wireSearchControls binds it.
const search = createSearch({
  el,
  $,
  getState: () => state,
  jumpToMessage,
  closeDrawers,
});

// --- control wiring: one-time event bindings, grouped by concern -------------

// openLightbox shows an inline image large, centred on a dark backdrop, instead
// of opening it in a new tab. Dismissed by the × button, Esc, or a backdrop tap
// (wired in wireModalDismissal alongside the other .modal handlers).
function openLightbox(src) {
  if (!src) return;
  $("#lightbox-img").src = src;
  $("#lightbox").hidden = false;
}

// closeModal hides a modal and, if it's the profile modal, reverts any live
// theme preview to the persisted value (so backdrop/Esc dismissals don't keep an
// unsaved theme on screen). Shared by the backdrop, the × affordance, and Escape.
function closeModal(m) {
  m.hidden = true;
  if (m.id === "profile-modal") applyTheme(myTheme());
  // Drop the lightbox source so a large image stops loading / frees memory and
  // the next open never flashes the previous picture.
  if (m.id === "lightbox") $("#lightbox-img").src = "";
}

// wireDelegatedClicks installs the single document-level click handler that routes
// in-app navigation off rendered content: spoiler reveal, #channel links, inline
// image lightbox, and same-origin message permalinks (SPA jump, no reload).
// Modified clicks (new-tab/window intent) and cross-origin links fall through to
// the browser unchanged.
function wireDelegatedClicks() {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // Spoiler reveal: clicking an unrevealed spoiler reveals it; eats the click so
    // links inside the spoiler don't fire before the user has seen the content.
    const spoiler = e.target.closest && e.target.closest(".spoiler");
    if (spoiler && !spoiler.classList.contains("revealed")) {
      e.preventDefault();
      spoiler.classList.add("revealed");
      return;
    }
    // Channel links (#channelname) navigate to the channel in-app.
    const chLink = e.target.closest && e.target.closest("a.channel-link");
    if (chLink) {
      e.preventDefault();
      const id = parseInt(chLink.dataset.channelId, 10);
      if (id && state.channels[id]) selectChannel(id);
      return;
    }
    // Inline images open in a large in-app lightbox rather than a new tab. The
    // image is wrapped in an a.msg-image-link; intercept that anchor (unmodified
    // left clicks only — the modifier checks above already let new-tab intent
    // through) and show the lightbox instead of navigating.
    const imgLink = e.target.closest && e.target.closest("a.msg-image-link");
    if (imgLink) {
      e.preventDefault();
      openLightbox(imgLink.getAttribute("href"));
      return;
    }
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    let u;
    try { u = new URL(a.href, location.href); } catch (_) { return; }
    if (u.origin !== location.origin) return;
    const permalink = parsePermalink(u.hash);
    if (!permalink) return;
    e.preventDefault();
    jumpToMessage(permalink.channelId, permalink.messageId);
  });
}

// wireProfileControls wires the user's own identity surface: the status picker, the
// profile modal (opened from the name/status text), live theme preview, the
// desktop-notification opt-in, the profile save, and the avatar uploader.
function wireProfileControls() {
  $("#status-select").onchange = (e) => guard(() => api.setStatus(e.target.value));

  $("#me-name").onclick = openProfileModal;
  $("#me-status-text").onclick = openProfileModal;
  // Live-preview the theme as the user browses the list; persisted on Save,
  // reverted (to myTheme) if the modal is dismissed without saving.
  $("#profile-theme").onchange = (e) => applyTheme(e.target.value);

  // Desktop-notification opt-in. Turning it on requests the OS permission;
  // turning it off just drops the in-app preference (the OS grant is sticky and
  // only the browser can revoke it).
  const notifCb = $("#notif-enable");
  if (notifCb) {
    notifCb.onchange = async () => {
      if (notifCb.checked) {
        const perm = await requestNotificationPermission();
        notifEnabled = perm === "granted";
        // Also register for offline (Web Push) delivery. Best-effort: a failure
        // here still leaves foreground notifications working.
        if (notifEnabled) enablePush();
      } else {
        notifEnabled = false;
        disablePush();
      }
      prefs.saveNotif(notifEnabled);
      renderNotifControl();
    };
  }
  $("#profile-form").onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#profile-error");
    err.textContent = "";
    const display_name = $("#profile-display").value.trim();
    const status_text = $("#profile-status-text").value.trim();
    const pronouns = $("#profile-pronouns").value.trim();
    const bio = $("#profile-bio").value.trim();
    const theme = $("#profile-theme").value;
    try {
      const me = await api.updateMe({ display_name, status_text, pronouns, bio, theme });
      state = S.upsertUser(state, me);
      state = S.setMe(state, me);
      renderMe(); // also re-applies the (now persisted) theme
      $("#profile-modal").hidden = true;
    } catch (ex) {
      // A save error keeps the modal open; revert any live preview to persisted.
      applyTheme(myTheme());
      err.textContent = ex.message;
    }
  };

  // Clicking your own avatar (lower-left) is the avatar uploader — no separate button.
  $("#me-avatar").onclick = () => $("#avatar-input").click();
  $("#me-avatar").onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#avatar-input").click(); }
  };
  $("#avatar-input").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = ""; // allow re-picking the same file after a rejection
    if (!file) return;
    if (fileTooLarge(file, maxAvatarBytes, "avatar")) return;
    try {
      await api.uploadAvatar(file);
      const me = await api.me();
      avatarVersion[me.id] = Date.now(); // bust the cache so the new avatar shows now
      state = S.upsertUser(state, me);
      state = S.setMe(state, me);
      renderMe();
      renderMessages(); // my own messages in view should pick up the new avatar
    } catch (ex) {
      alert(ex.message);
    }
  };
}

// wireChannelControls wires channel-lifecycle affordances: the create-channel
// modal + form, invite, leave, the pins button, and the moderator+ inline topic
// editor.
function wireChannelControls() {
  $("#new-channel-btn").onclick = openChannelModal;
  $("#channel-close").onclick = () => ($("#channel-modal").hidden = true);
  $("#channel-create-form").onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#channel-create-error");
    err.textContent = "";
    const name = $("#channel-new-name").value.trim().toLowerCase();
    const topic = $("#channel-new-topic").value.trim();
    const isPrivate = $("#channel-new-private").checked;
    if (!name) return;
    try {
      await api.createChannel(name, topic, isPrivate);
      $("#channel-modal").hidden = true;
    } catch (ex) {
      err.textContent = ex.message;
    }
  };

  $("#invite-btn").onclick = openInviteModal;
  $("#invite-close").onclick = () => ($("#invite-modal").hidden = true);

  $("#leave-btn").onclick = leaveActiveChannel;

  $("#pins-btn").onclick = openPinsModal;

  // Moderator+ click the channel topic to edit it inline (guarded inside).
  $("#channel-topic").onclick = beginTopicEdit;
}

// wireEmojiControls wires the composer emoji picker (toggle + outside-dismiss) and
// the moderator+ custom-emoji manager modal shared with the admin panel.
function wireEmojiControls() {
  $("#emoji-btn").onclick = (e) => { e.stopPropagation(); emojiPicker.toggle(); };
  // Dismiss the emoji picker on any click outside it (the button toggles itself).
  document.addEventListener("click", (e) => {
    if (emojiPicker.isOpen() && !e.target.closest("#emoji-wrap") && !e.target.closest("#emoji-btn")) {
      $("#emoji-wrap").hidden = true;
    }
  });

  // Custom-emoji manager (moderator+): one shared modal reached from the picker's
  // ➕ and the admin panel's "Manage custom emojis" button.
  $("#admin-emoji-manage").onclick = openEmojiManager;
  $("#emoji-manager-close").onclick = () => ($("#emoji-manager-modal").hidden = true);
  $("#emoji-manager-form").onsubmit = async (e) => {
    e.preventDefault();
    const out = $("#emoji-manager-out");
    out.textContent = "";
    const shortcode = $("#emoji-manager-shortcode").value.trim().toLowerCase();
    const file = $("#emoji-manager-file").files[0];
    if (!file) {
      out.textContent = "Choose an image.";
      return;
    }
    if (maxAvatarBytes && file.size > maxAvatarBytes) {
      out.textContent = `That image is ${humanBytes(file.size)}, which is over the ${humanBytes(maxAvatarBytes)} limit.`;
      return;
    }
    try {
      await api.uploadEmoji(shortcode, file);
      $("#emoji-manager-shortcode").value = "";
      $("#emoji-manager-file").value = "";
      await refreshEmojiManager();
    } catch (ex) {
      out.textContent = ex.message;
    }
  };
}

// wireSearchControls wires the message-search modal: open/close, debounced typing,
// submit-to-search-now, and the "load more" pager.
function wireSearchControls() {
  $("#search-btn").onclick = () => search.open();
  $("#search-close").onclick = () => ($("#search-modal").hidden = true);
  // Debounce typing so each keystroke doesn't fire a query; Enter searches now.
  $("#search-input").addEventListener("input", () => search.onInput());
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    search.runNow();
  });
  $("#search-more").onclick = () => search.more();
}

// wireMobileContextMenu wires the mobile long-press message menu: the backdrop tap
// that closes the sheet, and long-press detection on the message list (with
// drift-cancel and follow-on-click suppression).
function wireMobileContextMenu() {
  // Mobile context sheet: backdrop tap (the ::before pseudo-element catches it)
  // closes the sheet. Clicks that reach the sheet itself (not the inner card) also
  // close it. Sheet clicks are stopped inside by the button handlers.
  document.getElementById("mobile-ctx").addEventListener("click", (e) => {
    if (e.target === document.getElementById("mobile-ctx") ||
        e.target === document.getElementById("mobile-ctx-sheet")) {
      closeMobileCtx();
    }
  });

  // Long-press detection on the message list for mobile. touchmove cancels if the
  // finger drifts (scroll intent); touchend suppresses the follow-on click when a
  // long-press was actually delivered. contextmenu fires on a long tap in some
  // browsers — suppress it so the OS menu doesn't compete with ours.
  let lpTimer = null, lpStartX = 0, lpStartY = 0, lpFired = false;
  const ml = $("#message-list");

  ml.addEventListener("touchstart", (e) => {
    // Skip the inline edit box: a long-press there is the user reaching for the
    // native text-selection handles, not the message context menu.
    if (e.target.closest && e.target.closest(".msg-edit")) return;
    const row = e.target.closest && e.target.closest("[data-msg-id]");
    if (!row) return;
    lpFired = false;
    lpStartX = e.touches[0].clientX;
    lpStartY = e.touches[0].clientY;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      lpFired = true;
      lpTimer = null;
      const msgId = parseInt(row.dataset.msgId, 10);
      const m = findMessage(msgId);
      if (m) openMobileCtx(m);
    }, 450);
  }, { passive: true });

  ml.addEventListener("touchmove", (e) => {
    if (!lpTimer) return;
    const dx = e.touches[0].clientX - lpStartX;
    const dy = e.touches[0].clientY - lpStartY;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  }, { passive: true });

  ml.addEventListener("touchend", (e) => {
    clearTimeout(lpTimer);
    lpTimer = null;
    if (lpFired) { e.preventDefault(); lpFired = false; }
  }, { passive: false });

  ml.addEventListener("contextmenu", (e) => {
    // Leave the edit box's native menu alone (copy/paste/select while editing).
    if (e.target.closest(".msg-edit")) return;
    if (e.target.closest("[data-msg-id]")) e.preventDefault();
  });
}

// wireModalDismissal wires the pointer affordances that close modals: a backdrop
// click on any .modal, and the lightbox × (which sits over the image, out of the
// backdrop's reach). Escape-to-close lives in wireGlobalKeys; both share closeModal.
function wireModalDismissal() {
  for (const m of document.querySelectorAll(".modal"))
    m.addEventListener("click", e => { if (e.target === m) closeModal(m); });

  // The × is the explicit close affordance (backdrop/Esc also dismiss). It sits
  // over the image, so a direct click never reaches the backdrop handler.
  $("#lightbox-close").onclick = () => closeModal($("#lightbox"));
}

// wireGlobalKeys wires document-level keyboard shortcuts: Escape unwinds the
// top-most open modal (then the admin panel, then an inline edit), and
// Ctrl+Up/Down navigate the sidebar (Ctrl+Shift to jump between unread).
function wireGlobalKeys() {
  // Desktop: Escape closes the top-most open modal (mobile dismisses by tapping the
  // backdrop). Closing just the last-opened one lets a stacked flow unwind a step.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = [...document.querySelectorAll(".modal")].filter((m) => !m.hidden);
    if (open.length) { closeModal(open[open.length - 1]); return; }
    // The admin panel is a full-screen surface (not a .modal); Esc closes it too.
    const admin = $("#admin-panel");
    if (!admin.hidden) { admin.hidden = true; return; }
    // Cancel an inline edit when Esc fires outside the edit textarea (the
    // textarea's own handler covers the focused case via stopPropagation).
    if (editingMessageId != null) cancelEdit();
  });

  // Channel navigation: Ctrl+Up/Down step through the sidebar conversation list;
  // Ctrl+Shift+Up/Down jump to the nearest unread above/below. Works regardless of
  // focus (the composer's plain-ArrowUp edit shortcut bows out when Ctrl is held).
  // Skipped while a modal is open so the keys don't move a channel behind it.
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if ([...document.querySelectorAll(".modal")].some((m) => !m.hidden)) return;
    e.preventDefault();
    const delta = e.key === "ArrowUp" ? -1 : 1;
    if (e.shiftKey) navigateUnread(delta);
    else navigateChannels(delta);
  });
}

// wireDrawerToggles wires the mobile slide-in drawers (channels/DMs sidebar and the
// members panel) and their shared tap-to-close backdrop. No-ops visually on
// desktop, where both panels are permanent.
function wireDrawerToggles() {
  $("#sidebar-toggle").onclick = () => toggleDrawer("sidebar");
  $("#members-toggle").onclick = () => toggleDrawer("members");
  $("#drawer-backdrop").onclick = closeDrawers;
}

// wireGlobalButtons wires the remaining top-level chrome buttons that don't belong
// to a feature group: jump-to-latest, logout, the admin panel open/close, the
// About dialog, the update banner, and the forward-modal close.
function wireGlobalButtons() {
  $("#history-latest-btn").onclick = () => {
    const cid = state.activeChannelId;
    if (cid) selectChannel(cid);
  };

  $("#logout-btn").onclick = async () => {
    try {
      await api.logout();
    } finally {
      location.reload();
    }
  };

  $("#admin-btn").onclick = openAdmin;
  $("#admin-close").onclick = () => { $("#admin-panel").hidden = true; };

  $("#about-btn").onclick = () => {
    closeDrawers(); // on mobile, get the sidebar drawer out from behind the modal
    $("#about-modal").hidden = false;
  };

  // Update banner: reload to pick up the newer server build, or dismiss for now.
  $("#update-reload").onclick = () => location.reload();
  $("#update-dismiss").onclick = () => ($("#update-banner").hidden = true);

  $("#forward-close").onclick = () => ($("#forward-modal").hidden = true);
}

// wireControls installs all the one-time control/event bindings, grouped by concern
// into the wire* helpers above. Called once at startup, before startRealtime() (see
// CLAUDE.md), so every affordance is live before events start flowing.
function wireControls() {
  wireDelegatedClicks();
  wireProfileControls();
  wireChannelControls();
  wireEmojiControls();
  wireSearchControls();
  wireMobileContextMenu();
  wireModalDismissal();
  wireGlobalKeys();
  wireDrawerToggles();
  wireGlobalButtons();
}

// --- app shell: drawers, swipe, idle -----------------------------------------

// Drawer helpers. Only one drawer is open at a time; the backdrop shows whenever
// either is open. No-ops visually on desktop, where both panels are permanent
// grid columns and the toggles are hidden.
function openDrawer(which) {
  document.body.classList.toggle("sidebar-open", which === "sidebar");
  document.body.classList.toggle("members-open", which === "members");
  $("#drawer-backdrop").hidden = false;
}

function closeDrawers() {
  document.body.classList.remove("sidebar-open", "members-open");
  $("#drawer-backdrop").hidden = true;
}

function toggleDrawer(which) {
  if (document.body.classList.contains(which + "-open")) closeDrawers();
  else openDrawer(which);
}

// wireSwipe adds touch-swipe navigation on mobile: swipe right opens the sidebar
// drawer, swipe left opens the members panel. Uses passive listeners so the
// message-list's native scroll is never blocked. The tricky bit is disambiguating
// a horizontal swipe from a vertical scroll: we decide intent on the first
// significant movement (>= 6px) by comparing |dx| vs |dy|, then gate the final
// action on a minimum travel distance and a "not too diagonal" check.
function wireSwipe() {
  const appEl = $(".app");
  let startX = 0, startY = 0;
  let decided = false; // true once we've committed to track or ignore this gesture
  let tracking = false; // true when we've classified this gesture as a horizontal swipe

  appEl.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { decided = false; tracking = false; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    decided = false;
    tracking = false;
    // Don't hijack horizontal scrolls that start inside an overflowing code block.
    const codeBlock = e.target.closest("pre.code-block");
    if (codeBlock && codeBlock.scrollWidth > codeBlock.clientWidth) {
      decided = true; // classified: not a drawer swipe
    }
  }, { passive: true });

  appEl.addEventListener("touchmove", (e) => {
    if (decided || e.touches.length !== 1) return;
    const dx = Math.abs(e.touches[0].clientX - startX);
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dx < 6 && dy < 6) return; // too little movement to classify yet
    decided = true;
    tracking = dx >= dy; // horizontal-dominant = treat as a swipe candidate
  }, { passive: true });

  appEl.addEventListener("touchend", (e) => {
    if (!tracking || e.changedTouches.length !== 1) { decided = false; tracking = false; return; }
    decided = false;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 40) return; // too short to be intentional
    if (Math.abs(dy) > Math.abs(dx) * 0.6) return; // too diagonal (> ~31° off horizontal)
    if (dx > 0) {
      // Swipe right: reveal the sidebar, or dismiss the members panel if it's open.
      if (document.body.classList.contains("members-open")) closeDrawers();
      else openDrawer("sidebar");
    } else {
      // Swipe left: reveal the members panel, or dismiss the sidebar if it's open.
      // Skip the members drawer in DM view (1:1 channel, no roster shown).
      if (document.body.classList.contains("sidebar-open")) closeDrawers();
      else if (!document.body.classList.contains("dm-active")) openDrawer("members");
    }
  }, { passive: true });
}

// wireIdleDetection tracks user activity and signals the server when this
// session goes idle. Idle is purely ephemeral and per-connection: it rides the
// WebSocket (like typing) so the server scopes it to this one session — a user
// shows idle only when every session of theirs is idle. The hub forgets idle on
// disconnect, so the client re-signals after a reconnect (via the isIdle module
// var read in resync). Activity events reset the 10-minute timer; a hidden tab
// accelerates to 1 minute (the tab likely isn't being watched).
function wireIdleDetection() {
  const IDLE_MS = 10 * 60 * 1000;
  const HIDDEN_MS = 60 * 1000;
  let idleTimer = null;

  function goIdle() {
    if (isIdle) return;
    isIdle = true;
    socket && socket.send({ type: "idle", idle: true });
  }

  function onActivity() {
    clearTimeout(idleTimer);
    if (isIdle) {
      isIdle = false;
      socket && socket.send({ type: "idle", idle: false });
    }
    idleTimer = setTimeout(goIdle, IDLE_MS);
  }

  for (const ev of ["mousemove", "keydown", "pointerdown", "touchstart", "wheel", "click"]) {
    window.addEventListener(ev, onActivity, { passive: true, capture: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(goIdle, HIDDEN_MS);
    } else {
      onActivity();
    }
  });

  idleTimer = setTimeout(goIdle, IDLE_MS);
}

// --- invite, channel & profile modals, user card -----------------------------

// The modal cluster (new-channel, edit-profile, invite, read-only user card)
// lives in modals.js; e2e/modals.spec nets it. The two app-state couplings are
// injected: onProfileOpen refreshes the profile modal's notif/PTT sub-controls,
// and onActiveMembersChanged writes activeMemberIds + re-renders the members
// panel as people are invited. The create-channel and save-profile form handlers
// stay in app.js's wire* functions.
const modals = createModals({
  el,
  $,
  getState: () => state,
  api,
  closeDrawers,
  avatarSrc,
  initials,
  startDM,
  onProfileOpen: () => { renderNotifControl(); pttCapturing = false; renderPttControl(); },
  onActiveMembersChanged: (memberIds) => { activeMemberIds = memberIds; renderMembers(); },
});
const openInviteModal = modals.openInviteModal;
const openChannelModal = modals.openChannelModal;
const openProfileModal = modals.openProfileModal;
const openUserCard = modals.openUserCard;

// --- admin panel -------------------------------------------------------------

// The admin/moderator settings panel lives in admin.js — stats, the user table,
// invitations, bot tokens, deleted channels, and the shared custom-emoji manager.
// It writes no shared state and reads state.users through getState; el/$ and the
// app-side helpers (closeDrawers, fileTooLarge, the avatar ceiling) are injected.
const adminPanel = createAdminPanel({
  el,
  $,
  getState: () => state,
  api,
  closeDrawers,
  fileTooLarge,
  getMaxAvatarBytes: () => maxAvatarBytes,
});
// Convenience bindings for the runtime call sites (the gear button, the realtime
// emoji refresh, the Manage-emojis button). The emoji-picker factory above runs
// at module-eval, so it reaches openEmojiManager through a lazy arrow instead.
const openAdmin = adminPanel.openAdmin;
const openEmojiManager = adminPanel.openEmojiManager;
const refreshEmojiManagerIfOpen = adminPanel.refreshEmojiManagerIfOpen;

// --- notifications & ring alerts ---------------------------------------------

// renderNotificationTotal reflects the global "missed notifications" count (the
// sum of pings across channels) in the sidebar badge and the page title, so it's
// visible even when the tab is in the background.
function renderNotificationTotal() {
  const n = S.totalMentions(state);
  const badge = $("#notif-total");
  if (badge) {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.hidden = n === 0;
  }
  document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
}

// showPingToast renders a brief top-of-screen toast for a ping that arrives while
// the tab is focused (where OS notifications are suppressed). Auto-dismisses after
// 4 s; tapping navigates to the channel. Mobile only — on desktop the toast is more
// intrusive than useful (the message is already on screen or one click away), so it
// is gated behind the mobile-layout breakpoint.
function showPingToast(evt, ch) {
  if (!window.matchMedia("(max-width: 720px)").matches) return;
  const container = $("#ping-toasts");
  if (!container) return;
  const author = state.users[evt.payload.user_id];
  const who = author ? author.display_name : "Someone";
  const label = ch && ch.is_dm ? who : `${who} in #${ch ? ch.name : "channel"}`;
  const body = (evt.payload.content || "").replace(/\n+/g, " ");
  const toast = el("div", { class: "ping-toast" },
    el("span", { class: "ping-toast-who" }, label),
    body ? el("span", { class: "ping-toast-body" }, body) : null,
  );
  let timer;
  const dismiss = () => { clearTimeout(timer); toast.remove(); };
  toast.onclick = () => { dismiss(); selectChannel(evt.payload.channel_id); };
  container.append(toast);
  timer = setTimeout(dismiss, 4000);
}

// firePing alerts the user to a ping (DM or @-mention): always a soft chime, plus
// an in-app toast when the tab is focused (OS notifications are suppressed then),
// or an OS notification when they've opted in and aren't looking here. The OS path
// routes through the service worker when one is registered (works on mobile, and
// clicks deep-link via the SW), falling back to a page-context Notification.
function firePing(evt, ch) {
  boop();
  if (!tabUnfocused()) {
    showPingToast(evt, ch);
    return;
  }
  if (!shouldNotify({ permission: currentPermission(), enabled: notifEnabled, focused: false })) {
    return;
  }
  const author = state.users[evt.payload.user_id];
  const who = author ? author.display_name : "Someone";
  const title = ch && ch.is_dm ? who : `${who} in #${ch ? ch.name : "channel"}`;
  const body = evt.payload.content || "";
  const tag = `rivendell-ch-${evt.payload.channel_id}`;
  const icon = author && author.has_avatar ? api.avatarURL(author.id) : undefined;
  const url = "/" + permalinkHash(evt.payload.channel_id, evt.payload.id);
  showViaServiceWorker(title, { body, tag, icon, url }).then((shown) => {
    if (!shown) {
      showNotification(title, { body, tag, icon, onclick: () => selectChannel(evt.payload.channel_id) });
    }
  });
}

// Stable tag so repeat rings for the same incoming call coalesce into one
// notification instead of stacking; `ringNotification` holds the page-context
// Notification (the SW path is dismissed by tag) so clearRingNotification can
// auto-dismiss it once the ring is answered/declined/times out.
const RING_NOTIF_TAG = "rivendell-ring";
let ringNotification = null;

// fireRingNotification raises an OS notification for an incoming call when the
// user has opted in and isn't looking at this tab — a backgrounded tab's audible
// ring alone is easy to miss. Foreground only (a live tab): a ring is ephemeral
// WS state, not a persisted message, so there's no Web Push path to a fully
// closed app. Clicking it focuses the tab and opens the DM, mirroring firePing.
function fireRingNotification(fromUserId, dmChannelId) {
  if (!shouldNotify({ permission: currentPermission(), enabled: notifEnabled, focused: !tabUnfocused() })) {
    return;
  }
  const caller = state.users[fromUserId];
  const who = caller ? caller.display_name : "Someone";
  const title = "📞 Call from " + who;
  const icon = caller && caller.has_avatar ? api.avatarURL(caller.id) : undefined;
  // messageId 0 = "just open the channel" (real ids start at 1); the SW click
  // routing in initPushRouting treats it as selectChannel rather than a jump.
  const url = "/" + permalinkHash(dmChannelId, 0);
  showViaServiceWorker(title, { tag: RING_NOTIF_TAG, icon, url }).then((shown) => {
    if (!shown) {
      ringNotification = showNotification(title, { tag: RING_NOTIF_TAG, icon, onclick: () => selectChannel(dmChannelId) });
    }
  });
}

// clearRingNotification dismisses the incoming-call notification (both paths) once
// the ring resolves, so a stale "Call from …" doesn't linger after accept/decline/
// timeout/sibling-dismiss.
function clearRingNotification() {
  if (ringNotification) {
    try { ringNotification.close(); } catch (e) { /* best-effort */ }
    ringNotification = null;
  }
  closeNotificationsByTag(RING_NOTIF_TAG);
}

// --- web push subscription ---------------------------------------------------

// enablePush registers the service worker and a push subscription, then sends it
// to the server so DMs/@-mentions arrive when the app is fully closed. Idempotent
// and best-effort — any failure (older browser, blocked SW, denied permission)
// leaves foreground notifications working and is logged, not surfaced.
async function enablePush() {
  if (!pushSupported()) return;
  try {
    const { enabled, key } = await api.pushKey();
    if (!enabled || !key) return; // server has push disabled
    const sub = await subscribeToPush(key);
    if (!sub) return;
    await api.pushSubscribe(pushSubscriptionPayload(sub));
  } catch (e) {
    console.warn("rivendell: enable push failed:", e && e.message);
  }
}

// disablePush cancels the browser's push subscription and tells the server to
// drop it. Best-effort.
async function disablePush() {
  try {
    const endpoint = await unsubscribeFromPush();
    if (endpoint) await api.pushUnsubscribe(endpoint);
  } catch (e) {
    console.warn("rivendell: disable push failed:", e && e.message);
  }
}

// initPushRouting registers the SW (so firePing can show via it and any push
// arrives) when notifications are already enabled, refreshes the push
// subscription, and routes a service-worker notification click back to the right
// message. Called once at app start.
function initPushRouting() {
  if (!pushSupported()) return;
  // Route clicks the SW forwards from a background notification.
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type !== "notificationclick" || !data.url) return;
    const hash = data.url.indexOf("#") >= 0 ? data.url.slice(data.url.indexOf("#")) : "";
    const pl = parsePermalink(hash);
    if (pl && state.channels[pl.channelId]) {
      // messageId 0 is the "open the channel" sentinel a ring notification uses
      // (real message ids start at 1) — there's no message to jump to.
      if (pl.messageId) jumpToMessage(pl.channelId, pl.messageId);
      else selectChannel(pl.channelId);
    }
    try { window.focus(); } catch (e) { /* best-effort */ }
  });
  // If notifications are already on, make sure the SW is live and the
  // subscription is fresh (it can be rotated by the browser at any time).
  if (notifEnabled && currentPermission() === "granted") {
    ensureServiceWorker().then(() => enablePush());
  }
}

// --- notification & PTT settings controls ------------------------------------

// renderNotifControl reflects the desktop-notification opt-in into the profile
// modal: the checkbox shows the *effective* state (preference AND OS permission),
// and the hint explains anything blocking it.
function renderNotifControl() {
  const cb = $("#notif-enable");
  const status = $("#notif-status");
  if (!cb) return;
  const supported = notificationsSupported();
  const perm = currentPermission();
  cb.checked = notifEnabled && perm === "granted";
  cb.disabled = !supported || perm === "denied";
  if (!status) return;
  if (!supported) status.textContent = "Your browser doesn't support notifications.";
  else if (perm === "denied") status.textContent = "Blocked in your browser settings — allow notifications there to use this.";
  else if (notifEnabled && perm === "granted") status.textContent = pushSupported()
    ? "On — you'll be notified of DMs and @-mentions, even when the app is closed."
    : "On — you'll be notified of DMs and @-mentions when this tab isn't focused.";
  else status.textContent = "Off — turn on to get alerts for DMs and @-mentions.";
}

// renderPttControl reflects the push-to-talk preference into the profile modal:
// the enable checkbox, the (only-when-enabled) key-rebind button, and a hint.
// While rebinding, the button reads "press a key…" until the next keypress.
function renderPttControl() {
  const cb = $("#ptt-enable");
  if (!cb) return;
  cb.checked = pttEnabled;
  const keyrow = $("#ptt-keyrow");
  const keyBtn = $("#ptt-key-btn");
  const status = $("#ptt-status");
  if (keyrow) keyrow.hidden = !pttEnabled;
  if (keyBtn) keyBtn.textContent = pttCapturing ? "press a key…" : pttKeyLabel(pttKeyCode);
  if (status) status.textContent = pttEnabled
    ? "Your mic stays muted in a call until you hold the key. It still types normally in the message box."
    : "Off — your mic is open the whole time you're in a call.";
}

// --- presence (debounced) ----------------------------------------------------

// Presence debounce: hold an incoming presence.update for PRESENCE_DEBOUNCE_MS
// before applying it, keyed per user. A newer update for the same user replaces
// the pending one; if the latest value already matches what's displayed, the
// pending change is dropped without repainting. Net effect: a brief connectivity
// blip (or any flip that reverts within the window) never repaints the dot,
// killing the occasional flicker. Our own user is exempt — deliberate status
// changes should show immediately (status is server→broadcast with no optimistic
// local update, so debouncing self would lag a deliberate pick by a second).
const PRESENCE_DEBOUNCE_MS = 1500;
const pendingPresence = new Map(); // userId -> timeout handle

function applyPresence(evt) {
  state = S.applyEvent(state, evt);
  renderMembers();
  renderMe();
  renderDMs();
  // Repaint the DM header dot if we're in a DM.
  const ch = state.channels[state.activeChannelId];
  if (ch && ch.is_dm) renderChannelHeader(ch);
  // If a peer just went offline and we have an active secret session with them,
  // end it gracefully — they can't receive or send anymore.
  if (!evt.payload.online) {
    terminateSessionForPeer(evt.payload.user_id);
  }
}

function schedulePresenceUpdate(evt) {
  const uid = evt.payload.user_id;
  const cur = state.users[uid];
  const decision = presenceDecision({
    isSelf: !!(state.me && uid === state.me.id),
    knownUser: !!cur,
    alreadyMatches: cur ? S.presenceMatches(cur, evt.payload) : false,
  });
  if (decision === "now") { applyPresence(evt); return; } // self: deliberate, no debounce
  // Any non-self update supersedes a pending one for the same user.
  const pending = pendingPresence.get(uid);
  if (pending) { clearTimeout(pending); pendingPresence.delete(uid); }
  if (decision === "drop") return; // unknown user, or a flip that reverted in-window
  pendingPresence.set(uid, setTimeout(() => {
    pendingPresence.delete(uid);
    applyPresence(evt);
  }, PRESENCE_DEBOUNCE_MS));
}

// flushPendingPresence drops every pending deferred presence change. Called on
// reconnect (resync re-pulls the authoritative roster), so a stale flip can't fire
// afterward and briefly repaint a user wrong.
function flushPendingPresence() {
  for (const t of pendingPresence.values()) clearTimeout(t);
  pendingPresence.clear();
}

// --- avatars & image preloading ----------------------------------------------

// avatarSrc returns the avatar URL for a user with a ?v= token so the browser
// can cache it aggressively. avatarVersion wins (set by user.update WS events
// during the session); avatar_updated_at from the user object is the durable
// fallback that persists across page loads.
function avatarSrc(userId) {
  const v = avatarVersion[userId];
  if (v) return `${api.avatarURL(userId)}?v=${v}`;
  const u = state.users[userId];
  if (u && u.avatar_updated_at) return `${api.avatarURL(userId)}?v=${encodeURIComponent(u.avatar_updated_at)}`;
  return api.avatarURL(userId);
}

function initials(name) {
  return (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

// Image cache warming (avatars, viewport images, background blob sweep). See
// imagewarm.js for the contract; the pure newest-first URL scan is unit-tested
// there. avatarSrc is passed by reference (it closes over avatarVersion/state).
const imageWarm = createImageWarmer({ getState: () => state, api, avatarSrc });

// --- loading screen ----------------------------------------------------------

function dismissLoadingScreen() {
  const el = document.getElementById("loading-screen");
  if (!el) return;
  el.classList.add("done");
  el.addEventListener("transitionend", () => { el.hidden = true; }, { once: true });
}

// --- voice calling -----------------------------------------------------------

function wireVoiceControls() {
  // Call strip (active call controls at the bottom of the sidebar).
  $("#call-mute-btn").onclick = () => {
    setVoiceMuted(!isVoiceMuted());
    renderCallStrip();
  };
  $("#call-deafen-btn").onclick = () => {
    setVoiceDeafened(!isVoiceDeafened());
    renderCallStrip();
  };
  $("#call-leave-btn").onclick = () => leaveVoiceChannel();

  // Camera toggle (DM calls only — button is hidden in regular voice channels).
  $("#call-camera-btn").onclick = async () => {
    await setCameraEnabled(!isCameraEnabled());
    renderCallStrip();
    renderVideoGrid();
  };
  // Mobile video/chat toggle: switches between watching video and reading chat.
  $("#header-camera-btn").onclick = () => {
    videoViewHidden = !videoViewHidden;
    const btn = $("#header-camera-btn");
    btn.textContent = videoViewHidden ? "📺" : "💬";
    btn.title = videoViewHidden ? "Show video" : "Show chat";
    renderVideoGrid();
  };

  // Accept the current incoming ring: signal the caller, clear the banner, and
  // join the call. Shared by the ring banner's accept button and the channel
  // header call button (which doubles as "Answer" while a ring is incoming).
  const acceptRing = async () => {
    if (!ringState) return;
    const chId = ringState.channelId;
    const fromUserId = ringState.fromUserId;
    stopRingSound();
    clearRingNotification();
    // Send acceptance before joining so the caller gets the signal promptly.
    socket && socket.send({ type: "voice.ring_response", dm_channel_id: chId, accept: true });
    ringState = null;
    renderRingBanner();
    try {
      await ensureDMOpen(chId, fromUserId);
      await joinVoiceChannel(chId, { enableVideo: loadCameraPreference(chId) });
      selectChannel(chId);
    } catch (e) {
      alert(micErrorMessage(e));
    }
  };

  // Ring banner (incoming call).
  $("#ring-accept-btn").onclick = acceptRing;
  $("#ring-decline-btn").onclick = () => {
    if (!ringState) return;
    const chId = ringState.channelId;
    stopRingSound();
    stopPendingSound();
    clearRingNotification();
    socket && socket.send({ type: "voice.ring_response", dm_channel_id: chId, accept: false });
    ringState = null;
    renderRingBanner();
    renderChannelHeader(state.channels[state.activeChannelId]);
  };

  // Call button in the channel header (DMs and regular channels).
  $("#call-btn").onclick = async () => {
    const ch = state.channels[state.activeChannelId];
    if (!ch) return;
    if (!ch.is_dm) {
      // Regular voice channel: toggle join/leave.
      if (isInCall() && voiceCallState.channelId === ch.id) {
        await leaveVoiceChannel();
      } else {
        try {
          await joinVoiceChannel(ch.id);
        } catch (e) {
          alert(micErrorMessage(e));
        }
      }
      return;
    }
    if (ringState && ringState.channelId === ch.id && ringState.direction === "incoming") {
      // Answer the incoming call (same path as the ring banner's accept button).
      await acceptRing();
      return;
    }
    if (ringState) {
      // Cancel the outgoing ring.
      const chId = ringState.channelId;
      stopPendingSound();
      socket && socket.send({ type: "voice.ring_response", dm_channel_id: chId, accept: false });
      ringState = null;
      renderRingBanner();
      renderChannelHeader(ch);
      return;
    }
    if (isInCall()) {
      await leaveVoiceChannel();
      return;
    }
    socket && socket.send({ type: "voice.ring", dm_channel_id: ch.id });
    ringState = { channelId: ch.id, direction: "outgoing", fromUserId: state.me.id };
    renderChannelHeader(ch);
    renderRingBanner();
    startPendingSound(audioCtx); // caller-side "waiting for pickup" tone
  };

  // DM partner volume: the header 🔊 toggles a slider for the other participant.
  // The slider drives voice.js's per-user playout gain (persisted across calls).
  const toggleDMVolume = () => {
    if ($("#channel-dm-call").hidden) return; // only when the partner is on call
    dmVolumeOpen = !dmVolumeOpen;
    renderChannelHeader(state.channels[state.activeChannelId]);
    if (dmVolumeOpen) $("#dm-volume").focus();
  };
  $("#channel-dm-call").onclick = toggleDMVolume;
  $("#channel-dm-call").onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleDMVolume(); }
  };
  $("#dm-volume").oninput = (e) => {
    const ch = state.channels[state.activeChannelId];
    const otherId = ch && ch.is_dm && S.otherDMParticipant(ch, state.me && state.me.id);
    if (!otherId) return;
    const v = Number(e.target.value);
    setVolumeForUser(otherId, v);
    e.target.title = `Volume — ${Math.round(v * 100)}%`;
  };

  wirePushToTalk();
}

// --- push-to-talk ------------------------------------------------------------
//
// When PTT is enabled, the mic is held muted in a call (set on join, see
// onVoiceStateChange) and only opens while the bound key is held. We listen in
// the capture phase so the rebind UI can intercept a keypress before anything
// else, and so a held PTT key is seen even when focus is elsewhere. The bound
// key still types normally inside a text field — pttShouldFire's editable guard
// is what makes the default backtick usable for code in the composer.
function wirePushToTalk() {
  window.addEventListener("keydown", onPttKeyDown, true);
  window.addEventListener("keyup", onPttKeyUp, true);
  // A held key whose keyup we'd otherwise miss (tab/window blur) must not leave
  // the mic stuck open — release PTT defensively when we lose focus.
  window.addEventListener("blur", () => { if (pttTransmitting) releasePtt(); });

  // Profile-modal controls: the enable checkbox and the key-rebind button.
  const cb = $("#ptt-enable");
  if (cb) {
    cb.onchange = () => {
      pttEnabled = cb.checked;
      pttCapturing = false;
      prefs.savePtt(pttEnabled, pttKeyCode);
      // Apply immediately if we're already in a call: enabling holds the mic
      // muted at rest; disabling opens it back up.
      if (isInCall()) { pttTransmitting = false; setVoiceMuted(pttEnabled); }
      renderPttControl();
      renderCallStrip();
    };
  }
  const keyBtn = $("#ptt-key-btn");
  if (keyBtn) {
    keyBtn.onclick = () => { pttCapturing = true; renderPttControl(); };
  }
}

function isEditableTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

function onPttKeyDown(e) {
  // Rebind capture: the next keypress (Escape cancels) becomes the PTT key. We
  // swallow it so it neither toggles PTT nor closes the open profile modal.
  if (pttCapturing) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code !== "Escape") { pttKeyCode = e.code; prefs.savePtt(pttEnabled, pttKeyCode); }
    pttCapturing = false;
    renderPttControl();
    renderCallStrip();
    return;
  }
  if (e.repeat) return; // auto-repeat while the key is held — already transmitting
  if (pttTransmitting) return;
  if (!pttShouldFire({ enabled: pttEnabled, inCall: isInCall(), code: e.code, boundCode: pttKeyCode, editable: isEditableTarget(e.target) })) return;
  pttTransmitting = true;
  setVoiceMuted(false);
  renderCallStrip();
}

function onPttKeyUp(e) {
  if (!pttTransmitting || e.code !== pttKeyCode) return;
  releasePtt();
}

// releasePtt closes the PTT mic gate (re-mutes) and repaints the strip.
function releasePtt() {
  pttTransmitting = false;
  if (isInCall()) setVoiceMuted(true);
  renderCallStrip();
}

// --- voice + ring event handling ---------------------------------------------

// onVoiceEvent handles incoming voice.* events from the server.
async function onVoiceEvent(evt) {
  const p = evt.payload || {};

  if (evt.type === "voice.ring") {
    // Incoming ring from another user.
    if (ringState) return; // already in a ring — ignore (shouldn't happen in practice)
    ringState = { channelId: p.dm_channel_id, direction: "incoming", fromUserId: p.from_user_id };
    renderRingBanner();
    // Repaint the header so the active DM's call button flips to the "answer"
    // icon — the banner alone doesn't drive the header.
    renderChannelHeader(state.channels[state.activeChannelId]);
    startRingSound(audioCtx);
    fireRingNotification(p.from_user_id, p.dm_channel_id);
    return;
  }

  if (evt.type === "voice.ring_response") {
    // Response to a ring we sent, or the other side cancelling their ring.
    if (!ringState) return;
    stopRingSound();
    stopPendingSound();
    clearRingNotification();
    const accepted = p.accept;
    const chId = ringState.channelId;
    ringState = null;
    renderRingBanner();
    renderChannelHeader(state.channels[state.activeChannelId]);
    if (accepted) {
      try {
        await joinVoiceChannel(chId, { enableVideo: loadCameraPreference(chId) });
      } catch (e) {
        alert(micErrorMessage(e));
      }
    }
    return;
  }

  if (evt.type === "voice.ring_timeout") {
    if (ringState && ringState.channelId === p.dm_channel_id) {
      stopRingSound();
      stopPendingSound();
      clearRingNotification();
      ringState = null;
      renderRingBanner();
      renderChannelHeader(state.channels[state.activeChannelId]);
    }
    return;
  }

  if (evt.type === "voice.ring_dismissed") {
    // Another of our own sessions (tab/device) answered or declined this ring.
    // Stop ringing here too, but do NOT join — that session handles the call.
    if (ringState && ringState.channelId === p.dm_channel_id) {
      stopRingSound();
      stopPendingSound();
      clearRingNotification();
      ringState = null;
      renderRingBanner();
      renderChannelHeader(state.channels[state.activeChannelId]);
    }
    return;
  }

  if (evt.type === "voice.end") {
    // The other party in a DM hung up (or dropped): the call ends for both.
    // Tear down our side without echoing a voice.leave (the server already
    // removed us). endCallLocally fires the farewell tone (in steady-state
    // capture) then tears down — async, fire-and-forget here.
    if (isInCall() && voiceChannelId() === p.channel_id) {
      endCallLocally();
    }
    return;
  }

  if (evt.type === "voice.join_denied") {
    // The server refused our join (group caps). "full": the channel is at its
    // participant limit — abort the optimistic local join. "video_full": only
    // the camera slots are exhausted, so stay in the call but drop back to
    // audio-only (the server already forced us video-muted).
    if (voiceTelemetry) { try { voiceTelemetry.event(0, "join-denied", { reason: p.reason, limit: p.limit }); } catch { /* telemetry never throws */ } }
    if (p.reason === "video_full") {
      await setCameraEnabled(false);
      alert(`This call already has the maximum ${p.limit} cameras on — staying audio-only.`);
    } else {
      if (isInCall() && voiceChannelId() === p.channel_id) await endCallLocally();
      alert(`That call is full (max ${p.limit}).`);
    }
    return;
  }

  // voice.state — update sidebar rosters for any channel, then pass to voice.js.
  if (evt.type === "voice.state") {
    voiceRosters[evt.payload.channel_id] = evt.payload.participants || [];
    renderChannels();
  }
  // voice.state / offer / answer / ice — pass to voice.js machinery.
  await handleVoiceSignal(evt);
}

function renderRingBanner() {
  const banner = $("#ring-banner");
  if (!ringState) {
    banner.hidden = true;
    return;
  }
  const { direction, fromUserId, channelId } = ringState;
  const bannerText = $("#ring-banner-text");
  if (direction === "incoming") {
    const caller = state.users[fromUserId];
    const name = caller ? caller.display_name : "Someone";
    bannerText.textContent = name + " is calling…";
    $("#ring-accept-btn").hidden = false;
    $("#ring-decline-btn").textContent = "Decline";
  } else {
    // outgoing ring
    const ch = state.channels[channelId];
    const otherName = ch ? dmDisplayName(state, ch) : "…";
    bannerText.textContent = "Calling " + otherName + "…";
    $("#ring-accept-btn").hidden = true;
    $("#ring-decline-btn").textContent = "Cancel";
  }
  banner.hidden = false;
}

// --- voice state callbacks ---------------------------------------------------

// onVoiceStateChange folds a fresh state push from voice.js into the UI: it
// chimes a greet/farewell tone for each remote peer that joined/left since the
// last push, refreshes the on-call cue set, and repaints the call strip, header,
// and member roster. Our OWN join/leave tones are NOT fired here — they're
// driven by voice.js lifecycle hooks (greetTone just after the mic is live and
// settled, farewellTone just before teardown) so they land in the same
// steady-state capture window where these remote-peer tones play loud, not in
// the capture start/stop device transition. See initVoice / joinVoiceChannel.
function onVoiceStateChange(vs) {
  const prevInCall = voiceCallState.inCall;
  const prevRemote = new Set([...callParticipantIds].filter((id) => id !== state.me.id));
  voiceCallState = vs;
  callParticipantIds = new Set((vs.participants || []).map((p) => p.user_id));
  // Entering a call with push-to-talk on: hold the mic muted at rest (the key
  // opens it). The !prevInCall guard fires this only on the join transition;
  // setVoiceMuted re-enters here with prevInCall now true, so it won't recurse.
  if (!prevInCall && vs.inCall && pttEnabled && !pttTransmitting && !isVoiceMuted()) setVoiceMuted(true);
  if (!vs.inCall) pttTransmitting = false; // call ended: drop any stuck PTT gate
  if (prevInCall && vs.inCall) {
    // Already in call: chime for remote peers joining/leaving. (Self join/leave
    // tones are handled by the voice.js lifecycle hooks, not here.)
    const nowRemote = new Set([...callParticipantIds].filter((id) => id !== state.me.id));
    for (const id of nowRemote) if (!prevRemote.has(id)) greetTone();
    for (const id of prevRemote) if (!nowRemote.has(id)) farewellTone();
  }
  if (!vs.inCall && speakingIds.size) speakingIds.clear(); // call ended: drop stale rings
  if (!vs.inCall) videoViewHidden = false; // call ended: clear any mobile chat-override
  renderCallStrip();
  renderVideoGrid();
  renderChannelHeader(state.channels[state.activeChannelId]);
  renderMembers();
}

// onSpeaking folds a speaking-state flip from voice.js into the roster: it
// toggles a pulsing ring on that user's member row without re-rendering the
// whole list (the flip fires every ~80ms of metering, far too often to repaint).
function onSpeaking(userId, speaking) {
  const had = speakingIds.has(userId);
  if (speaking === had) return;
  if (speaking) speakingIds.add(userId);
  else speakingIds.delete(userId);
  const li = document.querySelector(`#member-list li[data-user-id="${userId}"]`);
  if (li) li.classList.toggle("speaking", speaking);
  // In a group video gallery, promote the active speaker by highlighting their
  // tile — without repainting the grid (the flip fires far too often for that).
  const tile = document.querySelector(`#video-grid .video-tile[data-user-id="${userId}"]`);
  if (tile) tile.classList.toggle("speaking", speaking);
}

// --- video grid + call strip -------------------------------------------------

// setVideoActive toggles body.video-active (which hides the composer/message list
// behind the video grid). The composer needs no re-size on reveal: it's a
// contenteditable div that sizes itself from content (the old textarea needed
// a JS autosize pass here to undo a height:0px written while it was hidden).
function setVideoActive(on) {
  document.body.classList.toggle("video-active", on);
}

// appendFullscreenButton adds the corner ⛶ control that toggles fullscreen on
// the grid (covers the mobile "replace chat with video" case too).
function appendFullscreenButton(grid) {
  const fsBtn = el("button", { class: "video-fullscreen-btn", title: "Fullscreen" }, "⛶");
  fsBtn.onclick = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      grid.requestFullscreen().catch(() => {});
    }
  };
  grid.appendChild(fsBtn);
}

// videoAvatarTile builds the dark camera-off placeholder for one participant:
// their avatar (or initials) plus their name. Used by both the DM and group
// layouts wherever a participant has no live video.
function videoAvatarTile(userId, user) {
  const avatarDiv = el("div", { class: "video-avatar" });
  if (user && user.has_avatar) {
    avatarDiv.appendChild(el("img", { class: "video-avatar-img", src: avatarSrc(userId), alt: "" }));
  } else {
    avatarDiv.appendChild(el("div", { class: "video-avatar-initials" }, initials((user || {}).display_name)));
  }
  avatarDiv.appendChild(el("span", { class: "video-avatar-name" }, (user || {}).display_name || ""));
  return avatarDiv;
}

// renderVideoGrid paints #video-grid for the active call when we're viewing its
// channel. DMs use the 2-tile phone layout (remote tile + local PiP); group
// voice channels use an N-tile gallery (one tile per participant). Hidden when
// not in a call, viewing a different channel, or nobody has a camera on.
function renderVideoGrid() {
  const grid = $("#video-grid");
  const ch = voiceCallState.inCall && voiceCallState.channelId !== null
    ? state.channels[voiceCallState.channelId]
    : null;

  if (!ch || voiceCallState.channelId !== state.activeChannelId) {
    grid.classList.remove("group-grid");
    grid.hidden = true;
    setVideoActive(false);
    return;
  }
  if (ch.is_dm) renderDMVideoGrid(grid, ch);
  else renderGroupVideoGrid(grid, ch);
}

// renderDMVideoGrid is the original 2-tile DM layout: remote tile (video when
// the camera is on, dark avatar tile when off) plus a local PiP when our camera
// is on (decision: no self-preview when our camera is off).
function renderDMVideoGrid(grid, ch) {
  grid.classList.remove("group-grid");
  const otherId = S.otherDMParticipant(ch, state.me && state.me.id);
  const otherP = voiceCallState.participants.find(p => p.user_id === otherId);
  const remoteVideoMuted = !otherP || otherP.video_muted;

  // When both cameras are off there's no video to show; also clear any mobile
  // view-override so the toggle button disappears cleanly.
  if (voiceCallState.videoMuted && remoteVideoMuted) {
    videoViewHidden = false;
    grid.hidden = true;
    setVideoActive(false);
    return;
  }

  // On mobile the user may have chosen to view chat instead of video.
  if (videoViewHidden) {
    grid.hidden = true;
    setVideoActive(false);
    return;
  }
  const remoteVideo = otherId != null ? getVideoEl(otherId) : null;

  grid.innerHTML = "";

  const remoteTile = el("div", { class: "video-tile" });
  if (remoteVideo && !remoteVideoMuted) {
    remoteTile.appendChild(remoteVideo);
    remoteVideo.play().catch(() => {});
  } else {
    remoteTile.appendChild(videoAvatarTile(otherId, otherId != null ? state.users[otherId] : null));
  }
  grid.appendChild(remoteTile);

  // Local PiP only when camera is on
  if (!voiceCallState.videoMuted) {
    const localVid = getLocalVideoEl();
    if (localVid) {
      localVid.className = "video-tile-local";
      grid.appendChild(localVid);
      localVid.play().catch(() => {});
    }
  }

  appendFullscreenButton(grid);
  grid.hidden = false;
  setVideoActive(true);
}

// renderGroupVideoGrid is the 1.4.0 N-tile gallery: one tile per call
// participant (self included), in join order. A participant with their camera
// on shows live video; otherwise a dark avatar tile. The grid only appears once
// at least one participant has a camera on — a camera-off voice call is
// represented by the members roster, not a wall of avatar tiles. The active
// speaker is highlighted live by onSpeaking toggling each tile's `.speaking`.
function renderGroupVideoGrid(grid, ch) {
  const meId = state.me && state.me.id;
  const anyVideo = !voiceCallState.videoMuted ||
    voiceCallState.participants.some(p => p.user_id !== meId && !p.video_muted);

  if (!anyVideo) {
    videoViewHidden = false;
    grid.classList.remove("group-grid");
    grid.hidden = true;
    setVideoActive(false);
    return;
  }
  if (videoViewHidden) {
    grid.classList.remove("group-grid");
    grid.hidden = true;
    setVideoActive(false);
    return;
  }

  grid.innerHTML = "";
  grid.classList.add("group-grid");

  for (const p of voiceCallState.participants) {
    const isSelf = p.user_id === meId;
    const videoOn = isSelf ? !voiceCallState.videoMuted : !p.video_muted;
    const videoEl = videoOn ? (isSelf ? getLocalVideoEl() : getVideoEl(p.user_id)) : null;

    const tile = el("div", { class: "video-tile", "data-user-id": String(p.user_id) });
    if (speakingIds.has(p.user_id)) tile.classList.add("speaking");
    if (videoEl) {
      videoEl.className = ""; // shed any PiP styling from a prior DM render
      tile.appendChild(videoEl);
      videoEl.play().catch(() => {});
    } else {
      const user = isSelf ? (state.users[meId] || state.me) : state.users[p.user_id];
      tile.appendChild(videoAvatarTile(p.user_id, user));
    }
    grid.appendChild(tile);
  }

  appendFullscreenButton(grid);
  grid.hidden = false;
  setVideoActive(true);
}

function renderCallStrip() {
  const strip = $("#call-strip");
  if (!voiceCallState.inCall) {
    strip.hidden = true;
    return;
  }
  const ch = voiceCallState.channelId !== null ? state.channels[voiceCallState.channelId] : null;
  const label = ch ? (ch.is_dm ? "📞 " + dmDisplayName(state, ch) : "🔊 #" + ch.name) : "In call";
  $("#call-strip-label").textContent = label;
  // In PTT mode the mic is key-driven, so the mute toggle is replaced by a PTT
  // pill that lights up while you're holding the key (transmitting).
  const muteBtn = $("#call-mute-btn");
  const pttPill = $("#call-ptt");
  if (pttEnabled) {
    muteBtn.hidden = true;
    pttPill.hidden = false;
    pttPill.textContent = "PTT " + pttKeyLabel(pttKeyCode);
    pttPill.title = "Push-to-talk — hold " + pttKeyLabel(pttKeyCode) + " to talk";
    pttPill.classList.toggle("active", pttTransmitting);
  } else {
    pttPill.hidden = true;
    muteBtn.hidden = false;
    muteBtn.textContent = voiceCallState.muted ? "🔇" : "🎙";
    muteBtn.title = voiceCallState.muted ? "Unmute" : "Mute";
    muteBtn.classList.toggle("active", voiceCallState.muted);
  }
  const deafBtn = $("#call-deafen-btn");
  deafBtn.textContent = voiceCallState.deafened ? "🔈" : "🔊";
  deafBtn.title = voiceCallState.deafened ? "Undeafen" : "Deafen";
  deafBtn.classList.toggle("active", voiceCallState.deafened);
  // Camera button: available in any call — DMs and group voice channels alike
  // (group video is the 1.4.0 feature). Hidden only when there's no active call.
  const camBtn = $("#call-camera-btn");
  if (ch) {
    camBtn.hidden = false;
    camBtn.textContent = voiceCallState.videoMuted ? "📷" : "🎥";
    camBtn.title = voiceCallState.videoMuted ? "Turn camera on" : "Turn camera off";
    camBtn.classList.toggle("active", voiceCallState.videoMuted);
  } else {
    camBtn.hidden = true;
  }
  strip.hidden = false;
}

// --- secret session UI -------------------------------------------------------

// The secret-chat UX layer lives in secretui.js — the request banner, the 🔒
// DM-header button, and the safety-number modal. It owns the pending *incoming*
// request (secretRequestState moved in there); app.js reads it only through
// secretUI.getSecretRequest() (the DM list marks a channel with a request).
// secret.js's primitives are imported by the module directly; app.js injects the
// render/navigation hooks below.
const secretUI = createSecretUI({
  $,
  getState: () => state,
  api,
  renderChannelHeader,
  renderMessages,
  renderDMs,
  selectChannel,
  ensureDMOpen,
});
// Bindings for the runtime call sites: the secret.js callback (initSecret), the
// one-time control wiring, and the banner re-render from renderChannelHeader.
const onSecretEvent = secretUI.onSecretEvent;
const renderSecretBanner = secretUI.renderSecretBanner;
const wireSecretControls = secretUI.wireSecretControls;

boot();
