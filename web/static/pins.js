// pins.js — the pinned-messages modal (the search.js feature-module method). It
// owns the panel that lists a channel's pinned messages, the jump-to-message
// links, and the in-panel unpin action. The 📌 message-action that toggles a pin
// (togglePin) stays in app.js next to message rendering; this module is only the
// read-side panel.
//
// It holds no app state beyond its own last-writer-wins refresh token: a pin/unpin
// fires both an explicit refresh and a realtime message.update, so two refreshes
// can overlap. Each refresh claims a sequence number and only mutates the DOM if
// it's still the latest — otherwise concurrent runs would double the list (clear,
// clear, append, append). Don't drop the seq guard.
//
// Deps: el (element builder), $ (querySelector), getState (() => state, read
// fresh), api (pinnedMessages/unpinMessage), jumpToMessage, closeDrawers, and
// reactionsRow (the shared message reactions row, which lives in app.js with the
// `mine` invariant). permalinkHash/formatMessage/formatTime are imported directly.

import { permalinkHash, formatMessage } from "./format.js?v=__RIVENDELL_VERSION__";
import { formatTime } from "./util.js?v=__RIVENDELL_VERSION__";

export function createPins({ el, $, getState, api, jumpToMessage, closeDrawers, reactionsRow }) {
  let refreshSeq = 0; // last-writer-wins token for concurrent refresh() calls

  async function openPinsModal() {
    const state = getState();
    if (!state.channels[state.activeChannelId]) return;
    closeDrawers();
    $("#pins-modal").hidden = false;
    await refresh();
  }

  function refreshPinsIfOpen() {
    if (!$("#pins-modal").hidden) refresh();
  }

  async function refresh() {
    const state = getState();
    const ch = state.channels[state.activeChannelId];
    const list = $("#pins-list");
    if (!ch) {
      list.innerHTML = "";
      return;
    }
    const seq = ++refreshSeq;
    const rows = [];
    let pins;
    try {
      pins = await api.pinnedMessages(ch.id);
    } catch (ex) {
      if (seq !== refreshSeq) return;
      list.innerHTML = "";
      list.append(el("li", { class: "notice" }, ex.message));
      return;
    }
    if (seq !== refreshSeq) return; // a newer refresh superseded us
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
                    try { await api.unpinMessage(m.id); await refresh(); } catch (ex) { alert(ex.message); }
                  },
                }, "unpin")
              : null),
          el("div", { class: "msg-body", html: formatMessage(m.content, state.me.username, state.emojis, { channels: state.channels, users: state.users }) }),
          reactionsRow(m))
      );
    }
    list.innerHTML = "";
    list.append(...rows);
  }

  return { openPinsModal, refreshPinsIfOpen };
}
