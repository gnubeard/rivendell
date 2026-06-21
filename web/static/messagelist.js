// messagelist.js — the message-row construction cluster, carved out of app.js.
//
// createMessageList(deps) returns the pure row builders that turn a message + its
// state into DOM: messageRow (the core), the leaf renderers (renderDeletedRun /
// renderSystemMessage), and the small geometry/context helpers the incremental-patch
// paths share (groupingAnchor / insertionPointFor / rowContextFor). It is READ-ONLY
// on state and the view flags — it renders; app.js owns every mutation and the
// orchestration layer (renderMessages / appendMessageRow / patchMessageRow /
// showOptimisticSend) that calls these. Per-row ACTIONS route through app.js's
// document-level data-act dispatch, so these builders hold no closures over app
// state — the lone exception is buildReplyQuote's jump, which takes jumpToMessage as
// a stable dep (the sibling-factory convention).

import { formatMessage, mentionsUser, permalinkHash, extractHideURL, classifyReaction, reactionTooltip, replySnippet } from "./format.js";
import { formatTime, initials } from "./util.js";
import { canModerate } from "./state.js";
import { groupingAnchor as computeGroupingAnchor } from "./grouping.js";

/**
 * @typedef {Object} MessageListDeps
 * @property {(tag:string, attrs?:object, ...kids:any)=>Element} el  DOM micro-builder
 * @property {()=>object} getState  the live state world-model (read fresh, never mutated here)
 * @property {()=>{editingMessageId:(number|null), flashMessageId:(number|null)}} getViewFlags  read-only view flags
 * @property {(m:object)=>Element} editorFor  inline editor element (owned by app.js)
 * @property {(content:string)=>(Element|null)} buildLinkPreview  link/embed preview card
 * @property {(userId:number)=>string} avatarSrc  avatar URL (cache-busted)
 * @property {(code:string)=>string} emojiURL  custom-emoji image URL
 * @property {(channelId:number, messageId:number)=>void} jumpToMessage  reply-quote jump target
 * @property {(id:number)=>boolean} isLiveDeleted  did this id earn a visible tombstone this session
 */

/**
 * createMessageList builds the pure message-row renderers carved out of app.js.
 * READ-ONLY on state + view flags: it constructs DOM from state reads only, while
 * app.js owns all mutation and the orchestration that drives these.
 * @param {MessageListDeps} deps
 */
