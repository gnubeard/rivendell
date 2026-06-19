// app.js — the rivendell web client. Wires the API, websocket, formatter, and the
// pure state reducer to the DOM. Deliberately framework-free.
//
// Big file. It's mapped: 8 `// ▌ REGION N` banners (coarse) over 31 `// --- `
// section markers (fine). Read docs/atlas.md first for the overview + the index.

import { api } from "./api.js";
import { connectRealtime } from "./ws.js";
import { formatMessage, mentionsUser, permalinkHash, parsePermalink, extractHideURL, extractFirstBareURL, isImageURL, suppressEmbedURL, replySnippet, dataUriToFile, reactionTooltip, classifyReaction, shouldGroupMessage, BUILTIN_EMOJI } from "./format.js";
import * as S from "./state.js";
import {
  initSecret,
  isSecretSupported,
  getSession,
  clearEndedSession,
  terminateSessionForPeer,
  sendEndAllOnUnload,
  sendSecretMessage,
  handleSecretEvent,
} from "./secret.js";
import {
  initVoice,
  fetchIceServers,
  endCallLocally,
  cameraErrorMessage,
  getVideoEl,
  isInCall,
  voiceChannelId,
  setSpeakingCallback,
  setCameraErrorCallback,
  setVolumeForUser,
  getVolumeForUser,
  registerDebug,
  reconcilePeers,
} from "./voice.js";
import { rtcDebugEnabled, createTelemetry } from "./rtcdebug.js";
import { primeAudio, greetTone, farewellTone } from "./tones.js";
import { createUnreadTracker, unreadCountAfter, classifyIncomingMessage, shouldInsertUnreadMarker } from "./unread.js";
import { regularChannelOrder, sidebarChannelOrder, dmDisplayName } from "./channelorder.js";
import { createDraftStore } from "./drafts.js";
import { upgradeComposerField } from "./composer-field.js";
import { createComposerRichText, toggleMarker } from "./composer-richtext.js";
import { humanBytes, formatTime, overSizeLimit, initials } from "./util.js";
import { createPrefs, normalizeTheme } from "./prefs.js";
import { createAttachmentTray, composeMessageBody } from "./attachments.js";
import { createAutocomplete } from "./autocomplete.js";
import { createSearch } from "./search.js";
import { createEmojiPicker } from "./emoji.js";
import { createChannelDrag } from "./channeldrag.js";
import { presenceClass, presenceLabel, presenceDecision } from "./presence.js";
import { createImageWarmer } from "./imagewarm.js";
import { createLinkPreviews } from "./linkpreview.js";
import { createAdminPanel } from "./admin.js";
import { createSecretUI } from "./secretui.js";
import { createForward } from "./forward.js";
import { createPins } from "./pins.js";
import { createModals } from "./modals.js";
import { createMobileCtx } from "./mobilectx.js";
import { createVideoGrid } from "./videogrid.js";
import { createVoiceUI } from "./voiceui.js";
import { createNotifyUI } from "./notifyui.js";
import { isNearBottom, scrollToBottom, PAGE, createHistoryPaging } from "./history.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ▌ REGION 1 · FOUNDATIONS
// ▌ Module-level state (the world model + ephemeral session cursors) and the
// ▌ DOM micro-helpers ($/el/show/guard/safeLocal) every later region builds on.
// ▌ Map: docs/atlas.md.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
let appVersion = "";    // server-reported semantic version, shown in the About dialog
let debugTelemetryFlag = false; // server switch (GET /api/instance) forcing WebRTC telemetry on for all clients
// Server-reported upload size ceilings (bytes) for the client-side pre-check.
// 0 = unknown (instance fetch failed) → skip it and let the server enforce.
let maxImageBytes = 0;
let maxAvatarBytes = 0;

// Browser-local preferences (notifications + push-to-talk). prefs.js handles
// load/persist + localStorage fail-safety. `prefs` must precede the modules seeded
// from it. (The notification opt-in lives in notifyui.js; push-to-talk in voiceui.js
// — both seed from prefs and own their live value.)
const prefs = createPrefs();

// Ephemeral bookkeeping owned by sibling modules (not part of `state`).
const unread = createUnreadTracker(); // divider cursor, mark-unread suppression, mark-read POST dedupe
const drafts = createDraftStore();    // per-channel composer scratch (draft text + pending uploads)
let composerTray = null;              // attachments.js upload tray; null until wireComposer builds it (guard with ?.)
let composerRich = null;              // composer-richtext.js live decoration; null until wireComposer builds it (guard with ?.)
// Per-user avatar cache-bust token: bumped only on a genuine avatar change
// (avatar_updated_at moved) to force a re-fetch of the otherwise-stable, cached
// avatar URL. NOT bumped on unrelated profile edits (name/bio/status) — that
// would change the URL and re-fetch an unchanged image, flickering the avatar.
const avatarVersion = {};
// Message ids deleted *during this session* (seen live via message.delete); only
// these earn a tombstone, so a fresh history load isn't littered with them.
const liveDeleted = new Set();

// pruneLiveDeleted bounds that set so it can't grow without limit across a long
// session: renderDeletedRun can only ever draw a tombstone for an id still present
// (as a deleted row) in a loaded channel window, so dropping any id that's in NO
// loaded window is invisible. Called at channel-reload time (a window is replaced),
// the natural GC point.
function pruneLiveDeleted() {
  if (liveDeleted.size === 0) return;
  const stillLoaded = new Set();
  for (const cid in state.messages) {
    for (const m of state.messages[cid] || []) {
      if (m.deleted_at && liveDeleted.has(m.id)) stillLoaded.add(m.id);
    }
  }
  for (const id of [...liveDeleted]) {
    if (!stillLoaded.has(id)) liveDeleted.delete(id);
  }
}

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

// Scrollback: messages load a page at a time as you scroll. The paging state
// machine (load guards, history-window flags, sentinels) lives in history.js
// behind `historyPaging` (created below); PAGE/NEAR_BOTTOM_PX/isNearBottom/
// scrollToBottom are its scroll-geometry exports, imported above.
let flashMessageId = null;         // id of a jumped-to message to highlight; survives re-renders

// Voice / call UI state lives in voiceui.js (the call strip, ring banner, PTT,
// on-call rosters/participant/speaking sets, videoViewHidden); app.js's render
// functions read it through the voiceUI accessors. (Secret-chat banner state
// lives in secretui.js, read via secretUI.getSecretRequest().) Two voice values
// stay here: voiceTelemetry, created + registered to voice.js in enterApp, and
// the DM-partner volume widget, which is part of the channel header app.js owns.
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

// safeLocalGet / safeLocalSet wrap localStorage, which throws when storage is
// unavailable (private mode, blocked cookies, quota). The app-shell keys are always
// best-effort — a failed read returns null, a failed write is a silent no-op — so
// callers never carry their own try/catch. (prefs.js owns the *preferences* subset
// through its injected-storage pattern; these cover the session keys app.js holds.)
function safeLocalGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeLocalSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* best-effort */ }
}

// Storage key for the last-open channel (restored on next load). A single
// constant so the write sites and the read site can't silently disagree on it —
// a typo'd literal would persist under one key and read from another, quietly
// breaking channel restore with no error.
const ACTIVE_CHANNEL_KEY = "rivendell.activeChannel";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ▌ REGION 2 · BOOT & AUTH
// ▌ Page-load to live app: viewport/audio priming, the /set-password and
// ▌ /invite routes, login/signup, and enterApp() — the one big async that
// ▌ seeds state, paints the first frame, and wires everything before realtime.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
    const atBottom = ml && isNearBottom(ml.scrollHeight, ml.scrollTop, ml.clientHeight);
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
// The chime + call tones (boop / greet / farewell / ring / pending) are
// synthesized in tones.js, behind one gesture-primed AudioContext; primeAudio
// (wired to gesture events in boot) unlocks it. app.js just calls the players.

// tabUnfocused reports whether the user isn't actually looking here — the tab is
// backgrounded/minimized (document.hidden) or another window/app has focus
// (!document.hasFocus()).
function tabUnfocused() {
  return document.hidden || !document.hasFocus();
}

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
      notifUI.setBaseTitle(inst.name);
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

