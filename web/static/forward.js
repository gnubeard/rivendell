// forward.js — the "forward a message to another channel" feature (the search.js
// feature-module method). It owns the forward modal: the target picker, the
// name filter, and the send-then-jump action. It holds no shared app state — the
// modal is opened with a message and reads everything else through getState().
//
// Two pure cores live here and are unit-tested (web/test/forward.test.js):
//   - forwardBody: what a forward actually sends. A CHANNEL message forwards as a
//     permalink (which renders as an embed card in the target via the link-preview
//     path); a DM message forwards as a quoted "*Forwarded:*" copy instead,
//     because a DM permalink only resolves for that DM's two members — an embed
//     would be dead for everyone else.
//   - forwardTargets: the filtered target list. Hides DM rows whose other member
//     can't see the source (a permalink forward would be a dead embed for them),
//     and narrows by the name needle. makeCanSee builds that audience predicate,
//     mirroring the server's audienceForChannel (members + every mod/admin).
//
// Deps: el (element builder), $ (querySelector), getState (() => state, read
// fresh), api (channelMembers/sendMessage), jumpToMessage, and origin (defaults
// to location.origin; injectable so the body assembly stays unit-testable).

import { permalinkHash } from "./format.js";
import { dmDisplayName } from "./channelorder.js";
import { otherDMParticipant } from "./state.js";

// forwardBody builds the text a forward sends (see the module header). Pure;
// origin is passed in (location.origin at runtime) so it needs no DOM.
export function forwardBody(m, fromDM, srcChannelId, origin) {
  if (!fromDM) return `${origin}/${permalinkHash(srcChannelId, m.id)}`;
  const quoted = (m.content || "").split("\n").map((l) => "> " + l).join("\n");
  return `*Forwarded:*\n${quoted}`;
}

// makeCanSee builds the "who can open a permalink to the source channel" predicate
// for a private non-DM source: its members plus every mod/admin, mirroring the
// server's audienceForChannel. Pure (memberIds: Set, users: id→user map).
export function makeCanSee(memberIds, users) {
  return (uid) => memberIds.has(uid) || ["admin", "moderator"].includes((users[uid] || {}).role);
}

// forwardTargets returns the [{ id, label }] list to render in the picker, in
// sidebar order. canSee (or null for no filtering) hides DM rows whose other
// member can't see the source; needle narrows by case-insensitive label match.
// Pure — takes the whole state slice it needs and returns plain data.
export function forwardTargets(state, canSee, needle) {
  const q = (needle || "").trim().toLowerCase();
  const out = [];
  for (const id of state.channelOrder) {
    const ch = state.channels[id];
    if (!ch) continue;
    if (ch.is_dm && canSee) {
      const other = otherDMParticipant(ch, state.me.id);
      if (other == null || !canSee(other)) continue;
    }
    const label = ch.is_dm ? dmDisplayName(state, ch) : "#" + ch.name;
    if (q && !label.toLowerCase().includes(q)) continue;
    out.push({ id, label });
  }
  return out;
}

export function createForward({ el, $, getState, api, jumpToMessage, origin = location.origin }) {
  // openForwardModal shows the picker to forward message m. It resolves the
  // source's audience predicate (one API call for a private channel), then wires
  // the filter and renders the live target list.
  async function openForwardModal(m) {
    if (m.deleted_at) return;
    const state = getState();
    const srcChannelId = state.activeChannelId;
    const srcCh = state.channels[srcChannelId];
    const fromDM = !!(srcCh && srcCh.is_dm);

    // For a private non-DM source, hide DM targets whose other member couldn't
    // open the permalink (dead embed). Public channels / DM copies: no filtering.
    let canSee = null;
    if (!fromDM && srcCh && srcCh.is_private) {
      try {
        const ids = new Set((await api.channelMembers(srcChannelId)).map((u) => u.id));
        canSee = makeCanSee(ids, state.users);
      } catch {
        canSee = null; // on error, don't over-hide
      }
    }

    const list = $("#forward-list");
    const filter = $("#forward-filter");

    // Keyboard state: `items` is the flat list of rendered <li> rows in order
    // (rebuilt every render); `activeIndex` is the highlight the arrow keys move
    // and Enter picks. The list is a single column, so a flat index step is all
    // the navigation needs (unlike the emoji grid's geometric moveVertical).
    let items = [];
    let activeIndex = -1;

    const setActive = (i) => {
      if (activeIndex >= 0 && items[activeIndex]) items[activeIndex].removeAttribute("aria-selected");
      activeIndex = items.length ? Math.max(0, Math.min(i, items.length - 1)) : -1;
      if (activeIndex < 0) return;
      const row = items[activeIndex];
      row.setAttribute("aria-selected", "true");
      row.scrollIntoView({ block: "nearest" });
    };

    const choose = async (id) => {
      $("#forward-modal").hidden = true;
      try {
        // Follow the message to where it landed rather than leaving the user
        // where they were.
        const sent = await api.sendMessage(id, forwardBody(m, fromDM, srcChannelId, origin), null);
        if (sent && sent.id) await jumpToMessage(id, sent.id);
      } catch (ex) {
        alert("Failed to forward: " + ex.message);
      }
    };

    const render = () => {
      list.innerHTML = "";
      items = [];
      activeIndex = -1;
      for (const { id, label } of forwardTargets(getState(), canSee, filter.value)) {
        const row = el("li", { class: "invite-item", role: "option", onclick: () => choose(id) }, label);
        row.choose = () => choose(id);
        items.push(row);
        list.append(row);
      }
      setActive(0); // highlight the first match so Enter forwards without arrowing
    };

    // Arrow keys move the highlight, Enter forwards to it. Escape stays unhandled
    // so the modal's existing close path runs.
    filter.onkeydown = (e) => {
      if (e.key === "ArrowDown") setActive(activeIndex + 1);
      else if (e.key === "ArrowUp") setActive(activeIndex - 1);
      else if (e.key === "Enter") {
        if (activeIndex >= 0 && items[activeIndex]) items[activeIndex].choose();
      } else return;
      e.preventDefault();
    };

    filter.value = "";
    filter.oninput = render;
    render();
    $("#forward-modal").hidden = false;
    filter.focus();
  }

  return { openForwardModal };
}
