// app.js — the Snug web client. Wires the API, websocket, formatter, and the
// pure state reducer to the DOM. Deliberately framework-free.

import { api } from "./api.js";
import { connectRealtime } from "./ws.js";
import { formatMessage } from "./format.js";
import * as S from "./state.js";

let state = S.initialState();
let socket = null;
// Member ids of the active channel when it's private (incl. DMs); null means
// "show everyone" (public channels have no membership rows).
let activeMemberIds = null;

// Scrollback state: messages load a page at a time as you scroll up.
const PAGE = 50;
let loadingOlder = false; // guards against overlapping fetches
const historyComplete = new Set(); // channelIds whose oldest message is loaded

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
    const h = Math.round(vv ? vv.height : window.innerHeight);
    document.documentElement.style.setProperty("--app-height", `${h}px`);
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
    const { name } = await api.instance();
    if (!name) return;
    document.title = name;
    for (const node of document.querySelectorAll(".brand")) node.textContent = name;
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
  // Prefer opening a real channel over a DM on first load.
  const firstChannel = regularChannelOrder()[0] || state.channelOrder[0];
  if (firstChannel) {
    state = S.setActiveChannel(state, firstChannel);
  }
  renderMe();
  renderChannels();
  renderDMs();
  renderMembers();
  renderAdminVisibility();
  if (state.activeChannelId) await loadChannel(state.activeChannelId);
  // Wire interactive controls BEFORE realtime, so a transport problem can never
  // leave the composer/admin/avatar handlers unattached.
  wireComposer();
  wireControls();
  wireScrollback();
  try {
    startRealtime();
  } catch (e) {
    console.warn("snug: realtime unavailable:", e && e.message);
  }
}

// --- realtime ------------------------------------------------------------

function startRealtime() {
  if (socket) socket.close();
  socket = connectRealtime(
    (evt) => {
      state = S.applyEvent(state, evt);
      // Targeted re-renders based on event type.
      if (evt.type.startsWith("presence") || evt.type === "user.update") {
        renderMembers();
        renderMe();
        renderDMs(); // a DM row shows the other participant's name + presence
      }
      if (evt.type.startsWith("channel")) {
        renderChannels();
        renderDMs();
        // Membership may have changed (e.g. someone was invited) — re-scope the
        // members panel if the event concerns the channel we're viewing.
        if (evt.payload && evt.payload.id === state.activeChannelId) refreshActiveMembers();
      }
      if (evt.type.startsWith("message")) {
        const cid = evt.payload.channel_id;
        if (cid === state.activeChannelId) {
          renderMessages();
          refreshPinsIfOpen(); // a pin/unpin arrives as a message.update
        } else if (evt.type === "message.new" && evt.payload.user_id !== state.me.id) {
          // A new message in a channel we're not looking at: flag it unread.
          state = S.bumpUnread(state, cid);
          renderChannels();
          renderDMs();
          // Chime for DMs (directed at you); channels get the silent badge only.
          const ch = state.channels[cid];
          if (ch && ch.is_dm) boop();
        }
      }
    },
    (online) => {
      $("#conn-status").className = online ? "conn online" : "conn offline";
      $("#conn-status").title = online ? "Connected" : "Reconnecting…";
    }
  );
}

// --- rendering -----------------------------------------------------------

function renderMe() {
  const me = state.users[state.me.id] || state.me;
  $("#me-name").textContent = me.display_name;
  $("#me-status-text").textContent = me.status_text || "";
  $("#me-avatar").style.backgroundImage = me.has_avatar ? `url(${api.avatarURL(me.id)}?t=${Date.now()})` : "";
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

function renderChannels() {
  const list = $("#channel-list");
  list.innerHTML = "";
  const isMod = state.me.role === "admin" || state.me.role === "moderator";
  const order = regularChannelOrder();
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const ch = state.channels[id];
    const active = id === state.activeChannelId;
    const controls = isMod
      ? el("span", { class: "ch-controls" },
          el("button", { class: "ch-ctl", title: "Move up", disabled: i === 0 ? "disabled" : null,
            onclick: (e) => { e.stopPropagation(); moveChannel(id, -1); } }, "↑"),
          el("button", { class: "ch-ctl", title: "Move down", disabled: i === order.length - 1 ? "disabled" : null,
            onclick: (e) => { e.stopPropagation(); moveChannel(id, +1); } }, "↓"),
          el("button", { class: "ch-ctl danger", title: "Delete channel",
            onclick: (e) => { e.stopPropagation(); deleteChannel(id); } }, "✕"))
      : null;
    const unread = state.unread[id] || 0;
    const cls = "channel" + (active ? " active" : "") + (unread ? " unread" : "");
    list.append(
      el("li", { class: cls, onclick: () => selectChannel(id) },
        el("span", { class: "ch-hash" }, ch.is_private ? "🔒" : "#"),
        el("span", { class: "ch-name" }, ch.name),
        unread ? el("span", { class: "unread-badge" }, String(unread)) : null,
        controls
      )
    );
  }
}