// MAP — enterApp is the one-time boot sequence: authenticated → fully live. The
// order is load-bearing (see CLAUDE.md): every interactive control is wired BEFORE
// startRealtime(), so no event can arrive before its handler exists.
//
//   1. show("app"); fetch users + channels (parallel) → seed state → preload avatars
//   2. best-effort seeds (each try/catch, non-fatal): emojis · unread · voice rosters
//   3. choose the channel to open (restored last / first real / permalink target)
//   4. first paint: renderMe · rerenderSidebar · renderAdminVisibility · notif total
//   5. load that channel (or jumpToMessage for a permalink) + mark read
//   6. warm viewport images → dismissLoadingScreen → background image warm
//   7. subsystems: initVoice (+telemetry, callbacks, ICE) · initSecret (+support, key)
//   8. WIRE EVERYTHING: wireComposer · wireControls · wireSwipe · wireIdleDetection ·
//      push routing · focus / visibility / beforeunload listeners
//   9. startRealtime()  ← LAST, only after step 8 (guarded; realtime is optional)
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
      voiceUI.seedRoster(channel_id, participants);
    }
  } catch (e) {
    /* non-fatal: sidebar voice cues populate from realtime events */
  }
  // Restore the channel the user last had open (if it's still accessible);
  // otherwise prefer a real channel over a DM on first load.
  const saved = safeLocalGet(ACTIVE_CHANNEL_KEY);
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
  notifUI.renderNotificationTotal();
  // Check for a permalink hash (#c<channelId>/m<messageId>) before loading
  // the default channel — if present, jump there instead.
  const permalink = parsePermalink(location.hash);
  if (permalink && permalink.messageId) {
    history.replaceState(null, "", "/");
    // jumpToMessage self-handles a channel absent from local state (a closed DM):
    // it fetches/reopens it, or flashes a notice in the message pane if it's truly
    // inaccessible. The sidebar/header are already rendered above, so even the
    // inaccessible case leaves a usable app — and a notification's target is always
    // one we're a member of, so it resolves.
    await jumpToMessage(permalink.channelId, permalink.messageId);
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
  initVoice(state.me.id, sendWS, voiceUI.onVoiceStateChange, greetTone, farewellTone);
  // WebRTC debug telemetry: opt-in per client (?rtcdebug=1 / localStorage) or
  // forced on for everyone by the server flag. When enabled, capture batches
  // getStats() + lifecycle events to POST /api/debug/telemetry (logged server-side).
  if (rtcDebugEnabled(debugTelemetryFlag)) {
    voiceTelemetry = createTelemetry({ getVideoEl });
    registerDebug(voiceTelemetry);
  }
  setSpeakingCallback(voiceUI.onSpeaking);
  setCameraErrorCallback((err) => alert(cameraErrorMessage(err)));
  fetchIceServers(); // best-effort; falls back to public STUN on error
  voiceUI.wireVoiceControls();
  wireDMVolume(); // header partner-volume widget (stays in app.js with the header)
  // Secret chat: init module, wire controls, check browser support.
  initSecret(state.me.id, sendWS, onSecretEvent);
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
  notifUI.initPushRouting();
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
        sendWS({ type: "voice.leave", channel_id: chId });
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ▌ REGION 3 · REALTIME
// ▌ The inbound WebSocket pump. handleRealtimeEvent folds each frame into state
// ▌ via the pure reducers, then dispatches the targeted re-renders + voice/
// ▌ secret hand-offs. resync closes the gap a dead socket left after reconnect.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// --- realtime ----------------------------------------------------------------

function startRealtime() {
  if (socket) socket.close();
  socket = connectRealtime(handleRealtimeEvent, onRealtimeConnChange);
}

// sendWS sends a frame over the realtime socket when one exists. `socket` is null
// until startRealtime() runs, so every send must guard on it. ws.js's own send()
// already drops frames when the socket isn't OPEN and never throws (readyState
// check + internal try/catch), so this needs only the null-guard — no try/catch.
function sendWS(msg) {
  if (socket) socket.send(msg);
}

// handleRealtimeEvent folds one inbound WS frame into `state` (via the pure
// S.applyEvent / classifyIncomingMessage reducers) and routes the DOM consequences
// by event type. The state-folding is total in state.js; what's left here is the
// targeted re-render dispatch and the voice/secret hand-offs — DOM territory, not
// a further pure carve (see docs/history/frontend-decomposition.md, "Realtime/sync").
// MAP — the inbound-WS dispatch table. Every frame is first folded into `state` by
// the PURE reducer (S.applyEvent, total in state.js); what remains here is "given
// the event type, which DOM re-renders fire" plus the voice/secret hand-offs. It
// writes `state` only through the reducers, never ad hoc. Repaints route through
// scheduleRender (batched — one paint per task; see the render-batching note) or,
// for the message pane, the incremental appendMessageRow/patchMessageRow fast paths
// with a full renderMessages fallback.
//
//   presence.update    → schedulePresenceUpdate (DEBOUNCED ~1.5s), early-return
//   presence*/user.update → schedule members · me · dms
//                           (user.update also: avatar cache-bust + schedule messages)
//   channel*           → schedule channels · dms (+ header/members if active)
//   member.remove      → me: drop/reload active channel · other: prune the roster
//   hello              → server version ≠ ours → show #update-banner (deploy happened)
//   read/mute.update   → schedule channels·dms·total (+ messages if active)
//   typing.update      → schedule typing (if active)
//   emoji.add/delete   → schedule messages · picker.rerender · refreshEmojiManagerIfOpen
//   reaction.update    → patchMessageRow (full-render fallback) + refreshPinsIfOpen
//   voice.* / secret.* → voiceUI.onVoiceEvent / handleSecretEvent
//   message*           → classifyIncomingMessage (PURE, unread.js) decides
//                        unread/mention/ping; here is only the DOM fallout (DM
//                        resort, append/patch/full message render, read cursor,
//                        badges, firePing)
//
// The unread/mention/ping matrix is intentionally NOT inlined — it's pure and
// unit-tested in unread.js. Keep the policy there; keep only the side effects here.
// The four fat domains (presence/user, channel, member.remove, message) are
// extracted into named on<Domain>(evt) handlers right below the dispatcher; the
// small ones (hello, read/mute, typing, emoji, reaction, voice, secret) stay inline.
function handleRealtimeEvent(evt) {
  // Presence is debounced (see schedulePresenceUpdate): a transient flip that
  // reverts within ~1s never paints, so dots don't flicker on brief blips.
  if (evt.type === "presence.update") { schedulePresenceUpdate(evt); return; }
  // member.remove's side effects below need to know whether the channel was
  // still present *before* applyEvent folds the removal in — so a removal we
  // already did locally (leaveActiveChannel) doesn't trigger a redundant reload.
  const hadChannel = evt.type === "member.remove" && !!state.channels[evt.payload.channel_id];
  // Capture the avatar timestamp BEFORE the fold so onPresenceOrUserUpdate can tell
  // an actual avatar change from an unrelated profile edit (applyEvent overwrites it).
  const prevAvatarAt = evt.type === "user.update" && evt.payload
    ? ((state.users[evt.payload.id] && state.users[evt.payload.id].avatar_updated_at) || null)
    : null;
  state = S.applyEvent(state, evt);
  // Targeted DOM re-renders by event type. Each FAT domain lives in its own
  // on<Domain>(evt) handler below (defined right after this dispatcher); the small
  // ones stay inline. See the MAP above for the full event→effect table.
  if (evt.type.startsWith("presence") || evt.type === "user.update") onPresenceOrUserUpdate(evt, prevAvatarAt);
  if (evt.type.startsWith("channel")) onChannelEvent(evt);
  if (evt.type === "member.remove") onMemberRemove(evt, hadChannel);
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
    scheduleRender("channels", "dms", "total");
    // Keep 👁 titles current in the open channel — a targeted refresh, NOT a full
    // render. (This event self-echoes back to the session that marked the channel
    // read, so a full render here would wipe an active text selection on every
    // incoming message; the divider marker is local session state a remote read
    // doesn't move, so titles are the only pane effect.)
    if ((evt.type === "read.update" || evt.type === "read.unread") &&
        evt.payload.channel_id === state.activeChannelId) {
      refreshReadMarks();
    }
  }
  if (evt.type === "typing.update") {
    if (evt.payload.channel_id === state.activeChannelId) scheduleRender("typing");
  }
  if (evt.type === "emoji.add" || evt.type === "emoji.delete") {
    // The registry changed: re-render the open messages so :shortcode: tokens
    // start/stop rendering as images (a full pass — any message may carry one),
    // and refresh any open emoji surfaces.
    scheduleRender("messages");
    if (emojiPicker.isOpen()) emojiPicker.rerender();
    refreshEmojiManagerIfOpen();
  }
  if (evt.type === "reaction.update") {
    // applyEvent already folded the new groups into the message; patch just that
    // row (and the pins panel, which renders reactions too). A full render only if
    // the row isn't on screen to patch.
    if (evt.payload.channel_id === state.activeChannelId) {
      if (!patchMessageRow(evt.payload.message_id)) scheduleRender("messages");
      refreshPinsIfOpen();
    }
  }
  if (evt.type.startsWith("voice.")) {
    voiceUI.onVoiceEvent(evt);
  }
  if (evt.type.startsWith("secret.")) {
    handleSecretEvent(evt, (userId) => {
      const u = state.users[userId];
      return u ? u.identity_key || null : null;
    }).catch((e) => console.warn("secret: event handler error:", e && e.message));
  }
  if (evt.type.startsWith("message")) onMessageEvent(evt);
}

// onPresenceOrUserUpdate repaints the surfaces that show a user's identity/presence
// (the member list, my own chip, DM rows) and — on a profile change — the open
// message authors. A user.update whose avatar_updated_at actually moved busts the
// avatar cache first; an unrelated edit (name/bio/status) leaves the URL stable so
// the cached image isn't re-fetched and the avatar doesn't flicker.
function onPresenceOrUserUpdate(evt, prevAvatarAt) {
  if (evt.type === "user.update" && evt.payload &&
      (evt.payload.avatar_updated_at || null) !== (prevAvatarAt || null)) {
    // The avatar itself changed — force a re-fetch on next render.
    avatarVersion[evt.payload.id] = Date.now();
    imageWarm.preloadAvatars(); // warm the new versioned URL ahead of the repaint
  }
  scheduleRender("members", "me", "dms"); // a DM row shows the other participant's name + presence
  // Author display name / avatar in the open message list may have changed.
  if (evt.type === "user.update") scheduleRender("messages");
}

// onChannelEvent repaints the channel/DM lists on any channel.* event, and — when it
// concerns the channel I'm viewing — re-scopes the members panel and repaints the
// header. A topic edit by another mod arrives here too; skip the header repaint while
// I'm mid-edit (an open input under #channel-topic) so I don't clobber my own input.
function onChannelEvent(evt) {
  scheduleRender("channels", "dms");
  if (evt.payload && evt.payload.id === state.activeChannelId) {
    if (!$("#channel-topic").querySelector("input")) {
      renderChannelHeader(state.channels[state.activeChannelId]);
    }
    refreshActiveMembers();
  }
}

// onMemberRemove handles a member leaving / being removed. hadChannel (captured by
// the caller BEFORE the state fold) guards against double-handling a removal we did
// locally (leaveActiveChannel). Three cases: me as a non-admin losing a channel
// (reload the re-pointed active one), an admin losing membership on the active channel
// but keeping bypass access, or someone else leaving the channel I'm viewing.
function onMemberRemove(evt, hadChannel) {
  const { channel_id, user_id } = evt.payload;
  if (user_id === state.me.id) {
    if (hadChannel && !S.isAdmin(state.me)) {
      renderSidebarBadges();
      // removeChannel re-pointed activeChannelId; load the new active one.
      if (state.activeChannelId) loadChannel(state.activeChannelId);
    } else if (hadChannel && channel_id === state.activeChannelId) {
      // Admin lost membership on the active channel but keeps bypass access — hide
      // the leave button and re-fetch so the roster is accurate.
      $("#leave-btn").hidden = true;
      refreshActiveMembers();
    }
  } else if (channel_id === state.activeChannelId && activeMemberIds) {
    // Someone else left the channel I'm viewing — drop them from the roster now.
    activeMemberIds.delete(user_id);
    renderMembers();
  }
}

// onMessageEvent folds the DOM consequences of a message.new/update/delete. The
// unread/mention/ping POLICY is the pure classifyIncomingMessage (unread.js); this is
// only the side effects: a live delete earns a tombstone, the DM list re-sorts, the
// open channel repaints (a from-me send forces a jump to newest; sending while in a
// history window reloads), the read cursor/marker stays current while focused, and the
// unread/mention badges + ping chime fire.
function onMessageEvent(evt) {
  // A delete seen live earns a tombstone (unlike already-deleted history).
  if (evt.type === "message.delete") liveDeleted.add(evt.payload.id);
  const cid = evt.payload.channel_id;
  const ch = state.channels[cid];
  const active = cid === state.activeChannelId;
  const focused = !tabUnfocused();
  // The unread/mention/ping decision matrix is a pure function of state + event +
  // these three view booleans (see unread.js). isNewFromMe/Other come back too.
  const d = classifyIncomingMessage(state, evt, {
    active,
    focused,
    adminPanelOpen: !$("#admin-panel").hidden,
  });
  // applyEvent bumped last_message_at so the DM list stays sorted by recency;
  // reflect a DM I just sent (ch is post-fold, already current).
  if (d.isNewFromMe && ch && ch.is_dm) scheduleRender("dms");
  // applyEvent cleared the sender's typing entry on a message.new; repaint the indicator
  // (the append/patch fast-paths below don't touch it).
  if (active && evt.type === "message.new") scheduleRender("typing");
  if (active) {
    const viewingHistory = historyPaging.isViewingHistory(cid);
    if (d.isNewFromMe && viewingHistory) {
      // I sent while viewing a history window (below the live tail): reload the
      // channel so my message shows at the bottom in proper context, not appended
      // after a gap of unloaded messages.
      loadChannel(cid);
    } else if (evt.type === "message.new") {
      // New message at the live tail: append just this row — no full rebuild, so a
      // reader's text selection, in-flight images, and scroll all survive. Fall back
      // to a full render when we can't safely append: a secret view, a history
      // window, a system line, or a scrolled-up reader (who may need the "New
      // messages" divider drawn the way renderMessages does it).
      const m = (state.messages[cid] || []).find((x) => x.id === evt.payload.id);
      // My own send may already be on screen as an optimistic row — reconcile it
      // (replace the dimmed row in place) instead of appending a second copy.
      if (m && reconcileOptimistic(m)) {
        // handled: the optimistic row became the real one
      } else {
        const ml = $("#message-list");
        const nearBottom = !ml || isNearBottom(ml.scrollHeight, ml.scrollTop, ml.clientHeight);
        const canAppend = m && !m.is_system && !inSecretView(cid) && !viewingHistory && (d.isNewFromMe || nearBottom);
        if (canAppend) appendMessageRow(m, d.isNewFromMe); // mine forces a jump to the newest
        else renderMessages(d.isNewFromMe);
      }
    } else if (evt.type === "message.update" && patchMessageRow(evt.payload.id)) {
      // An edit or pin/unpin touches one row — swapped in place above.
    } else {
      renderMessages(); // message.delete (collapses runs), or a patch that didn't apply
    }
    refreshPinsIfOpen(); // a pin/unpin arrives as a message.update
    if (focused && d.isNewFromOther) {
      // You're looking right at it — keep the read cursor current. If the user is
      // scrolled up, plant the marker at the current read position so they see where
      // new messages begin when they scroll down.
      if (!unread.markerFor(cid)) {
        const ml = $("#message-list");
        if (ml && !isNearBottom(ml.scrollHeight, ml.scrollTop, ml.clientHeight)) {
          unread.pinMarkerIfUnset(cid, state.lastRead[cid]);
        }
      }
      markActiveChannelRead();
    }
  }
  // Raise the unread badge for a message I won't immediately see read, and separately
  // the mention badge so @-mentions stand out. (A message landing in a closed DM
  // resurfaces it server-side, arriving as a channel.new just before this event — so
  // the row is already back.)
  if (d.countUnread) {
    state = S.bumpUnread(state, cid);
    if (d.countMention) state = S.bumpMention(state, cid);
    scheduleRender("channels", "dms", "total");
  }
  // Chime + (if opted in) an OS notification for pings; plain channel chatter stays
  // silent with just the badge.
  if (d.ping) notifUI.firePing(evt, ch);
}

