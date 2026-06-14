// mobilectx.js — the mobile long-press message action sheet (the search.js
// feature-module method). A bottom-sheet of message actions (react, reply,
// forward, copy, edit, pin, mark read, delete) plus a reactions sub-panel, shown
// when a message row is long-pressed on a touch device.
//
// It owns no app state — it builds DOM and dispatches to actions that live in
// app.js, all injected. The long-press gesture detection and the backdrop-tap
// wiring stay in app.js (wireMobileContextMenu), calling openMobileCtx/
// closeMobileCtx. e2e/mobile-ctx.spec is the net.
//
// Deps: el, $, getState (() => state, read fresh), api (emojiURL), emojiPicker
// (openForReaction), and the message actions startReply, openForwardModal,
// startEdit, togglePin, toggleMessageRead, deleteMessage.

import { canModerate } from "./state.js?v=__RIVENDELL_VERSION__";

export function createMobileCtx({
  el, $, getState, api, emojiPicker,
  startReply, openForwardModal, startEdit, togglePin, toggleMessageRead, deleteMessage,
}) {
  // openMobileCtx shows the bottom-sheet action menu for a message.
  function openMobileCtx(m) {
    $("#mobile-ctx").hidden = false;
    showActions(m);
  }

  function showActions(m) {
    const state = getState();
    const isMod = canModerate(state.me);
    const isOwn = m.user_id === state.me.id;
    const canDelete = isOwn || isMod;
    const isDeleted = !!m.deleted_at;
    const activeCh = state.channels[state.activeChannelId];
    const inner = $("#mobile-ctx-inner");
    inner.innerHTML = "";

    const closeBtn = (label, handler, cls) => el("button", {
      class: "mobile-ctx-btn" + (cls ? " " + cls : ""),
      onclick: () => { closeMobileCtx(); handler(); },
    }, label);

    // stopPropagation prevents the document-level click handler that dismisses the
    // emoji picker from firing on the same event that opens it.
    inner.append(el("button", {
      class: "mobile-ctx-btn",
      onclick: (e) => {
        e.stopPropagation();
        closeMobileCtx();
        emojiPicker.openForReaction(m.id, {
          getBoundingClientRect: () => ({
            left: window.innerWidth / 2 - 119,
            right: window.innerWidth / 2 + 119,
            top: window.innerHeight - 60,
            bottom: window.innerHeight - 40,
          }),
        });
      },
    }, "😊  React"));

    if (!isDeleted) inner.append(closeBtn("↩  Reply", () => startReply(m)));
    if (!isDeleted) inner.append(closeBtn("↪  Forward", () => openForwardModal(m)));
    if (!isDeleted) inner.append(closeBtn("📋  Copy", () => navigator.clipboard.writeText(m.content)));
    if (isOwn && !isDeleted) inner.append(closeBtn("✏  Edit", () => startEdit(m)));
    if ((isMod || !!(activeCh && activeCh.is_dm)) && !isDeleted) inner.append(closeBtn(m.pinned_at ? "📌  Unpin" : "📌  Pin", () => togglePin(m)));
    const isRead = m.id <= (state.lastRead[m.channel_id] || 0);
    inner.append(closeBtn(isRead ? "👁  Mark unread" : "👁  Mark read", () => toggleMessageRead(m)));

    if (canDelete && !isDeleted) {
      inner.append(el("div", { class: "mobile-ctx-sep" }));
      inner.append(closeBtn("🗑  Delete", () => deleteMessage(m), "danger"));
    }

    if (m.reactions && m.reactions.length > 0) {
      inner.append(el("div", { class: "mobile-ctx-sep" }));
      inner.append(el("button", {
        class: "mobile-ctx-btn",
        onclick: () => showReactions(m),
      }, "👁  Reactions (" + m.reactions.length + ")"));
    }
  }

  function showReactions(m) {
    const state = getState();
    const inner = $("#mobile-ctx-inner");
    inner.innerHTML = "";
    inner.append(el("button", { class: "mobile-ctx-btn", onclick: () => showActions(m) }, "← Back"));
    inner.append(el("div", { class: "mobile-ctx-sep" }));
    const panel = el("div", { class: "mobile-ctx-reactions" });
    if (!m.reactions || !m.reactions.length) {
      panel.append(el("p", { class: "mobile-ctx-no-reactions" }, "No reactions"));
    } else {
      for (const g of m.reactions) {
        const ids = g.user_ids || [];
        const names = ids.map((id) => (state.users[id] ? state.users[id].display_name : "someone")).join(", ");
        const glyph = state.emojis[g.emoji]
          ? el("img", { class: "emoji", src: api.emojiURL(g.emoji), alt: `:${g.emoji}:`, style: "height:1.3rem;width:auto;" })
          : el("span", {}, g.emoji);
        panel.append(el("div", { class: "mobile-ctx-reaction-row" },
          el("span", { class: "mobile-ctx-reaction-emoji" }, glyph),
          el("span", { class: "mobile-ctx-reaction-names" }, names || "—")));
      }
    }
    inner.append(panel);
  }

  function closeMobileCtx() {
    $("#mobile-ctx").hidden = true;
  }

  return { openMobileCtx, closeMobileCtx };
}
