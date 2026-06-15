// modals.js — the modal cluster (the search.js feature-module method). Four
// independent, DOM-building dialogs that were scattered in app.js:
//   - openChannelModal: the new-channel form (reset + show; the submit handler
//     stays in app.js's wireChannelControls, like other form wiring)
//   - openProfileModal: the edit-your-profile form (populate + show; the save
//     handler stays in app.js)
//   - openInviteModal / refreshInviteList: add people to a private channel
//   - openUserCard: the read-only profile card for any user (own card routes to
//     the editable profile modal)
//
// These build DOM and show/hide dialogs; they own no app state. The two couplings
// to app.js state are injected as side-effect callbacks (the convention), so the
// state stays owned by app.js:
//   - onProfileOpen(): refresh the profile modal's notif + push-to-talk sub-controls
//     (renderNotifControl / pttCapturing reset / renderPttControl live in app.js)
//   - onActiveMembersChanged(memberIds): the invite modal mutated the active
//     channel's member set + re-rendered the members panel
//
// Deps: el, $, getState (() => state, read fresh), api, closeDrawers, avatarSrc,
// startDM, plus the two callbacks above. presenceClass/normalizeTheme/
// formatMessage/initials are imported directly.

import { presenceClass } from "./presence.js";
import { normalizeTheme } from "./prefs.js";
import { formatMessage } from "./format.js";
import { initials } from "./util.js";

export function createModals({
  el, $, getState, api, closeDrawers, avatarSrc, startDM,
  onProfileOpen, onActiveMembersChanged,
}) {
  // openInviteModal lists everyone and lets you add non-members to the active
  // private channel. Re-fetches the membership each open so it reflects reality.
  async function openInviteModal() {
    const state = getState();
    const ch = state.channels[state.activeChannelId];
    if (!ch || !ch.is_private || ch.is_dm) return;
    closeDrawers(); // get the mobile members drawer out from behind the modal
    $("#invite-subtitle").textContent = `Add people to 🔒 ${ch.name}`;
    $("#invite-modal").hidden = false;
    await refreshInviteList(ch.id);
  }

  async function refreshInviteList(channelId) {
    const state = getState();
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
      onActiveMembersChanged(memberIds);
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
    const state = getState();
    closeDrawers(); // get the mobile drawer out from behind the modal
    const me = state.users[state.me.id] || state.me;
    $("#profile-error").textContent = "";
    $("#profile-display").value = me.display_name || "";
    $("#profile-status-text").value = me.status_text || "";
    $("#profile-pronouns").value = me.pronouns || "";
    $("#profile-bio").value = me.bio || "";
    $("#profile-theme").value = normalizeTheme(me.theme);
    onProfileOpen(); // refresh notif + push-to-talk sub-controls (owned by app.js)
    $("#profile-modal").hidden = false;
    $("#profile-display").focus();
  }

  // openUserCard shows a read-only profile card for any user. The full roster
  // (incl. pronouns/bio) already lives in state.users, so no fetch is needed;
  // clicking your own card just routes to the editable profile modal.
  async function openUserCard(userId) {
    const state = getState();
    const u = state.users[userId];
    if (!u) return;
    if (u.id === state.me.id) { openProfileModal(); return; }
    closeDrawers();
    const card = $("#user-card");
    card.innerHTML = "";
    const avatar = u.has_avatar
      ? el("div", { class: "user-card-avatar", style: `background-image:url(${avatarSrc(u.id)})` })
      : el("div", { class: "user-card-avatar" }, initials(u.display_name));
    const badges = el("div", { class: "user-card-badges" },
      u.role === "admin" || u.role === "moderator"
        ? el("span", { class: "bot-badge" }, u.role) : null,
      u.is_bot ? el("span", { class: "bot-badge" }, "bot") : null);

    const noteTextarea = el("textarea", {
      class: "user-card-note",
      placeholder: "Private notes (only you can see these)",
      rows: 3,
      maxlength: 2000,
    });
    const noteLabel = el("label", { class: "user-card-note-label" }, "Notes");
    noteLabel.append(noteTextarea);

    let noteSaveTimer = null;
    const saveNote = async () => {
      try { await api.putUserNote(u.id, noteTextarea.value); } catch (_) {}
    };
    noteTextarea.oninput = () => {
      clearTimeout(noteSaveTimer);
      noteSaveTimer = setTimeout(saveNote, 1000);
    };
    noteTextarea.onblur = () => {
      clearTimeout(noteSaveTimer);
      saveNote();
    };

    card.append(...[
      avatar,
      el("div", { class: "user-card-name" },
        el("span", {}, u.display_name),
        u.pronouns ? el("span", { class: "user-card-pronouns" }, u.pronouns) : null),
      el("div", { class: "user-card-handle" }, "@" + u.username),
      badges,
      u.status_text ? el("div", { class: "user-card-status" }, u.status_text) : null,
      u.bio
        ? el("div", { class: "user-card-bio", html: formatMessage(u.bio, state.me.username, state.emojis, { embedImages: false, channels: state.channels, users: state.users }) })
        : null,
      el("div", { class: "user-card-since hint" }, "Member since " + new Date(u.created_at).toLocaleDateString()),
      el("button", { class: "primary small", onclick: () => { $("#user-modal").hidden = true; startDM(u.id); } }, "Message"),
      noteLabel,
    ].filter(x => x != null));
    $("#user-modal").hidden = false;

    try {
      const { note } = await api.getUserNote(u.id);
      noteTextarea.value = note;
    } catch (_) {}
  }

  return { openInviteModal, openChannelModal, openProfileModal, openUserCard };
}
