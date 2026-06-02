// app.js — the Snug web client. Wires the API, websocket, formatter, and the
// pure state reducer to the DOM. Deliberately framework-free.

import { api } from "./api.js";
import { connectRealtime } from "./ws.js";
import { formatMessage } from "./format.js";
import * as S from "./state.js";

let state = S.initialState();
let socket = null;

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

// --- bootstrapping -------------------------------------------------------

async function boot() {
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
  if (state.channelOrder.length) {
    state = S.setActiveChannel(state, state.channelOrder[0]);
  }
  renderMe();
  renderChannels();
  renderMembers();
  renderAdminVisibility();
  if (state.activeChannelId) await loadChannel(state.activeChannelId);
  startRealtime();
  wireComposer();
  wireControls();
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
      }
      if (evt.type.startsWith("channel")) renderChannels();
      if (evt.type.startsWith("message")) {
        const cid = evt.payload.channel_id;
        if (cid === state.activeChannelId) renderMessages();
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

function renderChannels() {
  const list = $("#channel-list");
  list.innerHTML = "";
  for (const id of state.channelOrder) {
    const ch = state.channels[id];
    const active = id === state.activeChannelId;
    list.append(
      el("li", { class: active ? "channel active" : "channel", onclick: () => selectChannel(id) },
        el("span", { class: "ch-hash" }, ch.is_private ? "🔒" : "#"),
        el("span", { class: "ch-name" }, ch.name)
      )
    );
  }
}

function renderMembers() {
  const list = $("#member-list");
  list.innerHTML = "";
  const users = Object.values(state.users).sort((a, b) => {
    if (!!b.online !== !!a.online) return b.online ? 1 : -1;
    return a.display_name.localeCompare(b.display_name);
  });
  for (const u of users) {
    list.append(
      el("li", { class: "member" },
        el("span", { class: u.online ? "dot online" : "dot offline" }),
        el("span", { class: "member-name" }, u.display_name),
        el("span", { class: "member-status" }, u.status === "dnd" ? "do not disturb" : (u.online ? u.status : "offline"))
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

async function selectChannel(id) {
  state = S.setActiveChannel(state, id);
  renderChannels();
  await loadChannel(id);
}

async function loadChannel(id) {
  const ch = state.channels[id];
  $("#channel-title").textContent = ch ? (ch.is_private ? "🔒 " : "# ") + ch.name : "";
  $("#channel-topic").textContent = ch ? ch.topic : "";
  try {
    const msgs = await api.messages(id, { limit: 50 });
    state = S.setMessages(state, id, msgs);
    renderMessages();
  } catch (ex) {
    $("#message-list").innerHTML = "";
    $("#message-list").append(el("div", { class: "notice" }, ex.message));
  }
}

function renderMessages() {
  const wrap = $("#message-list");
  const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
  wrap.innerHTML = "";
  const msgs = state.messages[state.activeChannelId] || [];
  let lastUser = null;
  let lastTime = 0;
  for (const m of msgs) {
    const author = state.users[m.user_id];
    const t = new Date(m.created_at).getTime();
    const grouped = m.user_id === lastUser && t - lastTime < 5 * 60 * 1000;
    lastUser = m.user_id;
    lastTime = t;

    const body = m.deleted_at
      ? el("div", { class: "msg-body deleted" }, "message deleted")
      : el("div", { class: "msg-body", html: formatMessage(m.content) + (m.edited_at ? ' <span class="edited">(edited)</span>' : "") });

    const canManage = !m.deleted_at && (m.user_id === state.me.id || state.me.role === "admin" || state.me.role === "moderator");
    const actions = canManage
      ? el("div", { class: "msg-actions" },
          m.user_id === state.me.id ? el("button", { class: "link", onclick: () => startEdit(m) }, "edit") : null,
          el("button", { class: "link", onclick: () => deleteMessage(m) }, "delete"))
      : null;

    if (grouped) {
      wrap.append(el("div", { class: "msg grouped" }, el("div", { class: "msg-gutter" }), el("div", { class: "msg-main" }, body, actions)));
    } else {
      const avatar = author && author.has_avatar
        ? el("div", { class: "msg-avatar", style: `background-image:url(${api.avatarURL(author.id)})` })
        : el("div", { class: "msg-avatar" }, initials(author ? author.display_name : "?"));
      wrap.append(
        el("div", { class: "msg" },
          avatar,
          el("div", { class: "msg-main" },
            el("div", { class: "msg-head" },
              el("span", { class: "msg-author" }, author ? author.display_name : "unknown"),
              el("span", { class: "msg-time" }, formatTime(m.created_at))
            ),
            body,
            actions
          )
        )
      );
    }
  }
  if (atBottom) wrap.scrollTop = wrap.scrollHeight;
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

// --- controls: status, avatar, new channel, admin, logout ---------------

function wireControls() {
  $("#status-select").onchange = async (e) => {
    try {
      await api.setStatus(e.target.value);
    } catch (ex) {
      alert(ex.message);
    }
  };

  $("#me-status-text").onclick = async () => {
    const next = prompt("Set your status text:", (state.users[state.me.id] || state.me).status_text || "");
    if (next == null) return;
    const me = await api.updateMe({ status_text: next });
    state = S.upsertUser(state, me);
    state = S.setMe(state, me);
    renderMe();
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

  $("#new-channel-btn").onclick = async () => {
    const name = prompt("New channel name (a-z, 0-9, hyphen):");
    if (!name) return;
    const isPrivate = confirm("Make this channel private? (OK = private)");
    try {
      await api.createChannel(name.toLowerCase(), "", isPrivate);
    } catch (ex) {
      alert(ex.message);
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
}

// --- admin panel ---------------------------------------------------------

async function openAdmin() {
  $("#admin-modal").hidden = false;
  await refreshAdminUsers();

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

// --- helpers -------------------------------------------------------------

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
