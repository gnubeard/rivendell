// app.js — the Rivendell web client. Wires the API, websocket, formatter, and the
// pure state reducer to the DOM. Deliberately framework-free.

import { api } from "./api.js?v=__RIVENDELL_VERSION__";
import { connectRealtime } from "./ws.js?v=__RIVENDELL_VERSION__";
import { formatMessage, mentionsUser, atQuery, colonQuery, permalinkHash, parsePermalink, extractPreviewableURL, extractYouTubeVideoID, extractHideURL } from "./format.js?v=__RIVENDELL_VERSION__";
import * as S from "./state.js?v=__RIVENDELL_VERSION__";
import {
  shouldNotify,
  showNotification,
  requestNotificationPermission,
  currentPermission,
  notificationsSupported,
} from "./notify.js";

let state = S.initialState();
let socket = null;
let wasOffline = false; // tracks realtime disconnects so a reconnect can resync
let isIdle = false;    // tracks client-side idle state for re-signaling on reconnect
let baseTitle = document.title; // brand title, sans any "(N)" notification prefix
let appVersion = ""; // server-reported semantic version, shown in the About dialog

// Desktop-notification opt-in (per browser). The OS permission is separate and
// owned by the browser; this is the user's in-app preference that gates it.
let notifEnabled = loadNotifPref();
// Highest message id we've told the server we've read, per channel — dedupes the
// mark-read POST so refocusing a tab doesn't spam the endpoint.
const lastMarkedRead = {};
// Per-user avatar cache-bust token. The avatar URL is otherwise stable and
// cached, so when someone changes their avatar we bump their token to force a
// re-fetch (the server broadcasts user.update on avatar change).
const avatarVersion = {};
// Link preview cache: url -> { title, description, image } | "loading" | "failed".
// Populated lazily as messages scroll into view; persists for the session.
const linkPreviewCache = new Map();
// Message ids deleted *during this session* (seen live via message.delete). Only
// these get a "message deleted" tombstone; messages that arrive already-deleted
// from history render as nothing, so a fresh load isn't littered with tombstones.
const liveDeleted = new Set();
// Composer draft text saved per channel so switching channels doesn't discard work.
const channelDrafts = new Map(); // channelId -> string

function loadNotifPref() {
  try {
    return localStorage.getItem("rivendell.notifications") === "1";
  } catch (e) {
    return false;
  }
}

function saveNotifPref() {
  try {
    localStorage.setItem("rivendell.notifications", notifEnabled ? "1" : "0");
  } catch (e) {
    /* best-effort: persistence is non-fatal */
  }
}
// Member ids of the active channel when it's private (incl. DMs); null means
// "show everyone" (public channels have no membership rows).
let activeMemberIds = null;

// Scrollback state: messages load a page at a time as you scroll up.
const PAGE = 50;
let loadingOlder = false; // guards against overlapping back-paging fetches
let loadingNewer = false; // guards against overlapping forward-paging fetches
let pinsRefreshSeq = 0; // last-writer-wins token for concurrent refreshPins() calls
const historyComplete = new Set(); // channelIds whose oldest message is loaded
const viewingHistory = new Set(); // channelIds whose loaded bottom isn't the live tail
let flashMessageId = null; // id of a jumped-to message to highlight; survives re-renders
// Inline message editing. renderMessages is the source of truth: when a message's
// id == editingMessageId it draws an inline editor (not the body+actions) seeded
// from editDraft. editDraft + caret are captured/restored across re-renders so an
// incoming message event mid-edit can't blow the editor away (see renderMessages).
let editingMessageId = null;  // id of the message being edited inline, or null
let editDraft = "";           // current text of the inline editor, preserved on re-render
let editFocusPending = false; // focus the editor on the next render (it just opened)

// Closed DMs: a per-browser set of DM channel ids the user has hidden from the
// sidebar. The channel and its history are untouched server-side — closing only
// hides the row. Reopening (clicking the person's name) or a fresh incoming
// message un-hides it. Persisted to localStorage so it survives refreshes.
const closedDMs = loadClosedDMs();

function loadClosedDMs() {
  try {
    return new Set(JSON.parse(localStorage.getItem("rivendell.closedDMs") || "[]"));
  } catch (e) {
    return new Set();
  }
}

function saveClosedDMs() {
  try {
    localStorage.setItem("rivendell.closedDMs", JSON.stringify([...closedDMs]));
  } catch (e) {
    /* best-effort: persistence is non-fatal */
  }
}

// reopenDM un-hides a previously closed DM (idempotent). Returns true if it was
// actually closed, so callers can decide whether a re-render is needed.
function reopenDM(id) {
  if (!closedDMs.has(id)) return false;
  closedDMs.delete(id);
  saveClosedDMs();
  return true;
}

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
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
}

// --- mobile viewport height ----------------------------------------------
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

// --- notification chime ---------------------------------------------------
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

function boop() {
  // Only use a context that a prior user gesture already created — never create
  // one here, or the browser logs "AudioContext was prevented from starting".
  if (!audioCtx) return;
  // Browsers auto-suspend the context when the tab is idle/backgrounded; resume
  // is allowed because the page has already had a gesture (primeAudio ran).
  if (audioCtx.state === "suspended") audioCtx.resume();
  const t = audioCtx.currentTime;
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
}

// --- bootstrapping -------------------------------------------------------

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
  } catch {
    /* keep the default branding */
  }
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