// onRealtimeConnChange paints the connection indicator and triggers a resync when
// the socket comes back after a genuine drop (a reconnect resumes only the *stream*
// of new events, so anything missed while dead is a gap resync closes).
function onRealtimeConnChange(online) {
  $("#conn-status").className = online ? "conn online" : "conn offline";
  $("#conn-status").title = online ? "Connected" : "Reconnecting…";
  if (online && wasOffline) resync();
  wasOffline = !online;
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
    notifUI.renderNotificationTotal();
    if (state.activeChannelId) {
      // Preserve scrollback: loadChannel reloads only the latest page and snaps to
      // the bottom (or unread marker), which would discard the older messages a
      // reader has paged in and yank them away from where they were reading. Only
      // reload when they're already at the live tail, where a refresh is invisible.
      // The resumed event stream keeps a scrolled-up reader current as they read.
      const ml = $("#message-list");
      const atTail = !ml || isNearBottom(ml.scrollHeight, ml.scrollTop, ml.clientHeight);
      if (atTail) {
        await loadChannel(state.activeChannelId);
        if (!tabUnfocused()) markActiveChannelRead();
      }
    }
    // A reconnect is a fresh connection (server defaults it to active); re-signal
    // idle over the new socket so the dot stays correct.
    if (isIdle) sendWS({ type: "idle", idle: true });
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ▌ REGION 4 · SIDEBAR & CHANNELS
// ▌ Everything left of the message pane: me/theme, the channel/DM/member lists,
// ▌ channel lifecycle (create/mute/leave/close/select), drag reordering, read
// ▌ state, and the channel header. Five sub-sections below.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// --- rendering ---------------------------------------------------------------

// Render batching. Event-driven repaints mark a SURFACE dirty and coalesce into a
// single paint on the next task, instead of every inbound WS frame rebuilding every
// surface synchronously (one message used to fire renderMessages + renderChannels +
// renderDMs + the title total, each a full innerHTML rebuild). Only the realtime
// handlers route through here; the synchronous load/jump/scroll paths (loadChannel,
// jumpToMessage, resync, selectChannel) keep calling the render fns DIRECTLY — they
// measure scroll right after painting and must not be deferred.
//
// The flush runs on a 0ms timer, NOT requestAnimationFrame: rAF is paused while the
// tab is hidden, but the unread total in the document title must keep climbing in a
// backgrounded tab. A 0ms timer fires either way and still collapses a burst — every
// frame in the burst marks its surfaces and finds the flush already scheduled.
const RENDER_SURFACES = {
  channels: () => renderChannels(),
  dms: () => renderDMs(),
  members: () => renderMembers(),
  me: () => renderMe(),
  total: () => notifUI.renderNotificationTotal(),
  typing: () => renderTypingIndicator(),
  messages: () => renderMessages(), // FULL rebuild, default args (holds scroll position)
};
const dirtySurfaces = new Set();
let renderFlushPending = false;
function scheduleRender(...surfaces) {
  for (const s of surfaces) dirtySurfaces.add(s);
  if (renderFlushPending) return;
  renderFlushPending = true;
  setTimeout(flushRenders, 0);
}
function flushRenders() {
  renderFlushPending = false;
  const due = dirtySurfaces;
  // Fixed order, deterministic; a render fn re-scheduling lands in a fresh batch.
  for (const key of Object.keys(RENDER_SURFACES)) {
    if (due.has(key)) RENDER_SURFACES[key]();
  }
  due.clear();
}

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

// channelRowClass is the shared class string for a sidebar row (regular channel or
// DM): active/unread/muted modifiers on the base "channel" class.
function channelRowClass(id, active, unread) {
  return "channel" + (active ? " active" : "") + (unread ? " unread" : "") + (S.isMuted(state, id) ? " muted" : "");
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
    const cls = channelRowClass(id, active, unread);
    const roster = voiceUI.rosterFor(id);
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
    const cls = channelRowClass(id, active, unread);
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
  const callIds = voiceUI.callCueIds(state.activeChannelId);
  users.sort((a, b) => {
    if (!!b.online !== !!a.online) return b.online ? 1 : -1;
    return a.display_name.localeCompare(b.display_name);
  });
  for (const u of users) {
    const isSelf = u.id === state.me.id;
    const presence = presenceLabel(u);
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
    const speaking = onCall && voiceUI.isSpeaking(u.id);
    // Per-user volume slider: only for remote participants on our current call
    // (their <audio> element exists only then). Adjusts that one person's
    // playout level (voice.js setVolumeForUser), persisted across calls.
    const volume = onCall && !isSelf ? voiceUI.volumeSlider(u) : null;
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

// renderSidebarBadges repaints the three surfaces that reflect unread/mention
// counts (and channel membership): the channel-list rows, the DM rows, and the
// global notification total in the title/sidebar badge. It's the trio every
// count- or membership-changing path fires together; unlike rerenderSidebar it
// leaves the members panel alone (a count change never touches the roster).
function renderSidebarBadges() {
  renderChannels();
  renderDMs();
  notifUI.renderNotificationTotal();
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
// Placement: NOT load-order-pinned — its bag is all hoisted fns/arrows, so it
// could legally live in R8's switchboard. It stays here, next to renderChannels
// (its only caller), on purpose: cohesion beats symmetry. See docs/atlas.md.
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
  renderSidebarBadges();
  try {
    if (wasMuted) await api.unmuteChannel(id);
    else await api.muteChannel(id);
  } catch (ex) {
    state = S.setMuted(state, id, wasMuted); // revert
    renderSidebarBadges();
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
  await guard(async () => {
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
      renderSidebarBadges();
      if (state.activeChannelId) await loadChannel(state.activeChannelId);
    }
  });
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
  safeLocalSet(ACTIVE_CHANNEL_KEY, id);
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
  renderSidebarBadges();
  voiceUI.resetVideoView(); // clear any mobile chat-override + repaint the grid
  closeDrawers(); // on mobile, reveal the conversation after a pick
  await loadChannel(id);
  imageWarm.startBackgroundImageWarm(); // reprioritizes from the new active channel outward
  // Restore any saved draft and attachments for this channel.
  const composerInput = $("#composer-input");
  composerInput.value = drafts.restoreText(id);
  composerRich?.highlight();     // decorate the restored draft's markdown
  composerRich?.resetHistory();  // undo baseline = this channel's draft (no cross-channel undo)
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
    scheduleRender("channels", "dms", "total");
  }
  if (unread.alreadyMarked(cid, newest)) return; // server already knows
  unread.recordMarked(cid, newest);
  state = S.setLastRead(state, cid, newest);
  refreshReadMarks(); // update 👁 titles in place — no full rebuild, so selection survives
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
      renderSidebarBadges();
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
    renderSidebarBadges();
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

// applyChannelAffordances sets the header-adjacent controls whose visibility is a
// pure function of the channel being opened: the invite/leave/pins buttons and the
// body.dm-active class (which collapses the members column for a 1:1 DM). Shared by
// loadChannel and jumpToMessage, the two paths that switch the open channel. The
// leave button here is the coarse first pass (realPrivate only); refreshActiveMembers
// → updateLeaveBtn refines it for the admin-non-member bypass case afterward.
function applyChannelAffordances(ch) {
  const realPrivate = !!(ch && ch.is_private && !ch.is_dm);
  $("#invite-btn").hidden = !realPrivate || !isModPlus();
  $("#leave-btn").hidden = !realPrivate;
  $("#pins-btn").hidden = !ch;
  document.body.classList.toggle("dm-active", !!(ch && ch.is_dm));
}

// renderChannelHeader repaints the top bar for the active channel. DMs and regular
// channels share almost nothing up there (DM: presence dot, call/secret buttons,
// partner-volume; regular: join-voice button, editable topic), so each has its own
// builder; this just dispatches. A null ch (nothing selected) is the regular path.
function renderChannelHeader(ch) {
  if (ch && ch.is_dm) { renderDMHeader(ch); return; }
  renderRegularHeader(ch);
}

function renderDMHeader(ch) {
  const topicEl = $("#channel-topic");
  const callBtn = $("#call-btn");
  const secretBtn = $("#secret-btn");
  $("#channel-title").textContent = "@ " + dmDisplayName(state, ch);
  topicEl.textContent = "";
  topicEl.classList.remove("editable", "placeholder");
  topicEl.removeAttribute("title");
  const otherId = S.otherDMParticipant(ch, state.me && state.me.id);
  const other = otherId && state.users[otherId];
  const dmDot = $("#channel-dm-dot");
  dmDot.className = `dot ${other ? presenceClass(other) : "offline"}`;
  dmDot.hidden = false;
  // On-call cue: the member roster (which carries the 🔊 cue elsewhere) is
  // hidden in DM view, so surface "the other person is connected to this call"
  // here in the header — the analog of the DM presence dot for call state.
  const otherOnCall = !!(voiceUI.inCallOn(ch.id) && otherId && voiceUI.isParticipant(otherId));
  $("#channel-dm-call").hidden = !otherOnCall;
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
  // Self-DM scratch pad — and bot DMs (bots can't take calls or do E2E key
  // exchange) — make calling/secret-chat meaningless: hide both buttons.
  const isSelfDM = otherId === (state.me && state.me.id);
  const otherIsBot = !!(other && other.is_bot);
  if (isSelfDM || otherIsBot) {
    callBtn.hidden = true;
    secretBtn.hidden = true;
  } else {
    // Show/update the call button for DM channels.
    const rs = voiceUI.getRingState();
    if (rs && rs.channelId === ch.id && rs.direction === "incoming") {
      callBtn.textContent = "✅";
      callBtn.title = "Answer call";
    } else if (rs && rs.channelId === ch.id && rs.direction === "outgoing") {
      callBtn.textContent = "📵";
      callBtn.title = "Cancel call";
    } else if (voiceUI.inCallOn(ch.id)) {
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
  if (voiceUI.inCallOn(ch.id)) {
    const hasVideo = voiceUI.anyVideoPresent();
    if (hasVideo || voiceUI.isVideoViewHidden()) {
      voiceUI.applyHeaderCamLabel(headerCamBtn);
      headerCamBtn.hidden = false;
    } else {
      headerCamBtn.hidden = true;
    }
  } else {
    headerCamBtn.hidden = true;
  }
  // Desktop screen-share button (CSS hides it on touch layouts): shown while in
  // this DM's call. Mutually exclusive with the camera at the engine level.
  voiceUI.applyHeaderShareBtn($("#header-share-btn"), ch.id);
}

function renderRegularHeader(ch) {
  const topicEl = $("#channel-topic");
  const callBtn = $("#call-btn");
  $("#channel-dm-dot").hidden = true;
  $("#channel-dm-call").hidden = true;
  $("#secret-btn").hidden = true;
  $("#header-camera-btn").hidden = true;
  $("#dm-volume").hidden = true;
  dmVolumeChannelId = null; dmVolumeOpen = false;
  if (ch && !ch.is_dm) {
    if (voiceUI.inCallOn(ch.id)) {
      callBtn.textContent = "🔴";
      callBtn.title = "Leave voice";
      // Same mobile-only 💬/📺 chat↔video toggle as DM calls, but for a group
      // video call: shown once any participant (us or a peer) has a camera on.
      const headerCamBtn = $("#header-camera-btn");
      const groupHasVideo = voiceUI.anyVideoPresent();
      if (groupHasVideo || voiceUI.isVideoViewHidden()) {
        voiceUI.applyHeaderCamLabel(headerCamBtn);
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
  // Desktop screen-share button: available in a group voice call too (CSS hides it
  // on touch layouts). Hidden when not in this channel's call.
  voiceUI.applyHeaderShareBtn($("#header-share-btn"), ch ? ch.id : null);
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ▌ REGION 5 · MESSAGE PANE
// ▌ The message list itself: paging/history (drives historyPaging),
// ▌ renderMessages and the row builders + edit-state capture/restore, and the
// ▌ reply banner. The densest DOM+state knot in the file.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// --- message loading, history & scrolling ------------------------------------

async function loadChannel(id) {
  // The pane is about to be rebuilt — drop any optimistic rows tracked for the
  // channel we're leaving (their DOM is wiped; the entries would only dangle).
  clearPendingSends();
  // Startup path calls loadChannel directly without selectChannel, so the divider
  // may not be set yet — seed it from the live cursor only when there are actual
  // unreads (same rule as selectChannel; idempotent).
  unread.seedMarker(id, state.unread[id] || state.mentions[id], state.lastRead[id]);
  const ch = state.channels[id];
  renderChannelHeader(ch);
  renderSecretBanner();
  // Invite/leave/pins buttons + the dm-active members-column collapse (see helper).
  applyChannelAffordances(ch);
  // Reset scroll/history flags immediately so sentinels can't fire while in-flight.
  historyPaging.resetForChannel(id);
  historyPaging.renderHistoryBanner();
  try {
    const [, msgs] = await Promise.all([refreshActiveMembers(), api.messages(id, { limit: PAGE })]);
    if (id !== state.activeChannelId) return; // user switched away while fetching
    state = S.setMessages(state, id, msgs);
    pruneLiveDeleted(); // GC session tombstones no longer in any loaded window
    // A short first page means there's nothing older to scroll back to.
    historyPaging.noteLoadedPage(id, msgs.length);
    // Use holdPosition so scrollToBottom's rAF callbacks don't fire and
    // override the unread-marker scroll. We control the final position here.
    renderMessages(false, true);
    if (!scrollToUnreadMarker()) {
      // No unread marker (channel was caught up): pin to the newest message.
      // Use scrollToBottom, not a bare scrollTop assignment: images carry no
      // intrinsic height (CSS max-height only), so the ones near the bottom
      // reserve ~0 space until they decode — which on the open/reload path
      // happens *after* this pin. scrollToBottom re-pins across rAF frames and
      // on each late <img> load (while the reader hasn't scrolled away), so the
      // view stays glued to the newest message as those images expand instead
      // of stranding the reader a page up. (holdPosition above kept this same
      // re-pin from running during renderMessages and clobbering the
      // unread-marker scroll; here, with no marker, bottom-pinning is the goal.)
      scrollToBottom($("#message-list"));
    }
    renderTypingIndicator(); // reset indicator for the newly opened channel
  } catch (ex) {
    if (id !== state.activeChannelId) return;
    $("#message-list").innerHTML = "";
    $("#message-list").append(el("div", { class: "notice" }, ex.message));
  }
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
    safeLocalSet(ACTIVE_CHANNEL_KEY, channelId);
    state = S.clearUnread(state, channelId);
    state = S.clearMention(state, channelId);
    renderSidebarBadges();
    closeDrawers();
    const ch = state.channels[channelId];
    renderChannelHeader(ch);
    applyChannelAffordances(ch);
    await refreshActiveMembers();
  }
  try {
    const msgs = await api.messages(channelId, { around: messageId });
    if (channelId !== state.activeChannelId) return; // user switched away while fetching
    state = S.setMessages(state, channelId, msgs);
    historyPaging.clearHistoryComplete(channelId);
    // Assume history until a forward probe proves otherwise. The around-window
    // only loads a partial page after the anchor, so the live tail — and, in a
    // brief conversation, the last few messages — may be missing.
    historyPaging.markViewingHistory(channelId);
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
    await historyPaging.loadNewerMessages();
    historyPaging.renderHistoryBanner();
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

// Infinite-scroll paging (the two zero-height sentinels renderMessages places at
// the top/bottom of the list) and the scrollToBottom pin both live in history.js.
// observeScrollSentinels is reached through `historyPaging`; scrollToBottom is a
// free import (pure DOM, no paging state).

// --- message rendering -------------------------------------------------------
//
// MAP. renderMessages is the orchestrator; everything else in this section is a
// builder it composes. The whole section is a *projection* of module state onto
// #message-list — it reads app state, never writes it (the one exception:
// captureEditState stashes the live draft into editDraft so an in-flight inline
// edit survives the innerHTML wipe). This is why it resists extraction: it depends
// on a wide slice of live state but owns none of it. Don't carve it to a file;
// keep it legible here. (docs/atlas.md, R5.)
//
//   renderMessages(forceBottom, holdPosition)          // full rebuild of the pane
//     ├─ captureEditState(wrap) ──────────────┐        // snapshot inline edit…
//     │   wrap.innerHTML = ""                  │
//     ├─ renderSecretView(...)   ←OR→  message loop     // OTR view vs server history
//     │                                        │
//     │   message loop, per item:              │
//     │     • renderDeletedRun     (collapsed "N deleted", live ids only)
//     │     • renderSystemMessage   (joins / topic changes)
//     │     • "New messages" divider  (shouldInsertUnreadMarker · unread.markerFor)
//     │     • messageRow(m, {grouped, isMod, canPin})   // grouped = shouldGroupMessage
//     │         ├─ buildReplyQuote(m)                   // quoted-reply header
//     │         ├─ reactionsRow(m)                      // NB: defined in R6 (`mine` rule)
//     │         └─ messageActions(m, {…})               // hover edit/forward/pin/del/read
//     ├─ scroll sentinels → historyPaging.observeScrollSentinels   // infinite scroll
//     ├─ atBottom ? scrollToBottom(wrap) : wrap.scrollTop = prevTop // follow vs hold
//     └─ restoreEditState(wrap, snap) ────────┘        // …re-focus + caret after rebuild
//
// State read: state.{channels, messages, me, typing}, the inline-edit trio
// (editingMessageId / editDraft / editFocusPending), liveDeleted, the unread cursor
// (unread.markerFor), and the per-DM secret session (getSession).
// renderTypingIndicator stands apart — it paints #typing-indicator alone, driven by
// typing.update; it isn't part of the renderMessages rebuild. Entries carry the typer's
// last-refresh time; S.activeTypers drops any past S.TYPING_TTL_MS, so a stale entry
// (a missed active:false after a socket drop) can't leave a phantom typer on screen.

let typingExpiryTimer = null;
function renderTypingIndicator() {
  const el = $("#typing-indicator");
  if (!el) return;
  if (typingExpiryTimer) { clearTimeout(typingExpiryTimer); typingExpiryTimer = null; }
  const now = Date.now();
  const cid = state.activeChannelId;
  const live = S.activeTypers(state, cid, now).filter((uid) => Number(uid) !== state.me?.id);
  // Arm a one-shot repaint for when the soonest live entry ages out, so a stopped typer
  // clears even with no further frames. Only for live entries — a lingering stale entry
  // must not spin an endless timer.
  if (live.length) {
    const typers = state.typing[cid] || {};
    const soonest = Math.min(...live.map((uid) => typers[uid] + S.TYPING_TTL_MS));
    typingExpiryTimer = setTimeout(renderTypingIndicator, Math.max(0, soonest - now) + 20);
  }
  const names = live
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
  const atBottom = !holdPosition && (forceBottom || isNearBottom(wrap.scrollHeight, wrap.scrollTop, wrap.clientHeight));
  const prevTop = wrap.scrollTop; // clearing innerHTML resets scrollTop; restore it below
  // Capture an in-progress inline edit before innerHTML wipes the textarea, so a
  // re-render triggered by an incoming event keeps the draft, caret, and focus
  // (restoreEditState re-establishes it after the rebuild, below).
  const editRestore = captureEditState(wrap);
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
    renderSecretView(wrap, secretSess, atBottom, prevTop);
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
    // Deleted run: collapse consecutive deletions. renderDeletedRun returns the
    // index past the run and whether it drew a tombstone — a drawn tombstone breaks
    // grouping; an invisible run (no live deletions) doesn't.
    if (msgs[i].deleted_at) {
      const run = renderDeletedRun(wrap, msgs, i);
      if (run.drew) { lastUser = null; lastTime = 0; }
      i = run.next;
      continue;
    }

    const m = msgs[i];

    // System line (joins, topic changes): no author gutter, always breaks grouping.
    if (m.is_system) {
      renderSystemMessage(wrap, m);
      lastUser = null;
      lastTime = 0;
      i++;
      continue;
    }

    // Insert the "New messages" divider before the first message that is newer
    // than the read cursor captured when this channel was opened (the decision is
    // the pure shouldInsertUnreadMarker; the loop keeps markerInserted).
    if (shouldInsertUnreadMarker(markerInserted, markerAt, m.id)) {
      markerInserted = true;
      wrap.append(el("div", { class: "unread-marker" },
        el("span", { class: "unread-marker-label" }, "New messages")));
    }

    const t = new Date(m.created_at).getTime();
    // Grouping (same author, within the window, non-reply) is a pure decision —
    // see shouldGroupMessage in format.js. The loop keeps the lastUser/lastTime
    // accumulators (reset by dividers/system/tombstones above, which break a run).
    const grouped = shouldGroupMessage(lastUser, lastTime, m, t);
    lastUser = m.user_id;
    lastTime = t;
    wrap.append(messageRow(m, { grouped, isMod, canPin }));
    i++;
  }
  // Zero-height sentinels at each end drive infinite scroll via IntersectionObserver
  // (see observeScrollSentinels). They're re-created every render, so rebind each time.
  const topSentinel = el("div", { class: "scroll-sentinel", "data-sentinel": "top" });
  const bottomSentinel = el("div", { class: "scroll-sentinel", "data-sentinel": "bottom" });
  wrap.prepend(topSentinel);
  wrap.append(bottomSentinel);
  historyPaging.observeScrollSentinels(topSentinel, bottomSentinel);
  // Follow the conversation when already at the bottom; otherwise hold the
  // reader's position (loadOlderMessages adjusts further for prepended history).
  if (atBottom) scrollToBottom(wrap);
  else wrap.scrollTop = prevTop;
  // Re-establish the inline editor's size, focus, and caret after the rebuild.
  restoreEditState(wrap, editRestore);
}

// renderDeletedRun collapses a run of consecutive deleted messages starting at
// `start`. Only messages deleted live this session (liveDeleted) earn a visible
// "N deleted" tombstone; a run that arrived already-deleted from history renders
// nothing — so a reopened channel isn't littered with old tombstones. Returns the
// index past the run and whether a tombstone was drawn (the caller resets grouping
// only when one was — an invisible run must not break a group).
function renderDeletedRun(wrap, msgs, start) {
  let j = start;
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
  }
  return { next: j, drew: live > 0 };
}

// renderSystemMessage appends a centered system line (joins, topic changes, …):
// text + time, no author gutter. The caller breaks the grouping run around it.
function renderSystemMessage(wrap, m) {
  wrap.append(el("div", { class: "msg msg-system", "data-msg-id": m.id },
    el("span", { class: "msg-system-text" }, m.content),
    el("span", { class: "msg-system-time" }, formatTime(m.created_at))));
}

// captureEditState snapshots an in-progress inline edit before renderMessages wipes
// innerHTML: it stashes the live draft into editDraft (so the text survives the
// rebuild) and returns the focus + caret state for restoreEditState to re-apply.
// Returns null when nothing is being edited or the editor isn't in the DOM yet.
function captureEditState(wrap) {
  if (editingMessageId == null) return null;
  const live = wrap.querySelector(".msg-edit-input");
  if (!live) return null;
  editDraft = live.value;
  return { focused: document.activeElement === live, start: live.selectionStart, end: live.selectionEnd };
}

// restoreEditState re-sizes the rebuilt inline editor and restores focus + caret
// after a re-render. A freshly opened editor (editFocusPending) takes focus with the
// caret at the end; an editor that merely survived an incidental re-render restores
// the snapshot if it had focus. Always clears editFocusPending. If the edited
// message is gone (e.g. a mod deleted it mid-edit) there's nothing to restore.
function restoreEditState(wrap, snap) {
  if (editingMessageId == null) return;
  const ta = wrap.querySelector(".msg-edit-input");
  if (ta) {
    autoGrowEdit(ta);
    if (editFocusPending) {
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    } else if (snap && snap.focused) {
      ta.focus();
      ta.setSelectionRange(snap.start, snap.end);
    }
  }
  editFocusPending = false;
}

// renderSecretView paints the in-memory encrypted message list for an active or
// ended OTR secret session (state.js holds none of it — secret.js owns it). The
// caller early-returns on inSecretView; this owns the composer enable/placeholder
// and final scroll restore for that mode.
function renderSecretView(wrap, secretSess, atBottom, prevTop) {
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
}

// embedRemoveButton builds the author-only "remove embed" control (a light ×) shown
// on a preview card or a bare-URL inline image. Clicking edits the message to wrap
// `url` in <> so the embed/image collapses to a plain link. preventDefault keeps the
// surrounding anchor (the image link / og card) from activating the same click.
function embedRemoveButton(m, url) {
  return el("button", {
    class: "embed-remove",
    title: "Remove embed",
    "aria-label": "Remove embed",
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); removeEmbed(m, url); },
  }, "×");
}

// removeEmbed persists the <wrap> edit (the embed-suppressing rewrite); the resulting
// message.update broadcast re-renders the row without the embed. A no-op rewrite
// (URL not found bare) does nothing.
function removeEmbed(m, url) {
  const next = suppressEmbedURL(m.content, url);
  if (next === m.content) return;
  guard(() => api.editMessage(m.id, next));
}

// embedURLFor returns the URL of the message's primary embed (preview card, else the
// first bare-URL inline image) — the one a "remove embed" action would <wrap> — or
// null when the message shows no removable embed. The desktop affordance attaches a
// button per visible embed directly; this single-URL view is for the mobile
// long-press sheet. buildLinkPreview is idempotent (the row already warmed its cache).
function embedURLFor(m) {
  const card = buildLinkPreview(m.content);
  if (card) return extractHideURL(m.content, location.origin) || card._previewUrl || null;
  const bare = extractFirstBareURL(m.content);
  return bare && isImageURL(bare) ? bare : null;
}

// decorateImageEmbeds adds the author "remove embed" × to each bare-URL inline image
// in a freshly built body — the .msg-image-url anchors format.js tags. Uploaded blob
// images (![](…) markdown) are untagged and skipped: there's no URL to wrap. The
// anchor becomes the positioning host for its overlay button.
function decorateImageEmbeds(body, m) {
  body.querySelectorAll("a.msg-image-url").forEach((a) => {
    const url = a.getAttribute("href");
    if (!url) return;
    a.classList.add("embed-host");
    a.append(embedRemoveButton(m, url));
  });
}

// messageActions builds the hover action row for one message. React and Reply are
// always present; Forward hides on a tombstone; Edit/Pin/Delete are gated by the
// ownership/role flags the caller computed (isOwn/canPin/canDelete).
function messageActions(m, { isOwn, canPin, canDelete, isRead }) {
  return el("div", { class: "msg-actions" },
    el("button", { class: "msg-act", title: "Add reaction",
      onclick: (e) => { e.stopPropagation(); emojiPicker.openForReaction(m.id, e.currentTarget); } }, "😄"),
    el("button", { class: "msg-act", title: "Reply", onclick: () => startReply(m) }, "↩"),
    !m.deleted_at ? el("button", { class: "msg-act", title: "Forward to another channel", onclick: () => openForwardModal(m) }, "↗") : null,
    el("button", { class: "msg-act msg-read-toggle", title: isRead ? "Mark unread" : "Mark read", onclick: () => toggleMessageRead(m) }, "👁"),
    isOwn ? el("button", { class: "msg-act", title: "Edit", onclick: () => startEdit(m) }, "✏") : null,
    canPin ? el("button", { class: "msg-act", title: m.pinned_at ? "Unpin" : "Pin", onclick: () => togglePin(m) }, "📌") : null,
    canDelete ? el("button", { class: "msg-act danger", title: "Delete", onclick: () => deleteMessage(m) }, "🗑") : null);
}

// messageRow builds one rendered message element — the grouped (continuation,
// avatarless) or full (avatar + author header) shape, with reply quote, link
// preview, reactions, and the hover action row. While this message is being edited
// inline (m.id === editingMessageId) the body becomes the editor and the
// quote/preview/reactions/actions are suppressed. isMod/canPin are computed once
// per render by the caller and threaded through. `pending` marks an optimistic row
// (a just-sent message not yet acked by the server): it dims the row, shows
// "sending…" for the time, and suppresses the interactive affordances (actions,
// reactions, link-preview fetch, permalink) until the real message.new echo
// reconciles it (see showOptimisticSend / reconcileOptimistic).
function messageRow(m, { grouped, isMod, canPin, pending = false }) {
  const editing = m.id === editingMessageId;
  // Interactive affordances only on a real, non-editing row. A pending row keeps its
  // reply quote (already known) but skips actions/reactions/preview-fetch/permalink.
  const interactive = !editing && !pending;
  const replyQuote = editing ? null : buildReplyQuote(m);
  const rawPreview = interactive ? buildLinkPreview(m.content) : null;
  const hideUrl = rawPreview
    ? (extractHideURL(m.content, location.origin) || rawPreview._previewUrl || null)
    : null;
  const mentionsMe = m.user_id !== state.me.id &&
    (mentionsUser(m.content, state.me.username) || m.reply_to_user_id === state.me.id);

  const isOwn = m.user_id === state.me.id;
  // Author-only "remove embed" affordance: a light × on the preview card (and on each
  // bare-URL inline image) that edits the post to <wrap> the URL, suppressing the
  // embed. The button is appended INTO the card/image element (its own .embed-host
  // positioning box) — not a wrapper — so the embed's outer margin can't push the ×
  // into the gap above it. The card's URL is hideUrl; image URLs are decorated after
  // the body HTML is built (see decorateImageEmbeds). Non-authors / pending get none.
  const preview = rawPreview;
  if (preview && isOwn && hideUrl) {
    preview.classList.add("embed-host");
    preview.append(embedRemoveButton(m, hideUrl));
  }
  const body = editing
    ? editorFor(m)
    : el("div", { class: "msg-body", html: formatMessage(m.content, state.me.username, state.emojis, { hideUrl, channels: state.channels, users: state.users }) + (m.edited_at ? ' <span class="edited">(edited)</span>' : "") });
  if (interactive && isOwn) decorateImageEmbeds(body, m);
  const canDelete = isOwn || isMod; // non-mods can only delete their own
  // Anyone who can see a message can react to it, so "react" is always present;
  // edit/pin/delete stay conditional (see messageActions).
  const isRead = m.id <= (state.lastRead[state.activeChannelId] || 0);
  const rowActions = interactive ? messageActions(m, { isOwn, canPin, canDelete, isRead }) : null;
  const reactions = interactive ? reactionsRow(m) : null;
  const pinMark = m.pinned_at ? el("span", { class: "pin-mark", title: "Pinned" }, "📌") : null;
  let cls = "msg";
  if (m.pinned_at) cls += " pinned";
  if (mentionsMe) cls += " mentioned";
  if (pending) cls += " pending";
  if (m.id === flashMessageId) cls += " msg-anchor"; // jumped-to highlight, applied each render

  const timeEl = pending
    ? el("span", { class: "msg-time msg-time-pending", title: "Sending…" }, "sending…")
    : el("a", {
        class: "msg-time",
        href: permalinkHash(state.activeChannelId, m.id),
        title: "Permalink",
        onclick: (e) => { e.preventDefault(); jumpToMessage(state.activeChannelId, m.id); },
      }, formatTime(m.created_at));

  if (grouped) {
    return el("div", { class: cls + " grouped", "data-msg-id": m.id }, el("div", { class: "msg-gutter" }, pinMark), el("div", { class: "msg-main" }, replyQuote, body, preview, reactions, rowActions));
  }
  // Clicking the avatar or name opens the author's profile card.
  const author = state.users[m.user_id];
  const openCard = author ? () => openUserCard(author.id) : null;
  const avatarAttrs = author
    ? { class: "msg-avatar clickable", title: "View profile", onclick: openCard }
    : { class: "msg-avatar" };
  const avatar = author && author.has_avatar
    ? el("div", { ...avatarAttrs, style: `background-image:url(${avatarSrc(author.id)})` })
    : el("div", avatarAttrs, initials(author ? author.display_name : "?"));
  return el("div", { class: cls, "data-msg-id": m.id },
    avatar,
    el("div", { class: "msg-main" },
      el("div", { class: "msg-head" },
        el("span", author
          ? { class: "msg-author clickable", title: "View profile", onclick: openCard }
          : { class: "msg-author" }, author ? author.display_name : "unknown"),
        timeEl,
        pinMark
      ),
      replyQuote,
      body,
      preview,
      reactions,
      rowActions
    )
  );
}

// --- incremental message updates ---------------------------------------------
//
// The full renderMessages above wipes #message-list and rebuilds every loaded row
// (re-running formatMessage + buildLinkPreview on each). That's correct but wipes
// any active text selection, reflows in-flight images, and is O(N) per event. The
// helpers below patch the ONE row an event actually touched — the fast path the
// realtime handlers prefer, falling back to a full render when a row can't be
// surgically updated. Every row carries data-msg-id, so targeting is cheap.

// inSecretView reports whether `channelId` is showing the in-memory OTR transcript
// (an active or ended secret session) rather than server history — the modes where
// these incremental paths don't apply (secret.js owns that DOM; renderMessages
// routes them to renderSecretView).
function inSecretView(channelId) {
  const ch = state.channels[channelId];
  const sess = ch && ch.is_dm ? getSession(channelId) : null;
  return !!(sess && (sess.phase === "active" || sess.phase === "ended"));
}

// groupingAnchor returns the {user, time} the message at msgs[idx] would group
// under, mirroring renderMessages' run-breaking rules: a system line or a DRAWN
// tombstone (a live-deleted message) resets grouping; an invisible deleted run is
// transparent. null when nothing groupable precedes it. appendMessageRow uses it so
// a single appended row gets the same grouped/full shape the full rebuild would.
function groupingAnchor(msgs, idx) {
  for (let k = idx - 1; k >= 0; k--) {
    const p = msgs[k];
    if (p.is_system) return null;
    if (p.deleted_at) {
      if (liveDeleted.has(p.id)) return null; // a drawn tombstone breaks the run
      continue;                               // an invisible deleted run is transparent
    }
    return { user: p.user_id, time: new Date(p.created_at).getTime() };
  }
  return null;
}

// insertionPointFor returns the DOM node a real row for msgs[idx] should be inserted
// BEFORE so the pane stays in array order. It walks the array forward from idx to the
// next loaded message that has a rendered row, falling back to the first pending
// optimistic row, then the bottom sentinel. The pending fallback is load-bearing:
// optimistic rows live at the DOM tail but NOT in state.messages (showOptimisticSend),
// so a real row appended/reconciled blindly at the tail would land BELOW your pending
// row — and then group avatarless under it, mis-attributing another user's message to
// you (and scrambling order once the echo reconciles). Slotting real rows ABOVE the
// pending tail keeps DOM order == array order, so the array-based grouping anchor is
// computed against the row's true DOM predecessor. Guarded by web/e2e/optimistic-send.
function insertionPointFor(wrap, msgs, idx) {
  for (let k = idx + 1; k < msgs.length; k++) {
    const node = wrap.querySelector(`[data-msg-id="${msgs[k].id}"]`);
    if (node) return node;
  }
  return wrap.querySelector(".msg.pending") || wrap.querySelector('[data-sentinel="bottom"]');
}

// appendMessageRow adds ONE freshly-arrived message to the open pane without
// rebuilding it — the incremental path for message.new at the live tail. It mirrors
// renderMessages' per-row decisions (grouping, isMod/canPin) and follow-scroll
// (atBottom OR forceBottom → stick to the newest). The row goes at its array-sorted
// DOM slot via insertionPointFor — above any pending optimistic rows and before the
// bottom sentinel — so infinite-scroll keeps working AND a cross-user message can't
// land below your DOM-only pending row. Callers guarantee the pane is rendered, not in
// secret view, not in a history window, and the message is a normal row.
function appendMessageRow(m, forceBottom) {
  const wrap = $("#message-list");
  const atBottom = forceBottom || isNearBottom(wrap.scrollHeight, wrap.scrollTop, wrap.clientHeight);
  const msgs = state.messages[state.activeChannelId] || [];
  const idx = msgs.findIndex((x) => x.id === m.id);
  const isMod = S.canModerate(state.me);
  const activeCh = state.channels[state.activeChannelId];
  const canPin = isMod || !!(activeCh && activeCh.is_dm);
  const anchor = groupingAnchor(msgs, idx);
  const t = new Date(m.created_at).getTime();
  const grouped = anchor ? shouldGroupMessage(anchor.user, anchor.time, m, t) : false;
  const row = messageRow(m, { grouped, isMod, canPin });
  const before = insertionPointFor(wrap, msgs, idx);
  if (before) wrap.insertBefore(row, before);
  else wrap.append(row);
  if (atBottom) scrollToBottom(wrap);
}

// patchMessageRow replaces a SINGLE rendered message in place — the incremental path
// for reaction.update and message.update (edit / pin). Returns false (caller falls
// back to a full render) when it isn't a clean 1:1 swap: the row isn't currently
// rendered (paged out), it's mid inline-edit, or it's now a system/deleted row (a
// delete collapses runs). Grouping is read off the existing row — neighbors are
// unchanged, so the grouped/full shape is preserved.
function patchMessageRow(messageId) {
  const wrap = $("#message-list");
  const existing = wrap.querySelector(`[data-msg-id="${messageId}"]`);
  if (!existing) return false;
  if (messageId === editingMessageId) return false;
  const msgs = state.messages[state.activeChannelId] || [];
  const m = msgs.find((x) => x.id === messageId);
  if (!m || m.is_system || m.deleted_at) return false;
  const isMod = S.canModerate(state.me);
  const activeCh = state.channels[state.activeChannelId];
  const canPin = isMod || !!(activeCh && activeCh.is_dm);
  const grouped = existing.classList.contains("grouped");
  // A reaction pill row makes the replacement taller; re-pin to the bottom if the
  // viewer was there (mirrors appendMessageRow), so the content above scrolls up to
  // make room instead of the reacted row pushing the viewport down.
  const atBottom = isNearBottom(wrap.scrollHeight, wrap.scrollTop, wrap.clientHeight);
  existing.replaceWith(messageRow(m, { grouped, isMod, canPin }));
  if (atBottom) scrollToBottom(wrap);
  return true;
}

// refreshReadMarks updates the 👁 toggle's title on rendered rows after the read
// cursor advances — a targeted alternative to a full renderMessages whose ONLY
// visible effect there is that tooltip (toggleMessageRead recomputes read state
// from state.lastRead at click time, so a stale title is never acted on). Keeping
// this off the full-render path is what lets a focused reader's text selection
// survive each incoming message.
function refreshReadMarks() {
  const wrap = $("#message-list");
  if (!wrap) return;
  const cursor = state.lastRead[state.activeChannelId] || 0;
  for (const btn of wrap.querySelectorAll(".msg-read-toggle")) {
    const row = btn.closest("[data-msg-id]");
    if (!row) continue;
    const isRead = Number(row.getAttribute("data-msg-id")) <= cursor;
    btn.title = isRead ? "Mark unread" : "Mark read";
  }
}

// Optimistic send. On Enter we paint the message at the live tail immediately —
// before the server round-trips — as a dimmed "pending" row, so sending feels
// instant on a slow link. The row carries a NEGATIVE temp id (can't collide with a
// server id) and is tracked in pendingSends until its own message.new echo arrives:
// reconcileOptimistic then REPLACES the dimmed row with the real one in place (no
// duplicate, no jump). A failed POST rolls the row back (removePending) and restores
// the composer. A channel switch wipes the pane, so clearPendingSends drops the
// now-detached entries. Only used at the live tail (not a history window or secret
// view — those keep the existing reload/secret paths). Guarded by
// web/e2e/optimistic-send.spec.js.
let optimisticSeq = -1;
const pendingSends = []; // { tempId, channelId, content, el } awaiting the message.new echo

function showOptimisticSend(channelId, content, replyId) {
  const tempId = optimisticSeq--;
  let replyToUserId = null;
  if (replyId != null) {
    const parent = (state.messages[channelId] || []).find((x) => x.id === replyId);
    replyToUserId = parent ? parent.user_id : null;
  }
  const m = {
    id: tempId, channel_id: channelId, user_id: state.me.id, content,
    created_at: new Date().toISOString(),
    reply_to_id: replyId ?? null, reply_to_user_id: replyToUserId,
    reactions: [], edited_at: null, pinned_at: null, deleted_at: null, is_system: false,
  };
  const wrap = $("#message-list");
  const msgs = state.messages[channelId] || [];
  const anchor = groupingAnchor(msgs, msgs.length); // group under the current live tail
  const grouped = anchor ? shouldGroupMessage(anchor.user, anchor.time, m, new Date(m.created_at).getTime()) : false;
  const isMod = S.canModerate(state.me);
  const activeCh = state.channels[channelId];
  const canPin = isMod || !!(activeCh && activeCh.is_dm);
  const row = messageRow(m, { grouped, isMod, canPin, pending: true });
  const bottomSentinel = wrap.querySelector('[data-sentinel="bottom"]');
  if (bottomSentinel) wrap.insertBefore(row, bottomSentinel);
  else wrap.append(row);
  scrollToBottom(wrap);
  pendingSends.push({ tempId, channelId, content, el: row });
  return tempId;
}

// reconcileOptimistic swaps the dimmed optimistic row for the real one when its own
// message.new echo lands. Matches by (channel, exact content) since the server
// doesn't round-trip a client nonce; oldest match first. The real row is re-placed at
// its array-sorted DOM slot (insertionPointFor), not blindly where the pending row sat
// — another user's message can land in the gap and ids interleave either way, so an
// in-place replace would leave the two out of order. Returns false (caller
// appends/renders normally) when there's no pending match or the optimistic row was
// already wiped (e.g. an interleaved full render), in which case the real message
// simply hasn't been drawn yet.
function reconcileOptimistic(m) {
  if (!m || m.user_id !== state.me.id) return false;
  const i = pendingSends.findIndex((p) => p.channelId === m.channel_id && p.content === m.content);
  if (i < 0) return false;
  const { el: pendingEl } = pendingSends[i];
  pendingSends.splice(i, 1);
  if (!pendingEl || !pendingEl.isConnected) return false;
  const wrap = $("#message-list");
  const msgs = state.messages[m.channel_id] || [];
  const idx = msgs.findIndex((x) => x.id === m.id);
  const anchor = groupingAnchor(msgs, idx);
  const grouped = anchor ? shouldGroupMessage(anchor.user, anchor.time, m, new Date(m.created_at).getTime()) : false;
  const isMod = S.canModerate(state.me);
  const activeCh = state.channels[m.channel_id];
  const canPin = isMod || !!(activeCh && activeCh.is_dm);
  const atBottom = isNearBottom(wrap.scrollHeight, wrap.scrollTop, wrap.clientHeight);
  // Drop the reconciled row into its array-sorted DOM slot, NOT necessarily where the
  // pending row sat: another user's message may have arrived (and been appended) in the
  // gap between the optimistic paint and this echo, and ids can interleave either way.
  // Remove the pending row first so it isn't picked as our own insertion point.
  const row = messageRow(m, { grouped, isMod, canPin });
  pendingEl.remove();
  const before = insertionPointFor(wrap, msgs, idx);
  if (before) wrap.insertBefore(row, before);
  else wrap.append(row);
  if (atBottom) scrollToBottom(wrap);
  return true;
}

// removePending rolls an optimistic row back after a failed send.
function removePending(tempId) {
  if (tempId == null) return;
  const i = pendingSends.findIndex((p) => p.tempId === tempId);
  if (i < 0) return;
  const { el: pendingEl } = pendingSends.splice(i, 1)[0];
  if (pendingEl && pendingEl.isConnected) pendingEl.remove();
}

// clearPendingSends drops all tracked optimistic rows — called when the pane is
// rebuilt for a different channel (loadChannel), where the rows are gone anyway.
function clearPendingSends() {
  pendingSends.length = 0;
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ▌ REGION 6 · COMPOSER & MESSAGE ACTIONS
// ▌ Authoring: the contenteditable composer + autocomplete + emoji picker,
// ▌ inline message editing, link previews, and reactions — i.e. everything you
// ▌ do TO a message once it (or its draft) exists.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

// richContext supplies composer-richtext.js the live sets it needs to tint only
// REAL @mentions / #channels / :emoji: (matching format.js), rebuilt per render
// (cheap at this roster size). null before login so decoration stays inert.
function richContext() {
  if (!state.me) return null;
  const usernames = new Set();
  for (const u of Object.values(state.users)) if (u && u.username) usernames.add(u.username.toLowerCase());
  const channels = new Set();
  for (const c of Object.values(state.channels)) if (c && !c.is_dm && c.name) channels.add(c.name);
  const emojis = new Set(Object.keys(BUILTIN_EMOJI));
  for (const code of Object.keys(state.emojis)) emojis.add(code);
  const meUser = (state.users[state.me.id] || state.me).username;
  return { meLower: meUser ? meUser.toLowerCase() : null, usernames, channels, emojis };
}

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
// MAP — wireComposer builds the message composer and binds its handlers once. It
// plugs in three sub-systems and threads them through the DOM events:
//   • ac   = mkAutocomplete(input)          — @-mention / :emoji completion
//   • rich = createComposerRichText(input)  — live **markdown** decoration + undo
//   • composerTray = createAttachmentTray() — staged image uploads (module handle)
//
// Handlers (registration order):
//   input      → image-paste CHANNEL 3 (harvest native <img>) · stranded-<br>
//                normalize · rich.onInput (decorate + undo) · typing ping
//   paste      → image-paste CHANNEL 1 (clipboard files) · URL-over-selection → [..](..)
//   beforeinput→ image-paste CHANNEL 2 (FF-Android dataTransfer files)
//   keydown    → ac → rich (Ctrl-B/I) → Esc-cancels-reply → ArrowUp-edits-last →
//                Enter-SEND ┬ secret session: sendSecretMessage (no attach/reply)
//                           └ normal: composeMessageBody + attachments + reply
//   attach btn / drag-drop → composerTray.uploadAndInsert
//
// The three image-paste channels are deliberately redundant across browsers and
// mutually exclusive per paste (each preventDefaults). Don't collapse them — see
// docs/testing/image-paste-qa.md and the caret/decoration invariant in docs/design/rich-text.md.
function wireComposer() {
  const input = $("#composer-input");
  upgradeComposerField(input); // before anything reads .value / .selectionStart
  const popup = $("#mention-popup");
  // @-mention / :emoji inline completion, shared with the inline edit boxes.
  // The composer's keydown defers to ac.handleKeydown before its own send logic.
  const ac = mkAutocomplete(input, popup);
  // Live markdown decoration: **bold**/*italic*/`code`/etc. render their effect
  // as you type, markers kept but dimmed. highlight() is driven from the input
  // handler below (one DOM-rewrite path); handleKeydown owns Ctrl-B / Ctrl-I.
  const rich = createComposerRichText({ el: input, enabled: prefs.loadRichText(), getContext: richContext });
  composerRich = rich; // module-scope handle so channel switches + the prefs toggle can reach it
  const TYPING_INTERVAL_MS = 1500;
  let lastTypingSent = 0;

  // True while the open channel is an active OTR secret session. Images are
  // never sent in one, so every paste channel suppresses them silently.
  const secretActive = () => {
    const ch = state.channels[state.activeChannelId];
    const sess = ch && ch.is_dm ? getSession(state.activeChannelId) : null;
    return !!(sess && sess.phase === "active");
  };

  input.addEventListener("input", (e) => {
    // Fallback caret (text offsets) for synthetic input events that carry no
    // beforeinput — e.g. autocomplete's pick. For real edits rich.onInput
    // resolves the caret from the beforeinput snapshot instead.
    const selStart = input.selectionStart, selEnd = input.selectionEnd;
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
    // Stranded-<br> normalization: a DELETE that empties the field can leave a
    // lone <br>, which defeats :empty (and the placeholder). Gate on a delete
    // inputType — a deliberate Shift+Enter on an empty composer ALSO produces a
    // lone <br> in Gecko, and that one must survive as a real newline.
    if ((e?.inputType || "").startsWith("delete") && (input.value === "" || input.value === "\n")) input.innerHTML = "";
    // No flatten pass: rich.highlight() rebuilds the field's HTML from its text
    // (textOf), which both decorates AND sanitizes anything a rich paste smuggled
    // in. A textContent-based flatten would silently drop a <br> Gecko nests
    // inside a decorated span — that was the eaten-newline / code-block bug.

    // Live markdown decoration + undo snapshot — after image harvest +
    // normalization, so it works on clean text. Restores the caret from the
    // pre-mutation offsets; no-op during IME composition.
    rich.onInput(selStart, selEnd);

    if (state.activeChannelId && input.value.trim()) {
      const now = Date.now();
      if (now - lastTypingSent >= TYPING_INTERVAL_MS) {
        lastTypingSent = now;
        sendWS({ type: "typing", channel_id: state.activeChannelId });
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
    rich.highlight(); // re-render: the .value set above wiped any decoration spans
    rich.commit();    // a discrete undo step (this set fires no `input` event)
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
    // Ctrl-B / Ctrl-I wrap the selection in **/* (and preventDefault the
    // browser's native bold/italic, which would inject <b>/<i> tags).
    if (rich.handleKeydown(e)) return;
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
        composerRich?.resetHistory(); // sent → fresh undo baseline (empty)
        lastTypingSent = 0;
        try {
          await sendSecretMessage(state.activeChannelId, text.trim());
          renderMessages(false);
        } catch (ex) {
          input.value = text;
          composerRich?.resetHistory(); // restore failed → baseline the put-back text
          alert("Secret message failed: " + ex.message);
        }
        return;
      }
      // Message body = the typed text followed by each done attachment's image
      // markdown (spoiler-marked ones wrapped in ||..||), one per line; either
      // part alone is enough to send.
      // Mirror the server's TrimRight(" \t\r\n") (handlers_messages.go) here so the
      // bytes we send, the optimistic row, and the echoed message.new are identical.
      // Otherwise reconcileOptimistic's exact-content match misses on a trailing space
      // or newline — the echo can't find its pending row, so the real message gets
      // appended while the dimmed optimistic row is left stuck (a duplicate on send).
      const content = composeMessageBody(text, composerTray.doneUploads()).replace(/[ \t\r\n]+$/, "");
      if (!content.trim()) return;
      input.value = ""; // the div collapses back to a single line on its own
      composerRich?.resetHistory(); // sent → fresh undo baseline (empty)
      lastTypingSent = 0; // allow next keystroke to fire a fresh typing frame immediately
      const sent = composerTray.takeAll();
      const replyId = replyingToId; // capture, then clear the banner optimistically
      replyingToId = null;
      renderReplyBanner();
      // Optimistic echo: paint the message at the live tail now, before the server
      // round-trips. The message.new echo reconciles the dimmed row into the real
      // one; a failed send rolls it back below. Only at the live tail — a history
      // window / secret view keep their existing reload / secret paths.
      const cid = state.activeChannelId;
      const optimistic = (cid && !historyPaging.isViewingHistory(cid) && !inSecretView(cid))
        ? showOptimisticSend(cid, content, replyId)
        : null;
      try {
        await api.sendMessage(cid, content, replyId);
        sent.forEach((u) => u.objectUrl && URL.revokeObjectURL(u.objectUrl));
      } catch (ex) {
        if (optimistic != null) removePending(optimistic); // roll the dimmed row back (no-op if a channel switch already dropped it)
        if (cid === state.activeChannelId) {
          // Still on the channel we sent from — restore the live composer for an
          // in-place retry.
          input.value = text;
          composerRich?.resetHistory(); // restore failed → baseline the put-back text
          composerTray.putBack(sent); // put the attachments back so the send can be retried
          replyingToId = replyId; // restore the reply context too
          renderReplyBanner();
        } else {
          // The user navigated away during a slow failing send — restoring into the
          // live composer would inject THIS channel's text/reply/attachments into
          // whatever channel they're now viewing. Stash the text back into the origin
          // channel's draft (restored on return) and release the staged uploads.
          drafts.saveText(cid, text);
          sent.forEach((u) => u.objectUrl && URL.revokeObjectURL(u.objectUrl));
        }
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
  loadRecentEmoji: () => prefs.loadRecentEmoji(),
  pushRecentEmoji: (value, isCustom) => prefs.pushRecentEmoji(value, isCustom),
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
    // Ctrl/Cmd-B / -I wrap the selection in **/* — the marker-insert form (a
    // <textarea> can't render decoration; the markers just get typed for you).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      const k = (e.key || "").toLowerCase();
      if (k === "b" || k === "i") {
        e.preventDefault();
        const r = toggleMarker(ta.value, ta.selectionStart, ta.selectionEnd, k === "b" ? "**" : "*");
        ta.value = r.value;
        ta.setSelectionRange(r.start, r.end);
        editDraft = ta.value;
        autoGrowEdit(ta);
        return;
      }
    }
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
  rerender: () => scheduleRender("messages"),
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

// reactionsRow renders the pill row under a message, or null if it has none. Each
// pill shows the emoji (custom shortcode → image, else the literal Unicode glyph)
// and its count, is highlighted when I'm among the reactors, and toggles on click.
// When the backing custom emoji has been deleted the pill shows a 🪦 tombstone:
// mine reactors may still click to remove (the server now allows it); non-mine
// pills are disabled since adding a deleted emoji would be rejected anyway. The
// per-pill classification (mine/isCustom/isOrphan/disabled) is the pure
// classifyReaction (format.js); the glyph element and name join stay here.
function reactionsRow(m) {
  if (!m.reactions || !m.reactions.length) return null;
  const row = el("div", { class: "reactions" });
  for (const g of m.reactions) {
    const ids = g.user_ids || [];
    const { mine, isCustom, isOrphan, disabled } = classifyReaction(g, state.emojis, state.me.id);
    const names = ids.map((id) => (state.users[id] ? state.users[id].display_name : "someone")).join(", ");
    const glyph = isCustom
      ? el("img", { class: "emoji", src: api.emojiURL(g.emoji), alt: `:${g.emoji}:` })
      : isOrphan
        ? el("span", { class: "r-emoji" }, "🪦")
        : el("span", { class: "r-emoji" }, g.emoji);
    // Tooltip text (emoji identity — reactors, plus an orphan note) is a pure
    // transform; the DOM/state bits (isCustom/isOrphan/mine/names) stay here.
    const titleText = reactionTooltip(g.emoji, names, { isCustom, isOrphan, mine });
    row.append(el("button", {
      class: "reaction" + (mine ? " mine" : "") + (isOrphan ? " orphan" : ""),
      title: titleText,
      disabled,
      // Pass the rendered "mine" so the toggle is correct even when the message
      // isn't in the active window (the pins modal renders pins it fetched itself).
      onclick: disabled ? null : () => toggleReaction(m.id, g.emoji, mine),
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ▌ REGION 7 · CONTROL WIRING
// ▌ The one-time wire* functions that attach static-DOM event listeners, grouped
// ▌ by concern and aggregated by wireControls (run once from enterApp). The
// ▌ feature-module plugs they reference now live in R8's switchboard.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// --- control wiring: one-time event bindings, grouped by concern -------------

// The lightbox doubles as a per-channel image gallery: openLightbox snapshots
// every inline image currently loaded in the message pane (DOM order = post
// order) and remembers which one was opened, so the arrow keys / ‹ › buttons /
// swipe can step through them without any server round-trip or new state model.
// The snapshot is a window over the LOADED messages only — history paging beyond
// the window isn't chased (that'd need a real endpoint). Reset on close.
let lightboxImages = [];
let lightboxIndex = 0;

// openLightbox shows an inline image large, centred on a dark backdrop, instead
// of opening it in a new tab. Dismissed by the × button, Esc, or a backdrop tap
// (wired in wireModalDismissal alongside the other .modal handlers). Prev/next
// navigation is wired in wireModalDismissal (buttons/swipe) and wireGlobalKeys
// (arrows). `images`/`index` default to a single-image gallery for callers that
// only have a src.
function openLightbox(images, index = 0) {
  const list = Array.isArray(images) ? images : [images];
  if (!list.length || !list[index]) return;
  lightboxImages = list;
  $("#lightbox").hidden = false;
  showLightboxAt(index);
}

// showLightboxAt swaps the displayed image to gallery slot i (wrapping at both
// ends) and reflects whether stepping is possible by hiding the ‹ › buttons for
// a lone image. Out-of-range or empty galleries no-op.
function showLightboxAt(i) {
  const n = lightboxImages.length;
  if (!n) return;
  lightboxIndex = ((i % n) + n) % n; // wrap, handling negatives
  $("#lightbox-img").src = lightboxImages[lightboxIndex];
  const single = n < 2;
  $("#lightbox-prev").hidden = single;
  $("#lightbox-next").hidden = single;
}

// closeModal hides a modal and, if it's the profile modal, reverts any live
// theme preview to the persisted value (so backdrop/Esc dismissals don't keep an
// unsaved theme on screen). Shared by the backdrop, the × affordance, and Escape.
function closeModal(m) {
  m.hidden = true;
  if (m.id === "profile-modal") applyTheme(myTheme());
  // Drop the lightbox source so a large image stops loading / frees memory and
  // the next open never flashes the previous picture; clear the gallery snapshot
  // so it can't outlive the channel it was taken from.
  if (m.id === "lightbox") { $("#lightbox-img").src = ""; lightboxImages = []; }
}

// wireDelegatedClicks installs the single document-level click handler that routes
// in-app navigation off rendered content: spoiler reveal, #channel links, inline
// image lightbox, and same-origin message permalinks (SPA jump, no reload).
// Modified clicks (new-tab/window intent) and cross-origin links fall through to
// the browser unchanged.
function wireDelegatedClicks() {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // closest is only on Elements; a text-node target (?.()) yields undefined.
    const closest = (sel) => e.target.closest?.(sel);
    // Spoiler reveal: clicking an unrevealed spoiler reveals it; eats the click so
    // links inside the spoiler don't fire before the user has seen the content.
    const spoiler = closest(".spoiler");
    if (spoiler && !spoiler.classList.contains("revealed")) {
      e.preventDefault();
      spoiler.classList.add("revealed");
      return;
    }
    // Channel links (#channelname) navigate to the channel in-app.
    const chLink = closest("a.channel-link");
    if (chLink) {
      e.preventDefault();
      const id = parseInt(chLink.dataset.channelId, 10);
      if (id && state.channels[id]) {
        // A #channel link can live inside a modal-rendered message body (pins,
        // search); navigating away should dismiss that modal too.
        $("#pins-modal").hidden = true;
        $("#search-modal").hidden = true;
        selectChannel(id);
      }
      return;
    }
    // Inline images open in a large in-app lightbox rather than a new tab. The
    // image is wrapped in an a.msg-image-link; intercept that anchor (unmodified
    // left clicks only — the modifier checks above already let new-tab intent
    // through) and show the lightbox instead of navigating.
    const imgLink = closest("a.msg-image-link");
    if (imgLink) {
      e.preventDefault();
      // Snapshot every image loaded in the message pane (scoped to #message-list
      // so pins/search modal bodies don't bleed in) and open at the clicked one,
      // so the lightbox can step prev/next through the channel's images.
      const links = [...$("#message-list").querySelectorAll("a.msg-image-link")];
      const idx = Math.max(0, links.indexOf(imgLink));
      openLightbox(links.map((a) => a.getAttribute("href")), idx);
      return;
    }
    const a = closest("a[href]");
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

  // Desktop-notification opt-in (the request-permission → push → persist → re-render
  // flow lives in notifyui.js).
  const notifCb = $("#notif-enable");
  if (notifCb) notifCb.onchange = () => notifUI.setEnabled(notifCb.checked);

  // Live markdown formatting opt-out (composer-richtext.js). Persisted in
  // localStorage (prefs.js); flips the live composer decoration on/off at once.
  const richCb = $("#richtext-enable");
  if (richCb) richCb.onchange = () => { prefs.saveRichText(richCb.checked); composerRich?.setEnabled(richCb.checked); };
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
    await guard(async () => {
      await api.uploadAvatar(file);
      const me = await api.me();
      avatarVersion[me.id] = Date.now(); // bust the cache so the new avatar shows now
      state = S.upsertUser(state, me);
      state = S.setMe(state, me);
      renderMe();
      renderMessages(); // my own messages in view should pick up the new avatar
    });
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
      refreshEmojiManagerIfOpen();
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

  // Gallery prev/next: the ‹ › buttons sit over the backdrop like the ×, so
  // stopPropagation keeps their clicks from bubbling to the backdrop-dismiss.
  $("#lightbox-prev").onclick = (e) => { e.stopPropagation(); showLightboxAt(lightboxIndex - 1); };
  $("#lightbox-next").onclick = (e) => { e.stopPropagation(); showLightboxAt(lightboxIndex + 1); };

  // Mobile: horizontal swipe on the image steps the gallery (the counterpart to
  // the desktop arrow keys). A short/vertical drag is ignored so a tap or scroll
  // doesn't trip it.
  let touchX = null, touchY = null;
  const img = $("#lightbox-img");
  img.addEventListener("touchstart", (e) => {
    const t = e.changedTouches[0];
    touchX = t.clientX; touchY = t.clientY;
  }, { passive: true });
  img.addEventListener("touchend", (e) => {
    if (touchX == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX, dy = t.clientY - touchY;
    touchX = touchY = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return; // tap / vertical
    showLightboxAt(lightboxIndex + (dx < 0 ? 1 : -1)); // swipe-left ⇒ next
  }, { passive: true });
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

  // Lightbox gallery: while it's open, Left/Right step through the channel's
  // loaded images. Only acts when the lightbox is up, so the keys stay free for
  // text fields and other surfaces otherwise.
  document.addEventListener("keydown", (e) => {
    if ($("#lightbox").hidden) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    showLightboxAt(lightboxIndex + (e.key === "ArrowLeft" ? -1 : 1));
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ▌ REGION 8 · SHELL CHROME & SUBSYSTEMS
// ▌ Drawers/swipe/idle, then the consolidated switchboard — feature-module plugs
// ▌ (forward/mobile-ctx/pins/search/notify) + subsystem plugs (modals, admin,
// ▌ avatars/image-warming, voice/video, secret UI), interleaved with presence and
// ▌ the loading screen — then the lone boot() call at the very bottom.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
    sendWS({ type: "idle", idle: true });
  }

  function onActivity() {
    clearTimeout(idleTimer);
    if (isIdle) {
      isIdle = false;
      sendWS({ type: "idle", idle: false });
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

// --- feature-module plugs ----------------------------------------------------
//
// The message/channel feature modules, each behind a createX(deps) surface that
// re-exports the handful of methods the call sites + wire* functions use. Gathered
// here (with the subsystem plugs below) as the app's one switchboard. Ordering
// constraints: forward → mobileCtx (mobileCtx injects openForwardModal), and
// mobileCtx after emojiPicker (R6); everything else they reference is a hoisted
// function declaration. Full contracts live in each module's header comment.

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
  removeEmbed,
  embedURLFor,
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

// Foreground notifications — notifyui.js, e2e/notifications.spec. Owns the opt-in
// (seeded from prefs) + baseTitle; renderNotificationTotal/firePing/renderNotifControl/
// initPushRouting are driven from the realtime handler, sidebar badges, and profile
// modal. voiceUI reads the opt-in via notifUI.isEnabled (below).
const notifUI = createNotifyUI({
  el,
  $,
  getState: () => state,
  api,
  prefs,
  selectChannel,
  jumpToMessage: (channelId, messageId) => jumpToMessage(channelId, messageId),
  tabUnfocused,
});

// --- invite, channel & profile modals, user card -----------------------------

// The modal cluster (new-channel, edit-profile, invite, read-only user card)
// lives in modals.js; e2e/modals.spec nets it. The two app-state couplings are
// injected: onProfileOpen refreshes the profile modal's notif/PTT sub-controls,
// and onActiveMembersChanged writes activeMemberIds + re-renders the members
// panel as people are invited. The create-channel and save-profile form handlers
// stay in app.js's wire* functions.
// (avatarSrc/startDM in the bag are defined further down in R8 but are hoisted
// function declarations, so the forward reference resolves fine.)
const modals = createModals({
  el,
  $,
  getState: () => state,
  api,
  closeDrawers,
  avatarSrc,
  startDM,
  onProfileOpen: () => {
    notifUI.renderNotifControl();
    voiceUI.onProfileOpen();
    const richCb = $("#richtext-enable");
    if (richCb) richCb.checked = prefs.loadRichText();
  },
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
//
// The foreground-notification UX — the global missed-count badge/title, the
// focused-tab ping toast, firePing's chime/toast/OS-alert decision, the Web Push
// subscription lifecycle, and the profile opt-in control — lives in notifyui.js
// (created in the feature-module plugs above as `notifUI`). app.js's realtime
// handler calls notifUI.firePing on a ping; renderSidebarBadges/enterApp call
// notifUI.renderNotificationTotal; the profile modal drives setEnabled/
// renderNotifControl. The opt-in is read back via notifUI.isEnabled (voiceui.js's
// ring path uses it through the injected getNotifEnabled). The incoming-call OS
// notification and the push-to-talk control row live in voiceui.js.
//
// The shared label helpers moved down a layer: state.displayNameOf (the roster
// lookup) and format.pingLabel (the "<who> in #<channel>" string), both pure and
// unit-tested, so notifyui.js and voiceui.js share them without depending on each
// other.

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
  // end it gracefully — they can't receive or send anymore. applyEvent also swept
  // their typing across all channels; repaint the indicator for the open one.
  if (!evt.payload.online) {
    terminateSessionForPeer(evt.payload.user_id);
    renderTypingIndicator();
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

// Image cache warming (avatars, viewport images, background blob sweep). See
// imagewarm.js for the contract; the pure newest-first URL scan is unit-tested
// there. avatarSrc is passed by reference (it closes over avatarVersion/state).
const imageWarm = createImageWarmer({ getState: () => state, api, avatarSrc });

// history.js — the message-pane history/paging + scroll sub-system (the blessed
// carve). Owns the load guards, history-window flags, and IntersectionObserver
// sentinels; loadChannel/jumpToMessage stay here and drive it via its accessors.
// getState/setState bridge the reassigned `state`; renderMessages is app.js's pane
// render, called back when a page splices in.
const historyPaging = createHistoryPaging({
  getState: () => state,
  setState: (s) => { state = s; },
  api,
  S,
  renderMessages,
  messageList: () => $("#message-list"),
});

// In-call video grid — videogrid.js, e2e/video-grid.spec. app.js keeps owning
// videoViewHidden (header label, channel selection, and call lifecycle touch it
// directly); the grid only gets a get/set pair. voiceCallState/speakingIds are
// read through getters because they're reassigned/mutated on every voice update.
const videoGrid = createVideoGrid({
  el,
  $,
  getState: () => state,
  getVoiceCallState: () => voiceUI.getVoiceCallState(),
  getSpeakingIds: () => voiceUI.getSpeakingIds(),
  avatarSrc,
  getVideoViewHidden: () => voiceUI.getVideoViewHidden(),
  setVideoViewHidden: (v) => voiceUI.setVideoViewHidden(v),
});
const renderVideoGrid = videoGrid.renderVideoGrid;

// --- loading screen ----------------------------------------------------------

function dismissLoadingScreen() {
  const el = document.getElementById("loading-screen");
  if (!el) return;
  el.classList.add("done");
  el.addEventListener("transitionend", () => { el.hidden = true; }, { once: true });
}

// --- voice calling -----------------------------------------------------------
//
// The call UI controller lives in voiceui.js (the secretui.js method, but over
// the voice.js WebRTC engine): it owns the call strip, ring banner, push-to-talk,
// the per-user volume slider, the mobile video/chat toggle, and the ring OS
// notification, plus the live call/ring state app.js's render functions read
// through its accessors. Two voice values stay in app.js and are injected back:
// voiceTelemetry (created + registered to voice.js in enterApp) via getTelemetry,
// and the notification opt-in via getNotifEnabled (the ring notification reads it).
// Order constraint: this plug MUST follow videoGrid — its bag takes renderVideoGrid
// (a const, not a hoisted fn), so it can't float above the grid in the switchboard.
const voiceUI = createVoiceUI({
  $, el,
  getState: () => state,
  api,
  sendWS,
  prefs,
  renderChannelHeader,
  renderMembers,
  renderChannels,
  renderVideoGrid,
  reflowSpotlightForSpeaker: () => videoGrid.reflowSpotlightForSpeaker(),
  selectChannel,
  ensureDMOpen,
  displayNameOf: (id) => S.displayNameOf(state, id),
  tabUnfocused,
  getNotifEnabled: () => notifUI.isEnabled(),
  getTelemetry: () => voiceTelemetry,
});

// wireDMVolume binds the channel-header 🔊 partner-volume widget. It stays in
// app.js because the widget's bound-channel + collapsed state (dmVolumeChannelId/
// dmVolumeOpen) is driven by the channel header app.js renders; the slider itself
// drives voice.js's per-user playout gain (persisted across calls).
function wireDMVolume() {
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