function renderDMs() {
  const list = $("#dm-list");
  list.innerHTML = "";
  const dms = state.channelOrder.filter((id) => state.channels[id].is_dm);
  $("#dm-head").hidden = dms.length === 0;
  for (const id of dms) {
    const ch = state.channels[id];
    const active = id === state.activeChannelId;
    const otherId = S.otherDMParticipant(ch, state.me.id);
    const other = otherId != null ? state.users[otherId] : null;
    const unread = state.unread[id] || 0;
    const cls = "channel" + (active ? " active" : "") + (unread ? " unread" : "");
    list.append(
      el("li", { class: cls, onclick: () => selectChannel(id) },
        el("span", { class: `dot ${other ? presenceClass(other) : "offline"}` }),
        el("span", { class: "ch-name" }, other ? other.display_name : ch.name),
        unread ? el("span", { class: "unread-badge" }, String(unread)) : null
      )
    );
  }
}

function renderMembers() {
  const list = $("#member-list");
  list.innerHTML = "";
  // In a private channel/DM, restrict the panel to that channel's members.
  let users = Object.values(state.users);
  if (activeMemberIds) users = users.filter((u) => activeMemberIds.has(u.id));
  users.sort((a, b) => {
    if (!!b.online !== !!a.online) return b.online ? 1 : -1;
    return a.display_name.localeCompare(b.display_name);
  });
  for (const u of users) {
    const isSelf = u.id === state.me.id;
    const presence = u.status === "dnd" ? "do not disturb" : (u.online ? u.status : "offline");
    // Show the user's custom status text when they've set one; otherwise fall
    // back to the presence word. The title always carries the presence state.
    const statusLine = u.status_text ? u.status_text : presence;
    const titleParts = [presence];
    if (!isSelf) titleParts.unshift(`Message ${u.display_name}`);
    list.append(
      el("li", {
        class: isSelf ? "member" : "member clickable",
        title: titleParts.join(" · "),
        onclick: isSelf ? null : () => startDM(u.id),
      },
        el("span", { class: `dot ${presenceClass(u)}` }),
        el("div", { class: "member-text" },
          el("span", { class: "member-name" }, u.display_name),
          el("span", { class: "member-status", title: u.status_text || null }, statusLine))
      )
    );
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

// startDM create-or-finds the DM channel with a user and opens it.
async function startDM(userId) {
  try {
    const ch = await api.createDM(userId);
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
  state = S.setActiveChannel(state, id);
  state = S.clearUnread(state, id);
  renderChannels();
  renderDMs();
  closeDrawers(); // on mobile, reveal the conversation after a pick
  await loadChannel(id);
}

async function loadChannel(id) {
  const ch = state.channels[id];
  if (ch && ch.is_dm) {
    $("#channel-title").textContent = "@ " + dmDisplayName(ch);
    $("#channel-topic").textContent = "";
  } else {
    $("#channel-title").textContent = ch ? (ch.is_private ? "🔒 " : "# ") + ch.name : "";
    $("#channel-topic").textContent = ch ? ch.topic : "";
  }
  // Invite affordance only makes sense for a real private channel (not DMs/public).
  $("#invite-btn").hidden = !(ch && ch.is_private && !ch.is_dm);
  $("#pins-btn").hidden = !ch;
  await refreshActiveMembers();
  loadingOlder = false;
  try {
    const msgs = await api.messages(id, { limit: PAGE });
    state = S.setMessages(state, id, msgs);
    // A short first page means there's nothing older to scroll back to.
    if (msgs.length < PAGE) historyComplete.add(id);
    else historyComplete.delete(id);
    renderMessages();
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
    console.warn("snug: could not load older messages:", ex && ex.message);
  } finally {
    loadingOlder = false;
  }
}

// wireScrollback attaches the scroll listener once; #message-list is reused
// across channel switches (only its innerHTML changes), so this stays valid.
function wireScrollback() {
  const wrap = $("#message-list");
  wrap.addEventListener("scroll", () => {
    if (wrap.scrollTop < 120) loadOlderMessages();
  });
}

function renderMessages() {
  const wrap = $("#message-list");
  const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
  const prevTop = wrap.scrollTop; // clearing innerHTML resets scrollTop; restore it below
  wrap.innerHTML = "";
  const msgs = state.messages[state.activeChannelId] || [];
  const isMod = state.me.role === "admin" || state.me.role === "moderator";
  let lastUser = null;
  let lastTime = 0;
  let i = 0;
  while (i < msgs.length) {
    // Collapse a run of consecutive deleted messages into a single line so
    // tombstones don't eat vertical space.
    if (msgs[i].deleted_at) {
      let j = i;
      while (j < msgs.length && msgs[j].deleted_at) j++;
      const n = j - i;
      wrap.append(
        el("div", { class: "msg deleted-run" },
          el("div", { class: "msg-gutter" }),
          el("div", { class: "msg-main" },
            el("div", { class: "msg-body deleted" }, n === 1 ? "message deleted" : `${n} messages deleted`)))
      );
      lastUser = null;
      lastTime = 0;
      i = j;
      continue;
    }

    const m = msgs[i];
    const author = state.users[m.user_id];
    const t = new Date(m.created_at).getTime();
    const grouped = m.user_id === lastUser && t - lastTime < 5 * 60 * 1000;
    lastUser = m.user_id;
    lastTime = t;

    const body = el("div", { class: "msg-body", html: formatMessage(m.content) + (m.edited_at ? ' <span class="edited">(edited)</span>' : "") });

    const canManage = m.user_id === state.me.id || isMod;
    const actions = canManage
      ? el("div", { class: "msg-actions" },
          m.user_id === state.me.id ? el("button", { class: "link", onclick: () => startEdit(m) }, "edit") : null,
          isMod ? el("button", { class: "link", onclick: () => togglePin(m) }, m.pinned_at ? "unpin" : "pin") : null,
          el("button", { class: "link", onclick: () => deleteMessage(m) }, "delete"))
      : null;
    const pinMark = m.pinned_at ? el("span", { class: "pin-mark", title: "Pinned" }, "📌") : null;
    const cls = m.pinned_at ? "msg pinned" : "msg";

    if (grouped) {
      wrap.append(el("div", { class: cls + " grouped" }, el("div", { class: "msg-gutter" }, pinMark), el("div", { class: "msg-main" }, body, actions)));
    } else {
      const avatar = author && author.has_avatar
        ? el("div", { class: "msg-avatar", style: `background-image:url(${api.avatarURL(author.id)})` })
        : el("div", { class: "msg-avatar" }, initials(author ? author.display_name : "?"));
      wrap.append(
        el("div", { class: cls },
          avatar,
          el("div", { class: "msg-main" },
            el("div", { class: "msg-head" },
              el("span", { class: "msg-author" }, author ? author.display_name : "unknown"),
              el("span", { class: "msg-time" }, formatTime(m.created_at)),
              pinMark
            ),
            body,
            actions
          )
        )
      );
    }
    i++;
  }
  // Follow the conversation when already at the bottom; otherwise hold the
  // reader's position (loadOlderMessages adjusts further for prepended history).
  if (atBottom) wrap.scrollTop = wrap.scrollHeight;
  else wrap.scrollTop = prevTop;
}

// --- composer + message actions -----------------------------------------

function wireComposer() {
  const input = $("#composer-input");
  input.onkeydown = async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const content = input.value;
      if (!content.trim()) return;
      input.value = "";
      try {
        await api.sendMessage(state.activeChannelId, content);
      } catch (ex) {
        input.value = content;
        alert(ex.message);
      }
    }
  };
}

async function startEdit(m) {
  const next = prompt("Edit message:", m.content);
  if (next == null || next === m.content) return;
  try {
    await api.editMessage(m.id, next);
  } catch (ex) {
    alert(ex.message);
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
  list.innerHTML = "";
  if (!ch) return;
  let pins;
  try {
    pins = await api.pinnedMessages(ch.id);
  } catch (ex) {
    list.append(el("li", { class: "notice" }, ex.message));
    return;
  }
  if (!pins.length) {
    list.append(el("li", { class: "notice" }, "No pinned messages yet."));
    return;
  }
  const isMod = state.me.role === "admin" || state.me.role === "moderator";
  for (const m of pins) {
    const author = state.users[m.user_id];
    list.append(
      el("li", { class: "pin-row" },
        el("div", { class: "pin-head" },
          el("span", { class: "msg-author" }, author ? author.display_name : "unknown"),
          el("span", { class: "msg-time" }, formatTime(m.created_at)),
          isMod
            ? el("button", {
                class: "link", onclick: async () => {
                  try { await api.unpinMessage(m.id); await refreshPins(); } catch (ex) { alert(ex.message); }
                },
              }, "unpin")
            : null),
        el("div", { class: "msg-body", html: formatMessage(m.content) }))
    );
  }
}

// --- controls: status, avatar, new channel, admin, logout ---------------

function wireControls() {
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
      state = S.upsertUser(state, me);
      state = S.setMe(state, me);
      renderMe();
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

  $("#invite-btn").onclick = openInviteModal;
  $("#invite-close").onclick = () => ($("#invite-modal").hidden = true);

  $("#pins-btn").onclick = openPinsModal;
  $("#pins-close").onclick = () => ($("#pins-modal").hidden = true);

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
  $("#profile-modal").hidden = false;
  $("#profile-display").focus();
}

// --- admin panel ---------------------------------------------------------

async function openAdmin() {
  closeDrawers(); // get the mobile drawer out from behind the modal
  $("#admin-modal").hidden = false;
  await refreshAdminUsers();
  await refreshDeletedChannels();

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

// --- helpers -------------------------------------------------------------

// presenceClass maps a user to a presence-dot color class. Offline (or invisible)
// users are grey regardless of their stored status; online users get their
// status color (online=green, away=amber, dnd=red).
function presenceClass(u) {
  if (!u.online) return "offline";
  if (u.status === "away" || u.status === "dnd") return u.status;
  return "online";
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