async function enterApp() {
  show("app");
  const [users, channels] = await Promise.all([api.users(), api.channels()]);
  state = S.setUsers(state, users);
  state = S.setChannels(state, channels);
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
  // A closed DM is never restored as the active channel.
  const restore =
    saved && state.channels[saved] && !closedDMs.has(state.channels[saved].id)
      ? state.channels[saved].id
      : null;
  const firstChannel = restore || regularChannelOrder()[0] || state.channelOrder[0];
  if (firstChannel) {
    state = S.setActiveChannel(state, firstChannel);
  }
  renderMe();
  renderChannels();
  renderDMs();
  renderMembers();
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
  // Wire interactive controls BEFORE realtime, so a transport problem can never
  // leave the composer/admin/avatar handlers unattached.
  wireComposer();
  wireControls();
  wireSwipe();
  wireIdleDetection();
  // Returning to the tab clears the open channel's unread (you're looking now).
  window.addEventListener("focus", onWindowFocus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onWindowFocus();
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

// --- realtime ------------------------------------------------------------

function startRealtime() {
  if (socket) socket.close();
  socket = connectRealtime(
    (evt) => {
      // Presence is debounced (see schedulePresenceUpdate): a transient flip that
      // reverts within ~1s never paints, so dots don't flicker on brief blips.
      if (evt.type === "presence.update") { schedulePresenceUpdate(evt); return; }
      state = S.applyEvent(state, evt);
      // Targeted re-renders based on event type.
      if (evt.type.startsWith("presence") || evt.type === "user.update") {
        if (evt.type === "user.update" && evt.payload && evt.payload.has_avatar) {
          // Their avatar may have changed — force a re-fetch on next render.
          avatarVersion[evt.payload.id] = Date.now();
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
          // I left (or was removed): drop the channel, unless I already removed
          // it locally in leaveActiveChannel.
          if (state.channels[channel_id]) {
            state = S.removeChannel(state, channel_id);
            renderChannels();
            renderDMs();
            renderNotificationTotal();
            if (state.activeChannelId) loadChannel(state.activeChannelId);
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
      if (evt.type === "read.update" || evt.type === "mute.update") {
        // Another of my sessions caught up on / muted a channel (state.applyEvent
        // already folded it in); reflect the badges and the global total.
        renderChannels();
        renderDMs();
        renderNotificationTotal();
      }
      if (evt.type === "typing.update") {
        if (evt.payload.channel_id === state.activeChannelId) renderTypingIndicator();
      }
      if (evt.type === "emoji.add" || evt.type === "emoji.delete") {
        // The registry changed: re-render the open messages so :shortcode: tokens
        // start/stop rendering as images, and refresh any open emoji surfaces.
        renderMessages();
        if (emojiPickerOpen()) renderEmojiPicker();
        refreshAdminEmojisIfOpen();
      }
      if (evt.type === "reaction.update") {
        // applyEvent already folded the new groups into the message; just repaint
        // the open channel (and the pins panel, which renders reactions too).
        if (evt.payload.channel_id === state.activeChannelId) {
          renderMessages();
          refreshPinsIfOpen();
        }
      }
      if (evt.type.startsWith("message")) {
        // A delete seen live earns a tombstone (unlike already-deleted history).
        if (evt.type === "message.delete") liveDeleted.add(evt.payload.id);
        const cid = evt.payload.channel_id;
        const ch = state.channels[cid];
        const isNewFromOther = evt.type === "message.new" && evt.payload.user_id !== state.me.id;
        const mentioned = isNewFromOther && mentionsUser(evt.payload.content, state.me.username);
        // A "ping" is a message directed at you: any DM, or an @-mention.
        const pingsMe = isNewFromOther && ((ch && ch.is_dm) || mentioned);
        // A muted channel is fully silent: no badge bump, no chime/notification.
        const muted = S.isMuted(state, cid);
        if (cid === state.activeChannelId) {
          renderMessages();
          refreshPinsIfOpen(); // a pin/unpin arrives as a message.update
          if (tabUnfocused()) {
            // It's the open channel, but the tab isn't focused — you haven't
            // actually seen it, so it counts as unread (matching the server,
            // whose cursor we only advance on focus) and pings still alert.
            if (isNewFromOther && !muted) {
              state = S.bumpUnread(state, cid);
              if (mentioned) state = S.bumpMention(state, cid);
              renderChannels();
              renderDMs();
              renderNotificationTotal();
            }
            if (pingsMe && !muted) firePing(evt, ch);
          } else if (isNewFromOther) {
            // You're looking right at it — keep the read cursor current.
            markActiveChannelRead();
          }
        } else if (isNewFromOther && !muted) {
          // A new message in a channel we're not looking at: flag it unread,
          // and separately flag @-mentions so they badge distinctly. A message
          // landing in a closed DM resurfaces it so you don't miss it.
          reopenDM(cid);
          state = S.bumpUnread(state, cid);
          if (mentioned) state = S.bumpMention(state, cid);
          renderChannels();
          renderDMs();
          renderNotificationTotal();
          // Chime + (if opted in and not looking here) raise an OS notification
          // for pings; plain channel chatter stays silent with just the badge.
          if (pingsMe) firePing(evt, ch);
        }
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
      const next = regularChannelOrder()[0] || state.channelOrder[0] || null;
      state = S.setActiveChannel(state, next);
    }
    renderMe();
    renderChannels();
    renderDMs();
    renderMembers();
    renderNotificationTotal();
    if (state.activeChannelId) {
      await loadChannel(state.activeChannelId);
      if (!tabUnfocused()) markActiveChannelRead();
    }
    // A reconnect is a fresh connection (server defaults it to active); re-signal
    // idle over the new socket so the dot stays correct.
    if (isIdle) socket && socket.send({ type: "idle", idle: true });
  } catch (ex) {
    console.warn("rivendell: resync failed:", ex && ex.message);
  }
}

// --- rendering -----------------------------------------------------------

function renderMe() {
  const me = state.users[state.me.id] || state.me;
  $("#me-name").textContent = me.display_name;
  $("#me-status-text").textContent = me.status_text || "";
  $("#me-avatar").style.backgroundImage = me.has_avatar ? `url(${avatarSrc(me.id)})` : "";
  $("#me-avatar").textContent = me.has_avatar ? "" : initials(me.display_name);
  $("#status-select").value = me.status;
}

// regularChannelOrder is the channel ordering with DMs excluded — DMs live in
// their own sidebar section and are never reordered/deleted via the mod controls.
function regularChannelOrder() {
  return state.channelOrder.filter((id) => !state.channels[id].is_dm);
}

// dmDisplayName resolves a DM channel to the other participant's display name,
// falling back to the raw channel name if that user isn't loaded.
function dmDisplayName(ch) {
  const otherId = S.otherDMParticipant(ch, state.me.id);
  const other = otherId != null ? state.users[otherId] : null;
  return other ? other.display_name : ch.name;
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
  const list = $("#channel-list");
  list.innerHTML = "";
  const isMod = state.me.role === "admin" || state.me.role === "moderator";
  const order = regularChannelOrder();
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const ch = state.channels[id];
    const active = id === state.activeChannelId;
    const controls = el("span", { class: "ch-controls" },
      muteToggle(id),
      isMod ? el("button", { class: "ch-ctl", title: "Move up", disabled: i === 0 ? "disabled" : null,
        onclick: (e) => { e.stopPropagation(); moveChannel(id, -1); } }, "↑") : null,
      isMod ? el("button", { class: "ch-ctl", title: "Move down", disabled: i === order.length - 1 ? "disabled" : null,
        onclick: (e) => { e.stopPropagation(); moveChannel(id, +1); } }, "↓") : null,
      isMod ? el("button", { class: "ch-ctl danger", title: "Delete channel",
        onclick: (e) => { e.stopPropagation(); deleteChannel(id); } }, "✕") : null);
    const unread = state.unread[id] || 0;
    const mentioned = state.mentions[id] || 0;
    const cls = "channel" + (active ? " active" : "") + (unread ? " unread" : "") + (S.isMuted(state, id) ? " muted" : "");
    list.append(
      el("li", { class: cls, onclick: () => selectChannel(id) },
        el("span", { class: "ch-hash" }, ch.is_private ? "🔒" : "#"),
        el("span", { class: "ch-name" }, ch.name),
        unread ? el("span", { class: mentioned ? "unread-badge mention" : "unread-badge" }, mentioned ? `@${unread}` : String(unread)) : null,
        controls
      )
    );
  }
}

function renderDMs() {
  const list = $("#dm-list");
  list.innerHTML = "";
  const dms = state.channelOrder.filter((id) => state.channels[id].is_dm && !closedDMs.has(id));
  $("#dm-head").hidden = dms.length === 0;
  for (const id of dms) {
    const ch = state.channels[id];
    const active = id === state.activeChannelId;
    const otherId = S.otherDMParticipant(ch, state.me.id);
    const other = otherId != null ? state.users[otherId] : null;
    const unread = state.unread[id] || 0;
    const cls = "channel" + (active ? " active" : "") + (unread ? " unread" : "") + (S.isMuted(state, id) ? " muted" : "");
    list.append(
      el("li", { class: cls, onclick: () => selectChannel(id) },
        el("span", { class: `dot ${other ? presenceClass(other) : "offline"}` }),
        el("span", { class: "ch-name" }, other ? other.display_name : ch.name),
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
  const isAdmin = state.me.role === "admin";
  const isMod = isAdmin || state.me.role === "moderator";
  let users = Object.values(state.users).filter((u) => isAdmin || u.is_active !== false);
  // In a private channel/DM, restrict the panel to that channel's members.
  if (activeMemberIds) users = users.filter((u) => activeMemberIds.has(u.id));
  // Moderators+ can remove others from a real private channel (not DMs/public).
  const activeCh = state.channels[state.activeChannelId];
  const canRemove = isMod && !!(activeCh && activeCh.is_private && !activeCh.is_dm);
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
    list.append(
      el("li", {
        class: isSelf ? "member" : "member clickable",
        title: titleParts.join(" · "),
        onclick: isSelf ? null : () => startDM(u.id),
      },
        el("span", { class: `dot ${presenceClass(u)}` }),
        el("div", { class: "member-text" },
          el("span", { class: "member-name" }, u.display_name),
          el("span", { class: "member-status", title: u.status_text || null }, statusLine)),
        remove
      )
    );
  }
}

// removeMember (moderator+) removes another user from the active private channel.
// The server's member.remove broadcast updates everyone's roster; we also drop
// them locally so it's instant even for a mod viewing via the not-a-member bypass.
async function removeMember(channelId, userId, displayName) {
  if (!confirm(`Remove ${displayName} from this channel?`)) return;
  try {
    await api.removeChannelMember(channelId, userId);
    if (activeMemberIds) {
      activeMemberIds.delete(userId);
      renderMembers();
    }
  } catch (ex) {
    alert(ex.message);
  }
}

function renderAdminVisibility() {
  const isAdmin = state.me.role === "admin";
  const isMod = isAdmin || state.me.role === "moderator";
  $("#admin-btn").hidden = !isAdmin;
  $("#new-channel-btn").hidden = !isMod;
}

// moveChannel swaps a channel with its neighbor (dir -1 = up, +1 = down) and
// persists the result. Positions default to 0 (channels then sort by name), so a
// bare two-channel swap of equal positions would be a no-op; instead we
// renormalize the whole list to contiguous indices and PATCH only the channels
// whose stored position actually changed. The channel.update broadcasts then
// re-render the list for everyone.
async function moveChannel(id, dir) {
  const order = regularChannelOrder();
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  const patches = next
    .map((cid, idx) => (state.channels[cid].position === idx ? null : api.updateChannel(cid, { position: idx })))
    .filter(Boolean);
  try {
    await Promise.all(patches);
  } catch (ex) {
    alert(ex.message);
  }
}

async function deleteChannel(id) {
  const ch = state.channels[id];
  if (!ch) return;
  if (!confirm(`Delete #${ch.name}? It will be removed for everyone.`)) return;
  try {
    await api.archiveChannel(id);
  } catch (ex) {
    alert(ex.message);
  }
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
  if (!confirm(`Leave #${ch.name}? You'll need an invite to rejoin.`)) return;
  try {
    await api.removeChannelMember(ch.id, state.me.id);
    state = S.removeChannel(state, ch.id); // also re-points activeChannelId
    renderChannels();
    renderDMs();
    renderNotificationTotal();
    if (state.activeChannelId) await loadChannel(state.activeChannelId);
  } catch (ex) {
    alert(ex.message);
  }
}

// closeDM hides a DM from the sidebar (per-browser; the channel and its history
// stay intact server-side). If it's the channel currently open, fall back to the
// first regular channel so we don't leave the reader staring at a closed DM.
function closeDM(id) {
  closedDMs.add(id);
  saveClosedDMs();
  if (id === state.activeChannelId) {
    const next = regularChannelOrder()[0] || state.channelOrder.find((cid) => !closedDMs.has(cid));
    if (next != null) {
      selectChannel(next);
      return; // selectChannel re-renders the DM list for us
    }
  }
  renderDMs();
}

// startDM create-or-finds the DM channel with a user and opens it. Doubles as the
// "resurrect a closed DM" path — clicking a name un-hides a previously closed DM.
async function startDM(userId) {
  try {
    const ch = await api.createDM(userId);
    reopenDM(ch.id);
    state = S.upsertChannel(state, ch);
    await selectChannel(ch.id);
  } catch (ex) {
    alert(ex.message);
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
}

async function selectChannel(id) {
  // Save the composer draft for the channel we're leaving.
  const leaving = state.activeChannelId;
  if (leaving && leaving !== id) {
    const draft = $("#composer-input").value;
    if (draft.trim()) channelDrafts.set(leaving, draft);
    else channelDrafts.delete(leaving);
  }
  // Leaving a channel abandons any inline edit in progress.
  editingMessageId = null;
  editDraft = "";
  editFocusPending = false;
  state = S.setActiveChannel(state, id);
  try {
    localStorage.setItem("rivendell.activeChannel", id);
  } catch (e) {
    /* non-fatal: persistence is best-effort */
  }
  state = S.clearUnread(state, id);
  state = S.clearMention(state, id);
  renderChannels();
  renderDMs();
  renderNotificationTotal();
  closeDrawers(); // on mobile, reveal the conversation after a pick
  await loadChannel(id);
  // Restore any saved draft for this channel and resize the composer to fit.
  const composerInput = $("#composer-input");
  composerInput.value = channelDrafts.get(id) || "";
  composerInput.style.height = "auto";
  composerInput.style.height = composerInput.scrollHeight + "px";
  if (!window.matchMedia("(hover: none)").matches) composerInput.focus();
  // Persist the read cursor server-side using the newest loaded message.
  markActiveChannelRead();
}

// markActiveChannelRead advances the server read cursor for the open channel to
// its newest loaded message and clears its local counts. The mark-read POST is
// deduped per (channel, newest id) so refocusing the tab doesn't spam the server.
async function markActiveChannelRead() {
  const cid = state.activeChannelId;
  if (!cid) return;
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
  if (lastMarkedRead[cid] === newest) return; // server already knows
  lastMarkedRead[cid] = newest;
  try {
    await api.markRead(cid, newest);
  } catch (e) {
    lastMarkedRead[cid] = undefined; // let a later attempt retry
  }
}

// isModPlus reports whether the current user is a moderator or admin.
function isModPlus() {
  return !!(state.me && (state.me.role === "admin" || state.me.role === "moderator"));
}

// renderChannelHeader paints the active channel's title + topic into the header.
// For a real channel (not a DM) a moderator+ may click the topic to edit it inline;
// the span advertises that and shows a prompt to add one when the topic is empty.
function renderChannelHeader(ch) {
  const topicEl = $("#channel-topic");
  const dmDot = $("#channel-dm-dot");
  if (ch && ch.is_dm) {
    $("#channel-title").textContent = "@ " + dmDisplayName(ch);
    topicEl.textContent = "";
    topicEl.classList.remove("editable", "placeholder");
    topicEl.removeAttribute("title");
    const otherId = S.otherDMParticipant(ch, state.me && state.me.id);
    const other = otherId && state.users[otherId];
    dmDot.className = `dot ${other ? presenceClass(other) : "offline"}`;
    dmDot.hidden = false;
    return;
  }
  dmDot.hidden = true;
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

async function loadChannel(id) {
  const ch = state.channels[id];
  renderChannelHeader(ch);
  // Invite + leave affordances only make sense for a real private channel
  // (not DMs/public).
  const realPrivate = !!(ch && ch.is_private && !ch.is_dm);
  $("#invite-btn").hidden = !realPrivate;
  $("#leave-btn").hidden = !realPrivate;
  $("#pins-btn").hidden = !ch;
  // A DM is 1:1 — there's no roster worth showing, so collapse the members
  // column and hide its toggle (CSS keys off body.dm-active).
  document.body.classList.toggle("dm-active", !!(ch && ch.is_dm));
  await refreshActiveMembers();
  loadingOlder = false;
  loadingNewer = false;
  viewingHistory.delete(id);
  renderHistoryBanner();
  try {
    const msgs = await api.messages(id, { limit: PAGE });
    state = S.setMessages(state, id, msgs);
    // A short first page means there's nothing older to scroll back to.
    if (msgs.length < PAGE) historyComplete.add(id);
    else historyComplete.delete(id);
    renderMessages(true); // opening a channel always lands at the newest message
    renderTypingIndicator(); // reset indicator for the newly opened channel
  } catch (ex) {
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
    $("#invite-btn").hidden = !realPrivate;
    $("#leave-btn").hidden = !realPrivate;
    $("#pins-btn").hidden = !ch;
    document.body.classList.toggle("dm-active", !!(ch && ch.is_dm));
    await refreshActiveMembers();
  }
  try {
    const msgs = await api.messages(channelId, { around: messageId });
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
  // Images and iframes (e.g. YouTube embeds) load asynchronously and expand
  // the container after the rAF pass. Re-pin when each one finishes, but only
  // if the reader hasn't manually scrolled away since we pinned.
  // We capture the target scrollTop now (= scrollHeight − clientHeight, the max
  // possible value). After the pin, wrap.scrollTop == targetTop. When the image
  // loads, wrap.scrollHeight grows but scrollTop stays put — so checking
  // "scrollTop is still near targetTop" reliably tells us whether the user
  // scrolled away (vs. checking distance-from-new-bottom, which would be the
  // image height and could easily exceed any fixed pixel threshold).
  const targetTop = wrap.scrollHeight - wrap.clientHeight;
  wrap.querySelectorAll("img, iframe").forEach(media => {
    if (media.tagName === "IMG" && media.complete) return;
    media.addEventListener("load", () => {
      if (wrap.scrollTop >= targetTop - 5)
        wrap.scrollTop = wrap.scrollHeight;
    }, { once: true });
  });
}

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
  const msgs = state.messages[state.activeChannelId] || [];
  const isMod = state.me.role === "admin" || state.me.role === "moderator";
  // In a DM, either participant may pin (mirrors the server rule); elsewhere
  // pinning is moderator+.
  const activeCh = state.channels[state.activeChannelId];
  const canPin = isMod || !!(activeCh && activeCh.is_dm);
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
    const author = state.users[m.user_id];
    const t = new Date(m.created_at).getTime();
    const grouped = m.user_id === lastUser && t - lastTime < 5 * 60 * 1000;
    lastUser = m.user_id;
    lastTime = t;

    const editing = m.id === editingMessageId;
    const preview = editing ? null : buildLinkPreview(m.content);
    const hideUrl = preview ? extractHideURL(m.content) : null;
    const body = editing
      ? editorFor(m)
      : el("div", { class: "msg-body", html: formatMessage(m.content, state.me.username, state.emojis, { hideUrl }) + (m.edited_at ? ' <span class="edited">(edited)</span>' : "") });
    const mentionsMe = m.user_id !== state.me.id && mentionsUser(m.content, state.me.username);

    const isOwn = m.user_id === state.me.id;
    const canDelete = isOwn || isMod; // non-mods can only delete their own
    // Anyone who can see a message can react to it, so "react" is always present;
    // edit/pin/delete stay conditional.
    const actions = el("div", { class: "msg-actions" },
      el("button", { class: "link", title: "Add reaction",
        onclick: (e) => { e.stopPropagation(); openReactionPicker(m.id, e.currentTarget); } }, "react"),
      isOwn ? el("button", { class: "link", onclick: () => startEdit(m) }, "edit") : null,
      canPin ? el("button", { class: "link", onclick: () => togglePin(m) }, m.pinned_at ? "unpin" : "pin") : null,
      canDelete ? el("button", { class: "link", onclick: () => deleteMessage(m) }, "delete") : null);
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
      wrap.append(el("div", { class: cls + " grouped", "data-msg-id": m.id }, el("div", { class: "msg-gutter" }, pinMark), el("div", { class: "msg-main" }, body, preview, reactions, rowActions)));
    } else {
      const avatar = author && author.has_avatar
        ? el("div", { class: "msg-avatar", style: `background-image:url(${avatarSrc(author.id)})` })
        : el("div", { class: "msg-avatar" }, initials(author ? author.display_name : "?"));
      wrap.append(
        el("div", { class: cls, "data-msg-id": m.id },
          avatar,
          el("div", { class: "msg-main" },
            el("div", { class: "msg-head" },
              el("span", { class: "msg-author" }, author ? author.display_name : "unknown"),
              permalink,
              pinMark
            ),
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

// --- composer + message actions -----------------------------------------

function wireComposer() {
  const input = $("#composer-input");
  const popup = $("#mention-popup");
  // Unified autocomplete state for the composer popup. `kind` is "mention"
  // (@-trigger, items are user objects) or "emoji" (:-trigger, items are
  // shortcode strings); both share this one popup and the keyboard navigation
  // below. null when no completion is active.
  let completion = null; // { kind, query: { start, partial }, items, index }
  const TYPING_INTERVAL_MS = 3000;
  let lastTypingSent = 0;

  const autoGrow = () => {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  };
  autoGrow(); // size the input correctly for any value the browser may have restored

  function filterMentions(partial) {
    const q = partial.toLowerCase();
    return Object.values(state.users)
      .filter((u) => !u.disabled &&
        u.id !== state.me?.id &&
        (!activeMemberIds || activeMemberIds.has(u.id)) &&
        (u.username.toLowerCase().startsWith(q) ||
          (u.display_name && u.display_name.toLowerCase().startsWith(q)))
      )
      .sort((a, b) => a.username.localeCompare(b.username))
      .slice(0, 8);
  }

  function filterEmojis(partial) {
    const q = partial.toLowerCase();
    return Object.keys(state.emojis)
      .filter((code) => code.startsWith(q))
      .sort()
      .slice(0, 8);
  }

  // Detect which trigger (if any) sits just before the caret. @-mentions take
  // precedence over :emoji — a single caret can't satisfy both.
  function detectCompletion() {
    const pos = input.selectionStart;
    const at = atQuery(input.value, pos);
    if (at) return { kind: "mention", query: at, items: filterMentions(at.partial) };
    const colon = colonQuery(input.value, pos);
    if (colon) return { kind: "emoji", query: colon, items: filterEmojis(colon.partial) };
    return null;
  }

  function renderPopup() {
    popup.innerHTML = "";
    if (!completion) { popup.hidden = true; return; }
    completion.items.forEach((item, i) => {
      const active = i === completion.index ? " active" : "";
      if (completion.kind === "mention") {
        popup.append(el("li", {
          class: "mention-item" + active,
          onpointerdown: (e) => { e.preventDefault(); pick(item); },
        },
          el("span", { class: "mention-item-name" }, "@" + item.username),
          item.display_name && item.display_name !== item.username
            ? el("span", { class: "mention-item-display" }, item.display_name)
            : null,
        ));
      } else {
        popup.append(el("li", {
          class: "mention-item" + active,
          onpointerdown: (e) => { e.preventDefault(); pick(item); },
        },
          el("img", { class: "emoji", src: api.emojiURL(item), alt: `:${item}:` }),
          el("span", { class: "mention-item-name" }, `:${item}:`),
        ));
      }
    });
    popup.hidden = completion.items.length === 0;
  }

  function updatePopup() {
    const detected = detectCompletion();
    if (!detected) {
      completion = null;
      popup.hidden = true;
      return;
    }
    const prevIndex = completion ? completion.index : 0;
    completion = { ...detected, index: Math.min(prevIndex, Math.max(0, detected.items.length - 1)) };
    renderPopup();
  }

  // Insert the chosen completion, replacing from the trigger char to the caret:
  // "@username " for a mention (item is a user), ":shortcode: " for an emoji
  // (item is a shortcode string).
  function pick(item) {
    if (!completion) return;
    const text = completion.kind === "mention" ? "@" + item.username + " " : `:${item}: `;
    const before = input.value.slice(0, completion.query.start);
    const after = input.value.slice(input.selectionStart);
    input.value = before + text + after;
    const newPos = completion.query.start + text.length;
    input.setSelectionRange(newPos, newPos);
    completion = null;
    popup.hidden = true;
    autoGrow();
    input.focus();
  }

  input.addEventListener("input", () => {
    autoGrow();
    updatePopup();
    if (state.activeChannelId && input.value.trim()) {
      const now = Date.now();
      if (now - lastTypingSent >= TYPING_INTERVAL_MS) {
        lastTypingSent = now;
        socket && socket.send({ type: "typing", channel_id: state.activeChannelId });
      }
    }
  });

  input.addEventListener("blur", () => {
    // Small delay so a pointerdown on a popup item fires before we close it.
    setTimeout(() => { popup.hidden = true; completion = null; }, 200);
  });

  // Paste a single URL onto a non-empty selection → wrap it as a [text](url)
  // markdown link. Only fires when the clipboard is exactly one URL and there's a
  // selection; otherwise the default paste runs untouched.
  input.addEventListener("paste", (e) => {
    const url = ((e.clipboardData || window.clipboardData)?.getData("text") || "").trim();
    if (!/^https?:\/\/\S+$/.test(url)) return;
    const start = input.selectionStart, end = input.selectionEnd;
    if (start === end) return; // no selection — let the URL paste as plain text
    e.preventDefault();
    const md = `[${input.value.slice(start, end)}](${url})`;
    input.value = input.value.slice(0, start) + md + input.value.slice(end);
    const caret = start + md.length;
    input.setSelectionRange(caret, caret);
    autoGrow();
  });

  input.onkeydown = async (e) => {
    if (!popup.hidden && completion) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        completion.index = Math.min(completion.index + 1, completion.items.length - 1);
        renderPopup();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        completion.index = Math.max(completion.index - 1, 0);
        renderPopup();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        if (completion.items[completion.index]) pick(completion.items[completion.index]);
        return;
      }
      if (e.key === "Escape") {
        popup.hidden = true;
        completion = null;
        return;
      }
    }
    // Up arrow on an empty composer → edit the most recent own message.
    if (e.key === "ArrowUp" && !input.value && !editingMessageId) {
      const msgs = state.messages[state.activeChannelId] || [];
      const own = msgs.filter((m) => m.user_id === state.me.id && !m.deleted_at);
      if (own.length) { e.preventDefault(); startEdit(own[own.length - 1]); }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const content = input.value;
      if (!content.trim()) return;
      input.value = "";
      lastTypingSent = 0; // allow next keystroke to fire a fresh typing frame immediately
      autoGrow(); // collapse back to a single line after sending
      try {
        await api.sendMessage(state.activeChannelId, content);
      } catch (ex) {
        input.value = content;
        autoGrow(); // restore the box to fit the put-back text
        alert(ex.message);
      }
    }
  };
}

// --- emoji picker --------------------------------------------------------

// The shared emoji popup serves two targets: the composer (insert a token) and a
// message reaction. pickerTarget tracks which, set when the popup is opened.
let pickerTarget = { mode: "composer" };

// A small set of common Unicode emoji offered alongside the instance's custom
// emoji, so reactions aren't custom-only. These are literal graphemes (no image).
const COMMON_EMOJI = ["👍", "👎", "❤️", "😂", "😉", "😍", "🤔", "🎉", "🙌", "😮", "😢", "😡", "🙏", "🔥", "✅", "👀", "💯", "👋"];

function emojiPickerOpen() {
  const p = $("#emoji-picker");
  return p && !p.hidden;
}

function renderEmojiPicker() {
  const picker = $("#emoji-picker");
  picker.innerHTML = "";
  // Quick Unicode palette first — usable as a reaction or dropped into a message.
  for (const ch of COMMON_EMOJI) {
    picker.append(el("button", {
      type: "button", class: "emoji-choice", title: ch,
      onclick: () => chooseEmoji(ch, false),
    }, el("span", { class: "emoji-uni" }, ch)));
  }
  const codes = Object.keys(state.emojis).sort();
  if (codes.length) {
    picker.append(el("div", { class: "emoji-sep" }));
    for (const code of codes) {
      picker.append(el("button", {
        type: "button", class: "emoji-choice", title: `:${code}:`,
        onclick: () => chooseEmoji(code, true),
      }, el("img", { class: "emoji", src: api.emojiURL(code), alt: `:${code}:` })));
    }
  }
}

// chooseEmoji routes a picked emoji to the popup's current target. isCustom marks a
// custom shortcode (vs a literal Unicode glyph) — only the former is :colon:-wrapped
// when inserted into a message; as a reaction value the bare shortcode is stored.
function chooseEmoji(value, isCustom) {
  $("#emoji-picker").hidden = true;
  if (pickerTarget.mode === "react") {
    toggleReaction(pickerTarget.messageId, value);
    return;
  }
  insertIntoComposer(isCustom ? `:${value}:` : value);
}

// openReactionPicker opens the shared popup in reaction mode, floated next to the
// message control that was clicked (it otherwise lives anchored by the composer).
function openReactionPicker(messageId, anchorEl) {
  pickerTarget = { mode: "react", messageId };
  const picker = $("#emoji-picker");
  // Render off-screen first so we can measure it, then place it relative to the
  // control (flipping below if there's no room above).
  picker.style.position = "fixed";
  picker.style.left = "-9999px";
  picker.style.top = "0";
  picker.style.right = "auto";
  picker.style.bottom = "auto";
  picker.hidden = false;
  renderEmojiPicker();
  const a = anchorEl.getBoundingClientRect();
  const pr = picker.getBoundingClientRect();
  let left = Math.max(8, Math.min(a.left, window.innerWidth - pr.width - 8));
  let top = a.top - pr.height - 6;
  if (top < 8) top = a.bottom + 6;
  picker.style.left = left + "px";
  picker.style.top = top + "px";
}

function toggleEmojiPicker() {
  const picker = $("#emoji-picker");
  if (picker.hidden) {
    pickerTarget = { mode: "composer" };
    // Clear any fixed-position overrides left by a reaction pick so the popup
    // returns to its CSS anchor above the composer.
    picker.style.position = picker.style.left = picker.style.top = picker.style.right = picker.style.bottom = "";
    renderEmojiPicker();
    picker.hidden = false;
  } else {
    picker.hidden = true;
  }
}

// insertIntoComposer drops a token at the caret, padded with spaces so it reads as a
// standalone token, then fires a synthetic input event so the composer's
// autosize/typing logic runs exactly as if it were typed.
function insertIntoComposer(token) {
  const input = $("#composer-input");
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const insert = `${lead}${token} `;
  input.value = before + insert + input.value.slice(end);
  const pos = start + insert.length;
  input.setSelectionRange(pos, pos);
  $("#emoji-picker").hidden = true;
  input.focus();
  input.dispatchEvent(new Event("input"));
}

// autoGrowEdit sizes the inline-edit textarea to its content (capped by CSS).
function autoGrowEdit(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

// editorFor builds the inline editor that replaces a message's body while editing.
// Enter saves, Shift+Enter inserts a newline, Escape cancels — mirroring the
// composer. Typing updates editDraft so the text survives re-renders.
function editorFor(m) {
  const ta = el("textarea", { class: "msg-edit-input", rows: "1", "aria-label": "Edit message" });
  ta.value = editDraft;
  ta.addEventListener("input", () => { editDraft = ta.value; autoGrowEdit(ta); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(m); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
  });
  return el("div", { class: "msg-edit" },
    ta,
    el("div", { class: "msg-edit-controls" },
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
}

// --- link previews -------------------------------------------------------

// fetchLinkPreview fetches preview metadata for a bsky/twitter URL and triggers
// a re-render when done. Idempotent — a second call for a URL already in the
// cache is a no-op.
async function fetchLinkPreview(url) {
  if (linkPreviewCache.has(url)) return;
  linkPreviewCache.set(url, "loading");
  try {
    const data = await api.linkPreview(url);
    linkPreviewCache.set(url, data);
  } catch {
    linkPreviewCache.set(url, "failed");
  }
  renderMessages();
}

// buildLinkPreview returns a preview card or YouTube embed DOM node for the
// first bare previewable URL in content, or null if there is none / not ready.
function buildLinkPreview(content) {
  // YouTube embed is purely client-side — no async fetch needed.
  const ytID = extractYouTubeVideoID(content);
  if (ytID) return renderYouTubeEmbed(ytID);

  const url = extractPreviewableURL(content);
  if (!url) return null;
  const cached = linkPreviewCache.get(url);
  if (!cached) { fetchLinkPreview(url); return null; }
  if (cached === "loading" || cached === "failed") return null;
  if (!cached.title && !cached.description && !cached.image) return null;
  return renderLinkPreviewCard(url, cached);
}

function renderYouTubeEmbed(videoID) {
  const iframe = document.createElement("iframe");
  iframe.src = `https://www.youtube-nocookie.com/embed/${videoID}`;
  iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  iframe.allowFullscreen = true;
  iframe.loading = "lazy";
  return el("div", { class: "yt-embed" }, iframe);
}

function renderLinkPreviewCard(url, p) {
  const card = el("div", { class: "link-preview" });
  if (p.image) {
    card.append(el("img", { class: "link-preview-img", src: p.image, alt: "", loading: "lazy" }));
  }
  const text = el("div", { class: "link-preview-text" });
  if (p.title) text.append(el("div", { class: "link-preview-title" }, p.title));
  if (p.description) text.append(el("div", { class: "link-preview-desc" }, p.description));
  card.append(text);
  card.addEventListener("click", () => window.open(url, "_blank", "noopener,noreferrer"));
  return card;
}

// commitEdit saves the inline edit. An empty or unchanged draft just cancels (use
// delete to remove a message). On failure the editor stays open so the draft isn't
// lost; on success the message.update broadcast re-renders with the new content.
async function commitEdit(m) {
  const next = editDraft.trim();
  if (!next || next === m.content.trim()) { cancelEdit(); return; }
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
  try {
    await api.deleteMessage(m.id);
  } catch (ex) {
    alert(ex.message);
  }
}

// togglePin pins/unpins a message (mod+). The resulting message.update broadcast
// refreshes the message list and any open pins panel.
async function togglePin(m) {
  try {
    if (m.pinned_at) await api.unpinMessage(m.id);
    else await api.pinMessage(m.id);
  } catch (ex) {
    alert(ex.message);
  }
}

// --- reactions -----------------------------------------------------------

// findMessage locates a loaded message in the active channel by id.
function findMessage(messageId) {
  const arr = state.messages[state.activeChannelId] || [];
  return arr.find((m) => m.id === messageId) || null;
}

// SHORTCODE_RE matches the custom-emoji shortcode namespace: [a-z0-9_]{2,32}.
// Used to distinguish orphaned shortcodes (in reactions but no longer in the
// registry) from literal Unicode graphemes, which don't match this pattern.
const SHORTCODE_RE = /^[a-z0-9_]{2,32}$/;

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
    const isOrphan = !state.emojis[g.emoji] && SHORTCODE_RE.test(g.emoji);
    const glyph = state.emojis[g.emoji]
      ? el("img", { class: "emoji", src: api.emojiURL(g.emoji), alt: `:${g.emoji}:` })
      : isOrphan
        ? el("span", { class: "r-emoji" }, "🪦")
        : el("span", { class: "r-emoji" }, g.emoji);
    const titleText = isOrphan
      ? `${names} · :${g.emoji}: (emoji deleted${mine ? " — click to remove" : ""})`
      : names;
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
  try {
    if (mine) await api.removeReaction(messageId, emoji);
    else await api.addReaction(messageId, emoji);
  } catch (ex) {
    alert(ex.message);
  }
}

// --- pinned messages -----------------------------------------------------

async function openPinsModal() {
  if (!state.channels[state.activeChannelId]) return;
  closeDrawers();
  $("#pins-modal").hidden = false;
  await refreshPins();
}

function refreshPinsIfOpen() {
  if (!$("#pins-modal").hidden) refreshPins();
}

async function refreshPins() {
  const ch = state.channels[state.activeChannelId];
  const list = $("#pins-list");
  if (!ch) {
    list.innerHTML = "";
    return;
  }
  // A pin/unpin triggers both an explicit refresh and a realtime message.update,
  // so two refreshPins() can run at once. Build off-screen and only swap in if
  // we're still the latest call — otherwise concurrent runs double the list
  // (clear, clear, append, append) and you'd see the survivors rendered twice.
  const seq = ++pinsRefreshSeq;
  const rows = [];
  let pins;
  try {
    pins = await api.pinnedMessages(ch.id);
  } catch (ex) {
    if (seq !== pinsRefreshSeq) return;
    list.innerHTML = "";
    list.append(el("li", { class: "notice" }, ex.message));
    return;
  }
  if (seq !== pinsRefreshSeq) return; // a newer refresh superseded us
  if (!pins.length) {
    list.innerHTML = "";
    list.append(el("li", { class: "notice" }, "No pinned messages yet."));
    return;
  }
  const isMod = state.me.role === "admin" || state.me.role === "moderator";
  const canPin = isMod || ch.is_dm; // DM participants may unpin too
  for (const m of pins) {
    const author = state.users[m.user_id];
    rows.push(
      el("li", { class: "pin-row" },
        el("div", { class: "pin-head" },
          el("span", { class: "msg-author" }, author ? author.display_name : "unknown"),
          el("a", {
            class: "msg-time",
            href: permalinkHash(ch.id, m.id),
            title: "Jump to message",
            onclick: (e) => { e.preventDefault(); $("#pins-modal").hidden = true; jumpToMessage(ch.id, m.id); },
          }, formatTime(m.created_at)),
          canPin
            ? el("button", {
                class: "link", onclick: async () => {
                  try { await api.unpinMessage(m.id); await refreshPins(); } catch (ex) { alert(ex.message); }
                },
              }, "unpin")
            : null),
        el("div", { class: "msg-body", html: formatMessage(m.content, state.me.username, state.emojis) }),
        reactionsRow(m))
    );
  }
  list.innerHTML = "";
  list.append(...rows);
}

// --- message search ------------------------------------------------------

const SEARCH_PAGE = 25;
let searchSeq = 0;        // last-writer-wins token (the input is debounced + racy)
let searchQuery = "";     // the query the current results belong to
let searchCursor = 0;     // keyset: id of the oldest result loaded so far
let searchDebounce = null;

function openSearchModal() {
  closeDrawers();
  $("#search-modal").hidden = false;
  $("#search-input").focus();
  $("#search-input").select();
  // Re-run for the existing query (results may be stale); a blank box just clears.
  runSearch(true);
}

// channelLabel renders a channel's display name for a search hit, mirroring the
// header: DMs as "@ name", private as "🔒 name", public as "# name".
function channelLabel(ch) {
  if (!ch) return "unknown channel";
  if (ch.is_dm) return "@ " + dmDisplayName(ch);
  return (ch.is_private ? "🔒 " : "# ") + ch.name;
}

// runSearch fetches results for the current input. reset=true starts a fresh
// query (clears the list and cursor); reset=false appends the next older page.
// A generation token guards against the debounced/typed calls racing — only the
// latest fetch is allowed to touch the DOM.
async function runSearch(reset) {
  const q = $("#search-input").value.trim();
  const list = $("#search-results");
  const more = $("#search-more");
  if (reset) {
    searchQuery = q;
    searchCursor = 0;
  }
  if (!q) {
    searchSeq++; // cancel any in-flight fetch from a prior keystroke
    list.innerHTML = "";
    more.hidden = true;
    return;
  }
  const seq = ++searchSeq;
  more.hidden = true;
  let results;
  try {
    results = await api.search(q, { before: searchCursor || undefined, limit: SEARCH_PAGE });
  } catch (ex) {
    if (seq !== searchSeq) return;
    list.innerHTML = "";
    list.append(el("li", { class: "notice" }, ex.message));
    return;
  }
  if (seq !== searchSeq) return; // a newer search superseded us
  if (reset) list.innerHTML = "";
  if (reset && !results.length) {
    list.append(el("li", { class: "notice" }, "No messages found."));
    return;
  }
  for (const m of results) {
    const ch = state.channels[m.channel_id];
    const author = state.users[m.user_id];
    list.append(
      el("li", { class: "pin-row search-row", onclick: () => { $("#search-modal").hidden = true; jumpToMessage(m.channel_id, m.id); } },
        el("div", { class: "pin-head" },
          el("span", { class: "search-channel" }, channelLabel(ch)),
          el("span", { class: "msg-author" }, author ? author.display_name : "unknown"),
          el("span", { class: "msg-time" }, formatTime(m.created_at))),
        el("div", { class: "msg-body", html: formatMessage(m.content, state.me.username, state.emojis, { embedImages: false }) }))
    );
  }
  // A full page implies more may exist; advance the cursor to the oldest hit.
  if (results.length === SEARCH_PAGE) {
    searchCursor = results[results.length - 1].id;
    more.hidden = false;
  }
}

// --- controls: status, avatar, new channel, admin, logout ---------------

function wireControls() {
  $("#history-latest-btn").onclick = () => {
    const cid = state.activeChannelId;
    if (cid) selectChannel(cid);
  };

  $("#status-select").onchange = async (e) => {
    try {
      await api.setStatus(e.target.value);
    } catch (ex) {
      alert(ex.message);
    }
  };

  $("#me-name").onclick = openProfileModal;
  $("#me-status-text").onclick = openProfileModal;
  $("#profile-close").onclick = () => ($("#profile-modal").hidden = true);

  // Desktop-notification opt-in. Turning it on requests the OS permission;
  // turning it off just drops the in-app preference (the OS grant is sticky and
  // only the browser can revoke it).
  const notifCb = $("#notif-enable");
  if (notifCb) {
    notifCb.onchange = async () => {
      if (notifCb.checked) {
        const perm = await requestNotificationPermission();
        notifEnabled = perm === "granted";
      } else {
        notifEnabled = false;
      }
      saveNotifPref();
      renderNotifControl();
    };
  }
  $("#profile-form").onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#profile-error");
    err.textContent = "";
    const display_name = $("#profile-display").value.trim();
    const status_text = $("#profile-status-text").value.trim();
    try {
      const me = await api.updateMe({ display_name, status_text });
      state = S.upsertUser(state, me);
      state = S.setMe(state, me);
      renderMe();
      $("#profile-modal").hidden = true;
    } catch (ex) {
      err.textContent = ex.message;
    }
  };

  $("#avatar-input").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
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

  $("#logout-btn").onclick = async () => {
    try {
      await api.logout();
    } finally {
      location.reload();
    }
  };

  $("#admin-btn").onclick = openAdmin;
  $("#admin-close").onclick = () => ($("#admin-modal").hidden = true);

  $("#about-btn").onclick = () => {
    closeDrawers(); // on mobile, get the sidebar drawer out from behind the modal
    $("#about-modal").hidden = false;
  };

  // Update banner: reload to pick up the newer server build, or dismiss for now.
  $("#update-reload").onclick = () => location.reload();
  $("#update-dismiss").onclick = () => ($("#update-banner").hidden = true);

  $("#invite-btn").onclick = openInviteModal;
  $("#invite-close").onclick = () => ($("#invite-modal").hidden = true);

  $("#leave-btn").onclick = leaveActiveChannel;

  $("#pins-btn").onclick = openPinsModal;

  // Moderator+ click the channel topic to edit it inline (guarded inside).
  $("#channel-topic").onclick = beginTopicEdit;

  $("#emoji-btn").onclick = (e) => { e.stopPropagation(); toggleEmojiPicker(); };
  // Dismiss the emoji picker on any click outside it (the button toggles itself).
  document.addEventListener("click", (e) => {
    if (emojiPickerOpen() && !e.target.closest("#emoji-picker") && !e.target.closest("#emoji-btn")) {
      $("#emoji-picker").hidden = true;
    }
  });

  $("#search-btn").onclick = openSearchModal;
  $("#search-close").onclick = () => ($("#search-modal").hidden = true);
  // Debounce typing so each keystroke doesn't fire a query; Enter searches now.
  $("#search-input").addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(true), 250);
  });
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(searchDebounce);
    runSearch(true);
  });
  $("#search-more").onclick = () => runSearch(false);

  for (const m of document.querySelectorAll(".modal"))
    m.addEventListener("click", e => { if (e.target === m) m.hidden = true; });

  // Desktop: Escape closes the top-most open modal (mobile dismisses by tapping the
  // backdrop). Closing just the last-opened one lets a stacked flow unwind a step.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = [...document.querySelectorAll(".modal")].filter((m) => !m.hidden);
    if (open.length) open[open.length - 1].hidden = true;
  });

  // Mobile: the sidebar (channels/DMs) and members panel are slide-in drawers
  // toggled from the header; they share one tap-to-close backdrop.
  $("#sidebar-toggle").onclick = () => toggleDrawer("sidebar");
  $("#members-toggle").onclick = () => toggleDrawer("members");
  $("#drawer-backdrop").onclick = closeDrawers;
}

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

  for (const ev of ["mousemove", "keydown", "pointerdown", "touchstart", "scroll", "click"]) {
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

// openInviteModal lists everyone and lets you add non-members to the active
// private channel. Re-fetches the membership each open so it reflects reality.
async function openInviteModal() {
  const ch = state.channels[state.activeChannelId];
  if (!ch || !ch.is_private || ch.is_dm) return;
  closeDrawers(); // get the mobile members drawer out from behind the modal
  $("#invite-subtitle").textContent = `Add people to 🔒 ${ch.name}`;
  $("#invite-modal").hidden = false;
  await refreshInviteList(ch.id);
}

async function refreshInviteList(channelId) {
  const list = $("#invite-list");
  list.innerHTML = "";
  let members;
  try {
    members = await api.channelMembers(channelId);
  } catch (ex) {
    list.append(el("li", { class: "notice" }, ex.message));
    return;
  }
  const memberIds = new Set(members.map((m) => m.id));
  // Keep the members panel in sync as people are added to the active channel.
  if (channelId === state.activeChannelId) {
    activeMemberIds = memberIds;
    renderMembers();
  }
  const users = Object.values(state.users).sort((a, b) => a.display_name.localeCompare(b.display_name));
  for (const u of users) {
    const inChannel = memberIds.has(u.id);
    const action = inChannel
      ? el("span", { class: "invite-in" }, "in channel")
      : el("button", {
          class: "link",
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await api.addChannelMember(channelId, u.id);
              await refreshInviteList(channelId);
            } catch (ex) {
              alert(ex.message);
              e.target.disabled = false;
            }
          },
        }, "add");
    list.append(
      el("li", { class: "invite-row" },
        el("span", { class: `dot ${presenceClass(u)}` }),
        el("span", { class: "member-name" }, u.display_name),
        action)
    );
  }
}

function openChannelModal() {
  closeDrawers(); // get the mobile drawer out from behind the modal
  $("#channel-create-error").textContent = "";
  $("#channel-new-name").value = "";
  $("#channel-new-topic").value = "";
  $("#channel-new-private").checked = false;
  $("#channel-modal").hidden = false;
  $("#channel-new-name").focus();
}

function openProfileModal() {
  closeDrawers(); // get the mobile drawer out from behind the modal
  const me = state.users[state.me.id] || state.me;
  $("#profile-error").textContent = "";
  $("#profile-display").value = me.display_name || "";
  $("#profile-status-text").value = me.status_text || "";
  renderNotifControl();
  $("#profile-modal").hidden = false;
  $("#profile-display").focus();
}

// --- admin panel ---------------------------------------------------------

async function refreshAdminStats() {
  const box = $("#admin-stats");
  try {
    const s = await api.adminStats();
    const stat = (label, value) => {
      const wrap = el("div", { class: "admin-stat" });
      wrap.append(el("span", { class: "admin-stat-value" }, String(value)));
      wrap.append(el("span", { class: "admin-stat-label" }, label));
      return wrap;
    };
    box.innerHTML = "";
    box.append(
      stat("users", s.total_users),
      stat("active", s.active_users),
      stat("connected", s.connected),
      stat("public ch", s.public_channels),
      stat("private ch", s.private_channels),
      stat("DMs", s.dm_channels),
      stat("messages", s.total_messages),
    );
  } catch {
    box.textContent = "";
  }
}

async function openAdmin() {
  closeDrawers(); // get the mobile drawer out from behind the modal
  $("#admin-modal").hidden = false;
  refreshAdminStats();
  await refreshAdminUsers();
  await refreshAdminEmojis();
  await refreshDeletedChannels();
  await refreshAdminBotTokens();

  // Populate the user picker for the bot-token form from the already-loaded roster.
  const tokenUserSel = $("#admin-token-user");
  tokenUserSel.innerHTML = "";
  Object.values(state.users)
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
    .forEach((u) => tokenUserSel.append(
      el("option", { value: u.id }, `${u.display_name} (${u.username})`),
    ));

  $("#admin-emoji-form").onsubmit = async (e) => {
    e.preventDefault();
    const out = $("#admin-emoji-out");
    out.textContent = "";
    const shortcode = $("#admin-emoji-shortcode").value.trim().toLowerCase();
    const file = $("#admin-emoji-file").files[0];
    if (!file) {
      out.textContent = "Choose an image.";
      return;
    }
    try {
      await api.uploadEmoji(shortcode, file);
      $("#admin-emoji-shortcode").value = "";
      $("#admin-emoji-file").value = "";
      await refreshAdminEmojis();
    } catch (ex) {
      out.textContent = ex.message;
    }
  };

  $("#admin-token-form").onsubmit = async (e) => {
    e.preventDefault();
    const out = $("#admin-token-out");
    out.textContent = "";
    const name = $("#admin-token-name").value.trim();
    const userId = parseInt($("#admin-token-user").value, 10);
    try {
      const result = await api.createBotToken(name, userId);
      out.innerHTML = "";
      out.append(
        el("div", { class: "notice" }, "Token created. Copy it now — it won't be shown again:"),
        el("input", { class: "linkbox", readonly: "readonly", value: result.token,
          onclick: (e) => e.target.select() }),
      );
      $("#admin-token-name").value = "";
      await refreshAdminBotTokens();
    } catch (ex) {
      out.textContent = ex.message;
    }
  };

  $("#admin-create-form").onsubmit = async (e) => {
    e.preventDefault();
    const username = $("#admin-new-username").value.trim().toLowerCase();
    const display = $("#admin-new-display").value.trim();
    const role = $("#admin-new-role").value;
    const out = $("#admin-create-out");
    out.textContent = "";
    try {
      const u = await api.createUser(username, display, role);
      const link = await api.createMagicLink(u.id);
      out.innerHTML = "";
      out.append(
        el("div", { class: "notice" }, `Created ${u.username}. Share this one-time link:`),
        el("input", { class: "linkbox", readonly: "readonly", value: link.url, onclick: (e) => e.target.select() })
      );
      $("#admin-new-username").value = "";
      $("#admin-new-display").value = "";
      await refreshAdminUsers();
    } catch (ex) {
      out.textContent = ex.message;
    }
  };
}

async function refreshAdminUsers() {
  const users = await api.users();
  const tbody = $("#admin-user-rows");
  tbody.innerHTML = "";
  for (const u of users) {
    const roleSel = el("select", { onchange: async (e) => {
      try { await api.setRole(u.id, e.target.value); } catch (ex) { alert(ex.message); e.target.value = u.role; }
    }});
    for (const r of ["member", "moderator", "admin"]) {
      const opt = el("option", { value: r }, r);
      if (u.role === r) opt.selected = true;
      roleSel.append(opt);
    }
    const activeBtn = el("button", { class: "link", onclick: async () => {
      try { await api.setActive(u.id, !u.is_active); await refreshAdminUsers(); } catch (ex) { alert(ex.message); }
    }}, u.is_active ? "disable" : "enable");
    const linkBtn = el("button", { class: "link", onclick: async () => {
      try {
        const link = await api.createMagicLink(u.id);
        prompt("One-time link (copy it):", link.url);
      } catch (ex) { alert(ex.message); }
    }}, "reset link");
    tbody.append(
      el("tr", {},
        el("td", {}, u.username),
        el("td", {}, u.display_name),
        el("td", {}, roleSel),
        el("td", {}, u.has_password ? "yes" : "no"),
        el("td", {}, u.is_active ? "active" : "disabled"),
        el("td", {}, linkBtn, document.createTextNode(" "), activeBtn)
      )
    );
  }
}

// refreshAdminEmojis renders the custom-emoji grid with delete controls. Realtime
// emoji.add/emoji.delete events also call refreshAdminEmojisIfOpen so the list
// stays current if another admin changes it while the panel is open. An upload
// fires both an explicit refresh and (via its own broadcast echo) a realtime one,
// so two runs can overlap — we fetch FIRST, then clear+append in one synchronous
// block, making concurrent runs last-writer-wins (always the full list once,
// never doubled).
async function refreshAdminEmojis() {
  const box = $("#admin-emoji-list");
  let list;
  try {
    list = await api.emojis();
  } catch (ex) {
    box.innerHTML = "";
    box.append(el("span", { class: "notice" }, ex.message));
    return;
  }
  box.innerHTML = "";
  if (!list.length) {
    box.append(el("span", { class: "notice" }, "No custom emojis yet."));
    return;
  }
  for (const e of list) {
    const del = el("button", {
      class: "link danger", title: `Delete :${e.shortcode}:`, onclick: async () => {
        if (!confirm(`Delete :${e.shortcode}:? Messages using it will show the literal text.`)) return;
        try { await api.deleteEmoji(e.shortcode); await refreshAdminEmojis(); } catch (ex) { alert(ex.message); }
      },
    }, "✕");
    box.append(el("span", { class: "admin-emoji" },
      el("img", { src: api.emojiURL(e.shortcode), alt: `:${e.shortcode}:` }),
      el("code", {}, `:${e.shortcode}:`),
      del));
  }
}

function refreshAdminEmojisIfOpen() {
  if (!$("#admin-modal").hidden) refreshAdminEmojis();
}

// refreshDeletedChannels renders archived channels with restore / permanent-delete
// controls (admin only; restore brings the channel and its history back, purge
// erases it and frees the name).
async function refreshDeletedChannels() {
  const tbody = $("#admin-deleted-channel-rows");
  tbody.innerHTML = "";
  let chans;
  try {
    chans = await api.archivedChannels();
  } catch (ex) {
    tbody.append(el("tr", {}, el("td", { colspan: "4", class: "notice" }, ex.message)));
    return;
  }
  if (!chans.length) {
    tbody.append(el("tr", {}, el("td", { colspan: "4", class: "notice" }, "No deleted channels.")));
    return;
  }
  for (const ch of chans) {
    const restoreBtn = el("button", {
      class: "link", onclick: async () => {
        try { await api.restoreChannel(ch.id); await refreshDeletedChannels(); } catch (ex) { alert(ex.message); }
      },
    }, "restore");
    const purgeBtn = el("button", {
      class: "link danger", onclick: async () => {
        if (!confirm(`Permanently delete #${ch.name}? This erases its entire message history and cannot be undone.`)) return;
        try { await api.purgeChannel(ch.id); await refreshDeletedChannels(); } catch (ex) { alert(ex.message); }
      },
    }, "delete permanently");
    const type = ch.is_dm ? "dm" : ch.is_private ? "private" : "public";
    tbody.append(
      el("tr", {},
        el("td", {}, (ch.is_private || ch.is_dm ? "🔒 " : "# ") + ch.name),
        el("td", {}, type),
        el("td", {}, ch.archived_at ? formatTime(ch.archived_at) : ""),
        el("td", {}, restoreBtn, document.createTextNode(" "), purgeBtn)
      )
    );
  }
}

async function refreshAdminBotTokens() {
  const box = $("#admin-token-list");
  let tokens;
  try {
    tokens = await api.listBotTokens();
  } catch (ex) {
    box.innerHTML = "";
    box.append(el("span", { class: "notice" }, ex.message));
    return;
  }
  box.innerHTML = "";
  if (!tokens.length) {
    box.append(el("span", { class: "notice" }, "No bot tokens yet."));
    return;
  }
  const table = el("table", { class: "admin-table" });
  const thead = el("thead");
  thead.append(el("tr", {},
    el("th", {}, "name"), el("th", {}, "user"), el("th", {}, "created"), el("th", {}),
  ));
  table.append(thead);
  const tbody = el("tbody");
  for (const t of tokens) {
    const user = state.users[t.user_id];
    const userLabel = user ? user.username : `#${t.user_id}`;
    const revokeBtn = el("button", { class: "link danger", onclick: async () => {
      if (!confirm(`Revoke token "${t.name}"? Any script using it will immediately lose access.`)) return;
      try { await api.deleteBotToken(t.id); await refreshAdminBotTokens(); } catch (ex) { alert(ex.message); }
    }}, "revoke");
    tbody.append(el("tr", {},
      el("td", {}, t.name),
      el("td", {}, userLabel),
      el("td", {}, formatTime(t.created_at)),
      el("td", {}, revokeBtn),
    ));
  }
  table.append(tbody);
  box.append(table);
}

// --- helpers -------------------------------------------------------------

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

// firePing alerts the user to a ping (DM or @-mention): always a soft chime, plus
// an OS notification when they've opted in and aren't already looking here.
function firePing(evt, ch) {
  boop();
  if (!shouldNotify({ permission: currentPermission(), enabled: notifEnabled, focused: !tabUnfocused() })) {
    return;
  }
  const author = state.users[evt.payload.user_id];
  const who = author ? author.display_name : "Someone";
  const title = ch && ch.is_dm ? who : `${who} in #${ch ? ch.name : "channel"}`;
  showNotification(title, {
    body: evt.payload.content || "",
    tag: `rivendell-ch-${evt.payload.channel_id}`,
    icon: author && author.has_avatar ? api.avatarURL(author.id) : undefined,
    onclick: () => selectChannel(evt.payload.channel_id),
  });
}

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
  else if (notifEnabled && perm === "granted") status.textContent = "On — you'll be notified of DMs and @-mentions when this tab isn't focused.";
  else status.textContent = "Off — turn on to get desktop alerts for DMs and @-mentions.";
}

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
  // Repaint the DM header dot if we're in a DM (DMs never have a topic-edit input,
  // so this call is always safe — no risk of blowing an in-progress topic edit).
  const ch = state.channels[state.activeChannelId];
  if (ch && ch.is_dm) renderChannelHeader(ch);
}

function schedulePresenceUpdate(evt) {
  const uid = evt.payload.user_id;
  if (state.me && uid === state.me.id) { applyPresence(evt); return; } // self: immediate
  const pending = pendingPresence.get(uid);
  if (pending) { clearTimeout(pending); pendingPresence.delete(uid); }
  const cur = state.users[uid];
  if (!cur) return; // unknown user — setPresence would no-op anyway
  // The incoming value already matches what we're showing: a prior flip has
  // reverted within the window, so drop it without repainting.
  if (S.presenceMatches(cur, evt.payload)) return;
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

// presenceClass maps a user to a presence-dot color class. Offline (or invisible)
// users are grey regardless of their stored status; online users get their
// status color (online=green, away=amber, dnd=red). Idle shares away's amber —
// auto-idle and user-set "away" are intentionally indistinguishable.
function presenceClass(u) {
  if (!u.online) return "offline";
  if (u.idle) return "away";
  if (u.status === "away" || u.status === "dnd") return u.status;
  return "online";
}

// avatarSrc returns the avatar URL for a user, with a cache-bust token appended
// when we know their avatar changed this session (see avatarVersion).
function avatarSrc(userId) {
  const v = avatarVersion[userId];
  const base = api.avatarURL(userId);
  return v ? `${base}?v=${v}` : base;
}

function initials(name) {
  return (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
}

boot();
