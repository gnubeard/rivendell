// admin.js — the admin/moderator settings panel (the search.js feature-module
// method). Owns the whole #admin-panel: instance stats, the user table (role /
// active / reset-link / avatar controls), invitations, bot tokens, deleted
// channels, and the shared custom-emoji manager. It carries its own DOM and
// fetches its own data — it writes NO shared app state, only reads state.users
// through getState — so the net is web/e2e/admin.spec.js (no pure core to unit-
// test; the cache/list logic is plain fetch-then-render).
//
// The emoji manager lives here because this is where emojis are administered;
// it's also reached from the emoji picker's ➕ and refreshed by realtime
// emoji.add/emoji.delete events, so openEmojiManager and refreshEmojiManagerIfOpen
// are exported alongside openAdmin.
//
// Deps: el/$ (DOM helpers), getState (() => state, read fresh — state is
// reassigned on every update), api, closeDrawers (get the mobile drawer out from
// behind the panel), fileTooLarge (app.js's DOM adapter over the pure size
// check), getMaxAvatarBytes (() => the server's avatar ceiling).

import { formatTime } from "./util.js?v=__RIVENDELL_VERSION__";

export function createAdminPanel({ el, $, getState, api, closeDrawers, fileTooLarge, getMaxAvatarBytes }) {
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
    closeDrawers(); // get the mobile drawer out from behind the panel
    $("#admin-panel").hidden = false;
    refreshAdminStats();
    await refreshAdminUsers();
    await refreshAdminInvitations();
    await refreshDeletedChannels();
    await refreshAdminBotTokens();

    // Populate the user picker for the bot-token form from the already-loaded roster.
    const tokenUserSel = $("#admin-token-user");
    tokenUserSel.innerHTML = "";
    Object.values(getState().users)
      .sort((a, b) => a.display_name.localeCompare(b.display_name))
      .forEach((u) => tokenUserSel.append(
        el("option", { value: u.id }, `${u.display_name} (${u.username})`),
      ));

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

    $("#admin-invite-create").onclick = async () => {
      const out = $("#admin-invite-out");
      out.textContent = "";
      try {
        const inv = await api.createInvitation();
        out.innerHTML = "";
        out.append(
          el("div", { class: "notice" }, "Invitation created. Share this one-time link:"),
          el("input", { class: "linkbox", readonly: "readonly", value: inv.url, onclick: (e) => e.target.select() }),
        );
        await refreshAdminInvitations();
      } catch (ex) {
        out.textContent = ex.message;
      }
    };
  }

  // refreshAdminInvitations renders the issued-invitation list with revoke controls.
  // Pending links can be re-copied; redeemed/expired ones are shown for the record
  // and can be cleaned up. The raw token is never returned by the list endpoint, so
  // only the just-created link (shown above) is copyable.
  async function refreshAdminInvitations() {
    const box = $("#admin-invite-list");
    let invites;
    try {
      invites = await api.listInvitations();
    } catch (ex) {
      box.innerHTML = "";
      box.append(el("span", { class: "notice" }, ex.message));
      return;
    }
    box.innerHTML = "";
    if (!invites.length) {
      box.append(el("span", { class: "notice" }, "No invitations issued yet."));
      return;
    }
    const state = getState();
    const now = Date.now();
    const table = el("table", { class: "admin-table" });
    const thead = el("thead");
    thead.append(el("tr", {},
      el("th", {}, "status"), el("th", {}, "created"), el("th", {}, "expires"), el("th", {}),
    ));
    table.append(thead);
    const tbody = el("tbody");
    for (const inv of invites) {
      let status;
      if (inv.used_at) {
        const who = inv.used_by && state.users[inv.used_by];
        status = who ? `used by ${who.username}` : "used";
      } else if (new Date(inv.expires_at).getTime() <= now) {
        status = "expired";
      } else {
        status = "pending";
      }
      const delBtn = el("button", { class: "link danger", onclick: async () => {
        const verb = inv.used_at ? "Delete this used invitation record" : "Revoke this invitation link";
        if (!confirm(`${verb}?`)) return;
        try { await api.deleteInvitation(inv.id); await refreshAdminInvitations(); } catch (ex) { alert(ex.message); }
      }}, inv.used_at ? "delete" : "revoke");
      tbody.append(el("tr", {},
        el("td", {}, status),
        el("td", {}, formatTime(inv.created_at)),
        el("td", {}, formatTime(inv.expires_at)),
        el("td", {}, delBtn),
      ));
    }
    table.append(tbody);
    box.append(table);
  }

  async function refreshAdminUsers() {
    const users = await api.users();
    const tbody = $("#admin-user-rows");
    tbody.innerHTML = "";
    for (const u of users) {
      const roleSel = el("select", { onchange: async (e) => {
        const val = e.target.value;
        const wasBot = u.is_bot;
        try {
          if (val === "bot") {
            await api.setBot(u.id, true);
          } else {
            if (wasBot) await api.setBot(u.id, false);
            if (val !== u.role) await api.setRole(u.id, val);
          }
          await refreshAdminUsers();
        } catch (ex) { alert(ex.message); e.target.value = wasBot ? "bot" : u.role; }
      }});
      for (const r of ["member", "moderator", "admin", "bot"]) {
        const opt = el("option", { value: r }, r);
        if (u.is_bot ? r === "bot" : r === u.role) opt.selected = true;
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

      const avatarInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif",
        style: "display:none",
        onchange: async (e) => {
          const file = e.target.files[0];
          e.target.value = ""; // allow re-picking the same file after a rejection
          if (!file) return;
          if (fileTooLarge(file, getMaxAvatarBytes(), "avatar")) return;
          try { await api.adminUploadAvatar(u.id, file); await refreshAdminUsers(); } catch (ex) { alert(ex.message); }
        },
      });
      const avatarBtn = el("button", { class: "link", onclick: () => avatarInput.click() }, "avatar");
      const avatarCell = el("td", {}, avatarBtn);
      if (u.has_avatar) {
        const clearBtn = el("button", { class: "link danger", onclick: async () => {
          try { await api.adminClearAvatar(u.id); await refreshAdminUsers(); } catch (ex) { alert(ex.message); }
        }}, "✕");
        avatarCell.append(document.createTextNode(" "), clearBtn);
      }
      avatarCell.append(avatarInput);

      const statusCell = el("td", {}, u.is_active ? "active" : "disabled");

      tbody.append(
        el("tr", {},
          el("td", {}, u.username),
          el("td", {}, u.display_name),
          el("td", {}, roleSel),
          el("td", {}, u.has_password ? "yes" : "no"),
          statusCell,
          el("td", {}, linkBtn, document.createTextNode(" "), activeBtn),
          avatarCell,
        )
      );
    }
  }

  // openEmojiManager shows the custom-emoji modal (moderator+) and renders its list.
  // It's the single interface for managing emojis — reached from the emoji picker's
  // ➕ and from the admin panel's "Manage custom emojis" button.
  function openEmojiManager() {
    $("#emoji-manager-out").textContent = "";
    $("#emoji-manager-modal").hidden = false;
    refreshEmojiManager();
  }

  // refreshEmojiManager renders the custom-emoji grid with delete controls. Realtime
  // emoji.add/emoji.delete events also call refreshEmojiManagerIfOpen so the list
  // stays current if someone else changes it while the modal is open. An upload
  // fires both an explicit refresh and (via its own broadcast echo) a realtime one,
  // so two runs can overlap — we fetch FIRST, then clear+append in one synchronous
  // block, making concurrent runs last-writer-wins (always the full list once,
  // never doubled).
  async function refreshEmojiManager() {
    const box = $("#emoji-manager-list");
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
          try { await api.deleteEmoji(e.shortcode); await refreshEmojiManager(); } catch (ex) { alert(ex.message); }
        },
      }, "✕");
      box.append(el("span", { class: "admin-emoji" },
        el("img", { src: api.emojiURL(e.shortcode), alt: `:${e.shortcode}:` }),
        el("code", {}, `:${e.shortcode}:`),
        del));
    }
  }

  function refreshEmojiManagerIfOpen() {
    if (!$("#emoji-manager-modal").hidden) refreshEmojiManager();
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
    const state = getState();
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

  return { openAdmin, openEmojiManager, refreshEmojiManagerIfOpen };
}