export function createMessageList(deps) {
  const { el, getState, getViewFlags, editorFor, buildLinkPreview, avatarSrc, emojiURL, jumpToMessage, isLiveDeleted } = deps;

  // embedRemoveButton builds the author-only "remove embed" control (a light ×) shown
  // on a preview card or a bare-URL inline image. Clicking edits the message to wrap
  // `url` in <> so the embed/image collapses to a plain link. The delegated handler
  // (data-act="remove-embed") preventDefaults so the surrounding anchor (the image
  // link / og card) doesn't navigate on the same click; it carries the URL on data-url.
  function embedRemoveButton(m, url) {
    return el("button", {
      class: "embed-remove",
      title: "Remove embed",
      "aria-label": "Remove embed",
      "data-act": "remove-embed",
      "data-url": url,
    }, "×");
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
  // ownership/role flags the caller computed (isOwn/canPin/canDelete). Each button
  // carries only a data-act tag — the document-level delegated handler
  // (wireDelegatedClicks) resolves the message off the enclosing data-msg-id row and
  // runs the action, so this renderer holds no closures over app state.
  function messageActions(m, { isOwn, canPin, canDelete, isRead }) {
    return el("div", { class: "msg-actions" },
      el("button", { class: "msg-act", title: "Add reaction", "data-act": "react" }, "😄"),
      el("button", { class: "msg-act", title: "Reply", "data-act": "reply" }, "↩"),
      !m.deleted_at ? el("button", { class: "msg-act", title: "Forward to another channel", "data-act": "forward" }, "↗") : null,
      el("button", { class: "msg-act msg-read-toggle", title: isRead ? "Mark unread" : "Mark read", "data-act": "read-toggle" }, "👁"),
      isOwn ? el("button", { class: "msg-act", title: "Edit", "data-act": "edit" }, "✏") : null,
      canPin ? el("button", { class: "msg-act", title: m.pinned_at ? "Unpin" : "Pin", "data-act": "pin" }, "📌") : null,
      canDelete ? el("button", { class: "msg-act danger", title: "Delete", "data-act": "delete" }, "🗑") : null);
  }

  // buildReplyQuote renders the small "↪ Author: snippet" reference shown above a
  // reply. The parent is looked up in the loaded window; if it isn't loaded (it may
  // predate the current page) we still render a clickable stub — jumpToMessage fetches
  // the surrounding window on click. A soft-deleted parent shows a tombstone. The
  // snippet is plain text (text node), so it carries no XSS risk.
  function buildReplyQuote(m) {
    if (!m.reply_to_id) return null;
    const state = getState();
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
    const state = getState();
    const row = el("div", { class: "reactions" });
    for (const g of m.reactions) {
      const ids = g.user_ids || [];
      const { mine, isCustom, isOrphan, disabled } = classifyReaction(g, state.emojis, state.me.id);
      const names = ids.map((id) => (state.users[id] ? state.users[id].display_name : "someone")).join(", ");
      const glyph = isCustom
        ? el("img", { class: "emoji", src: emojiURL(g.emoji), alt: `:${g.emoji}:` })
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
        // The pill carries its OWN data-msg-id (not just the enclosing row) plus the
        // rendered "mine", so the delegated react-toggle stays correct even when the
        // message isn't in the active window — the pins modal renders pills for pins
        // it fetched itself, where findMessage(id) would be null. A disabled (orphan)
        // pill gets no data-act, so the dispatch never fires for it.
        "data-act": disabled ? null : "react-toggle",
        "data-msg-id": m.id,
        "data-emoji": g.emoji,
        "data-mine": String(mine),
      }, glyph, el("span", { class: "r-count" }, String(ids.length))));
    }
    return row;
  }

  // renderDeletedRun collapses a run of consecutive deleted messages starting at
  // `start`. Only messages deleted live this session (liveDeleted) earn a visible
  // "N deleted" tombstone; a run that arrived already-deleted from history renders
  // nothing — so a reopened channel isn't littered with old tombstones. Returns the
  // index past the run and whether a tombstone was drawn (the caller resets grouping
  // only when one was — an invisible run must not break a group).
  //
  // Reciprocal contract with pruneLiveDeleted: this function only ever draws a tombstone
  // for an id still present (as a deleted row) in a loaded window, so it is SAFE for
  // pruneLiveDeleted to drop any liveDeleted id that is in no loaded window. pruneLiveDeleted
  // is called from exactly one site (loadChannel, at the window-replace GC point). Don't
  // widen the prune without revisiting this guarantee.
  function renderDeletedRun(wrap, msgs, start) {
    let j = start;
    let live = 0;
    while (j < msgs.length && msgs[j].deleted_at) {
      if (isLiveDeleted(msgs[j].id)) live++;
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
    const state = getState();
    const { editingMessageId, flashMessageId } = getViewFlags();
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
      // No onclick: the href is a same-origin permalink hash (#c<ch>/m<id>), which the
      // delegated handler's permalink branch already routes through jumpToMessage. A
      // modified click still opens a new tab (the modifier bail there lets it through).
      : el("a", {
          class: "msg-time",
          href: permalinkHash(state.activeChannelId, m.id),
          title: "Permalink",
        }, formatTime(m.created_at));

    if (grouped) {
      return el("div", { class: cls + " grouped", "data-msg-id": m.id }, el("div", { class: "msg-gutter" }, pinMark), el("div", { class: "msg-main" }, replyQuote, body, preview, reactions, rowActions));
    }
    // Clicking the avatar or name opens the author's profile card — data-act="profile"
    // with the author's id; the delegated handler resolves it (no per-row closure).
    const author = state.users[m.user_id];
    const profileAttrs = author
      ? { "data-act": "profile", "data-user-id": author.id }
      : {};
    const avatarAttrs = author
      ? { class: "msg-avatar clickable", title: "View profile", ...profileAttrs }
      : { class: "msg-avatar" };
    const avatar = author && author.has_avatar
      ? el("div", { ...avatarAttrs, style: `background-image:url(${avatarSrc(author.id)})` })
      : el("div", avatarAttrs, initials(author ? author.display_name : "?"));
    return el("div", { class: cls, "data-msg-id": m.id },
      avatar,
      el("div", { class: "msg-main" },
        el("div", { class: "msg-head" },
          el("span", author
            ? { class: "msg-author clickable", title: "View profile", ...profileAttrs }
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

  // groupingAnchor returns the {user, time} the message at msgs[idx] would group under.
  // The pure run-breaking logic lives in grouping.js (unit-tested + parity-checked against
  // the renderMessages forward loop); this wrapper just supplies the session's liveDeleted
  // membership test (which ids earned a visible tombstone).
  function groupingAnchor(msgs, idx) {
    return computeGroupingAnchor(msgs, idx, (id) => isLiveDeleted(id));
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

  // rowContextFor returns the per-row capability flags messageRow needs for a channel:
  // whether the viewer can moderate, and whether they can pin here — mods anywhere, or
  // either participant in a DM (mirrors the server rule). Deduped from the five
  // render/append/optimistic paths that each build a message row.
  function rowContextFor(channelId) {
    const state = getState();
    const isMod = canModerate(state.me);
    const ch = state.channels[channelId];
    const canPin = isMod || !!(ch && ch.is_dm);
    return { isMod, canPin };
  }

  // reactionsRow is also returned (beyond messageRow's internal use): the pins modal
  // renders its own pills for fetched pins via createPins({ reactionsRow }).
  return { messageRow, reactionsRow, rowContextFor, groupingAnchor, insertionPointFor, renderDeletedRun, renderSystemMessage };
}
