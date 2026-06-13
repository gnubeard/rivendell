// search.js — the message-search modal controller.
//
// This is a DOM-carrying feature module: it owns the search UI's racy state (a
// last-writer-wins generation token, the current query, the keyset paging
// cursor, and the input debounce) and renders hits into the modal. The caller
// (app.js) supplies the element builder and a few navigation hooks, and wires
// DOM events to the returned methods. Behavior is pinned by web/e2e/search.spec.js
// (there is little pure logic to unit-test — the value is in the racy DOM path,
// which only a real browser reproduces).
import { api } from "./api.js?v=__RIVENDELL_VERSION__";
import { formatMessage } from "./format.js?v=__RIVENDELL_VERSION__";
import { formatTime } from "./util.js?v=__RIVENDELL_VERSION__";
import { dmDisplayName } from "./channelorder.js?v=__RIVENDELL_VERSION__";

export const SEARCH_PAGE = 25;

// createSearch builds the search controller. The caller binds DOM events to the
// returned { open, onInput, runNow, more } methods.
//
// deps:
//   el          — element builder (app.js)
//   $           — querySelector helper (app.js); $(sel) is scoped to document
//   getState    — () => current app state (read at call time; state is reassigned)
//   jumpToMessage(channelId, messageId) — navigate to a hit's message
//   closeDrawers() — collapse the mobile drawers when the modal opens
export function createSearch({ el, $, getState, jumpToMessage, closeDrawers }) {
  let seq = 0;        // last-writer-wins token (the input is debounced + racy)
  let query = "";     // the query the current results belong to
  let cursor = 0;     // keyset: id of the oldest result loaded so far
  let debounce = null;

  // channelLabel renders a channel's display name for a search hit, mirroring the
  // header: DMs as "@ name", private as "🔒 name", public as "# name".
  function channelLabel(ch) {
    if (!ch) return "unknown channel";
    if (ch.is_dm) return "@ " + dmDisplayName(getState(), ch);
    return (ch.is_private ? "🔒 " : "# ") + ch.name;
  }

  // run fetches results for the current input. reset=true starts a fresh query
  // (clears the list and cursor); reset=false appends the next older page. The
  // generation token guards against the debounced/typed calls racing — only the
  // latest fetch is allowed to touch the DOM.
  async function run(reset) {
    const q = $("#search-input").value.trim();
    const list = $("#search-results");
    const more = $("#search-more");
    if (reset) {
      query = q;
      cursor = 0;
    }
    if (!q) {
      seq++; // cancel any in-flight fetch from a prior keystroke
      list.innerHTML = "";
      more.hidden = true;
      return;
    }
    const mySeq = ++seq;
    more.hidden = true;
    let results;
    try {
      results = await api.search(q, { before: cursor || undefined, limit: SEARCH_PAGE });
    } catch (ex) {
      if (mySeq !== seq) return;
      list.innerHTML = "";
      list.append(el("li", { class: "notice" }, ex.message));
      return;
    }
    if (mySeq !== seq) return; // a newer search superseded us
    // Fetch channel metadata for any result from a channel not in local state
    // (e.g. a closed DM). Batch by unique id to avoid redundant fetches.
    const cur = getState();
    const unknownIds = [...new Set(results.map((m) => m.channel_id).filter((id) => !cur.channels[id]))];
    const fetchedChannels = {};
    await Promise.all(unknownIds.map(async (id) => {
      try { fetchedChannels[id] = await api.getChannel(id); } catch (_) {}
    }));
    if (mySeq !== seq) return;
    if (reset) list.innerHTML = "";
    if (reset && !results.length) {
      list.append(el("li", { class: "notice" }, "No messages found."));
      return;
    }
    const st = getState();
    for (const m of results) {
      const ch = st.channels[m.channel_id] || fetchedChannels[m.channel_id];
      const author = st.users[m.user_id];
      list.append(
        el("li", { class: "pin-row search-row", onclick: () => { $("#search-modal").hidden = true; jumpToMessage(m.channel_id, m.id); } },
          el("div", { class: "pin-head" },
            el("span", { class: "search-channel" }, channelLabel(ch)),
            el("span", { class: "msg-author" }, author ? author.display_name : "unknown"),
            el("span", { class: "msg-time" }, formatTime(m.created_at))),
          el("div", { class: "msg-body", html: formatMessage(m.content, st.me.username, st.emojis, { embedImages: false, channels: st.channels, users: st.users }) }))
      );
    }
    // A full page implies more may exist; advance the cursor to the oldest hit.
    if (results.length === SEARCH_PAGE) {
      cursor = results[results.length - 1].id;
      more.hidden = false;
    }
  }

  // open reveals and focuses the modal, re-running the existing query (results
  // may be stale; a blank box just clears).
  function open() {
    closeDrawers();
    $("#search-modal").hidden = false;
    $("#search-input").focus();
    $("#search-input").select();
    run(true);
  }

  // onInput debounces typing so each keystroke doesn't fire a query.
  function onInput() {
    clearTimeout(debounce);
    debounce = setTimeout(() => run(true), 250);
  }

  // runNow searches immediately (form submit / Enter), cancelling a pending
  // debounced run.
  function runNow() {
    clearTimeout(debounce);
    run(true);
  }

  // more appends the next older page of hits.
  function more() {
    run(false);
  }

  return { open, onInput, runNow, more };
}
