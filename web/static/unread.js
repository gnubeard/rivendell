// unread.js — the client's ephemeral read-tracking bookkeeping.
//
// Plus one pure classifier (classifyIncomingMessage) for the realtime handler's
// unread/ping decision matrix; see its own comment below.
//
// Three small maps that are NOT part of the durable `state` model in state.js:
// they're per-session UI state that resets on reload and is re-synced from the
// server's cursors. They're grouped behind one tracker so the subtle rules
// around them (divider placement, mark-unread suppression, POST dedupe) live in
// one unit-testable place instead of scattered across app.js.
//
// Unlike state.js this is deliberately mutable: these maps are transient
// scratch state, not the immutable world model, so a closure-encapsulated
// tracker fits better than a pure reducer.

import { mentionsUser } from "./format.js";
import { isMuted } from "./state.js";

// classifyIncomingMessage decides how a realtime message event affects the
// reader. It separates two questions the handler used to answer inline:
//
//   what the event *is* (from state alone): my own vs another's message, whether
//   it @-mentions me or replies to a message of mine, whether it "pings" me (any
//   DM, a mention, or a reply), and whether its channel is muted; and
//
//   what to *do* (folding in the view): whether to raise the unread / mention
//   badges, and whether to alert (chime + notification). The view supplies the
//   three booleans the decision needs from the DOM — `active` (am I looking at
//   this channel), `focused` (is the tab focused), and `adminPanelOpen` (is the
//   admin panel covering the conversation).
//
// Pure; the matrix it encodes was previously open-coded and untested in the
// realtime handler. Returns the raw classification flags too, since the handler
// still uses isNewFromMe/isNewFromOther for its DOM side effects.
export function classifyIncomingMessage(state, evt, view) {
  const me = state.me || {};
  const cid = evt.payload.channel_id;
  const ch = state.channels[cid];
  const isNew = evt.type === "message.new";
  const isNewFromMe = isNew && evt.payload.user_id === me.id;
  const isNewFromOther = isNew && evt.payload.user_id !== me.id;

  const isReplyToMe = isNewFromOther && evt.payload.reply_to_id != null &&
    (evt.payload.reply_to_user_id === me.id ||
     (state.messages[cid] || []).some((m) => m.id === evt.payload.reply_to_id && m.user_id === me.id));
  const mentioned = isNewFromOther && (mentionsUser(evt.payload.content, me.username) || isReplyToMe);
  // A "ping" is a message directed at you: any DM, an @-mention, or a reply. A system
  // line (e.g. a DM's "Call ended") is authorless — user_id is null, so it slips past
  // the isNewFromMe check and reads as "from other" — but it's not a person pinging you,
  // so it must never chime or raise an OS notification (that's the "Someone / Call ended"
  // alert). Excluded from the ping here; it still counts as unread like any new line.
  const pingsMe = isNewFromOther && !evt.payload.is_system && ((!!ch && ch.is_dm) || mentioned);
  const muted = isMuted(state, cid);

  // "Unseen" = I'm not actively reading it right now: either it's not the open
  // channel, or the tab is unfocused (the server only advances the read cursor on
  // focus, so an unfocused open channel still counts as unread).
  const unseen = !view.active || !view.focused;
  const countUnread = isNewFromOther && !muted && unseen;
  const countMention = countUnread && mentioned;
  // Alert on a ping unless muted, and only when I wouldn't otherwise notice it:
  // unseen, or the admin panel is covering the (focused, active) channel.
  const ping = pingsMe && !muted && (unseen || !!view.adminPanelOpen);

  return { isNewFromMe, isNewFromOther, mentioned, pingsMe, muted, countUnread, countMention, ping };
}

export function createUnreadTracker() {
  // Highest message id we've told the server we've read, per channel — dedupes
  // the mark-read POST so refocusing a tab doesn't spam the endpoint.
  const lastMarkedRead = {};
  // Cursor position at the moment a channel was opened — places the "New
  // messages" divider and never moves until the channel is re-opened.
  const openMarker = {};
  // Channels the user explicitly marked unread while viewing them. While set,
  // auto mark-read is suppressed so the channel stays unread until they leave
  // and return (openChannel clears it), honoring the mark-unread intent.
  const manualUnread = {};

  return {
    // --- "New messages" divider cursor ---

    // markerFor returns the divider cursor for a channel (0 = no divider). Any
    // loaded message with id > markerFor(cid) is "new since you last visited."
    markerFor(cid) {
      return openMarker[cid] || 0;
    },

    // openChannel is called when a channel becomes active: place the divider at
    // the old read cursor iff there were unreads (else 0 to suppress it), and
    // lift any mark-unread suppression now that the user is looking at it.
    openChannel(cid, hadUnreads, lastReadId) {
      openMarker[cid] = hadUnreads ? (lastReadId || 0) : 0;
      delete manualUnread[cid];
    },

    // seedMarker mirrors openChannel's rule for the startup path, which calls
    // loadChannel directly without selectChannel. Idempotent: only sets the
    // divider when it hasn't been placed yet.
    seedMarker(cid, hasUnreads, lastReadId) {
      if (openMarker[cid] === undefined) {
        openMarker[cid] = hasUnreads ? (lastReadId || 0) : 0;
      }
    },

    // pinMarkerIfUnset plants the divider at the current read cursor when a new
    // message arrives in the focused active channel while the user is scrolled
    // up. Only the first such message plants it; later ones leave it put. The
    // caller owns the scroll-position check.
    pinMarkerIfUnset(cid, lastReadId) {
      if (!openMarker[cid]) openMarker[cid] = lastReadId || 0;
    },

    // setMarker moves the divider explicitly (the mark-read/unread actions, which
    // know exactly where it should go).
    setMarker(cid, id) {
      openMarker[cid] = id;
    },

    // --- manual mark-unread suppression ---

    isManualUnread(cid) {
      return !!manualUnread[cid];
    },
    setManualUnread(cid) {
      manualUnread[cid] = true;
    },
    clearManualUnread(cid) {
      delete manualUnread[cid];
    },

    // --- mark-read POST dedupe ---

    // alreadyMarked reports whether the server already knows this channel is read
    // up to newestId, so the caller can skip a redundant POST.
    alreadyMarked(cid, newestId) {
      return lastMarkedRead[cid] === newestId;
    },
    recordMarked(cid, newestId) {
      lastMarkedRead[cid] = newestId;
    },
    // forgetMarked drops the dedupe entry so a later re-read re-POSTs (used after
    // a failed POST, or after a mark-unread moves the cursor back).
    forgetMarked(cid) {
      lastMarkedRead[cid] = undefined;
    },
  };
}

// shouldInsertUnreadMarker decides whether the "New messages" divider is inserted
// BEFORE this message in the render loop: only once per render (markerInserted
// guards the first qualifying message), only when a divider cursor exists
// (markerAt > 0 — a 0 cursor means "suppressed", per openChannel/seedMarker), and
// only for a message strictly newer than that cursor. Pure; the loop keeps the
// markerInserted accumulator and owns the DOM insert. markerAt comes from
// markerFor(cid).
export function shouldInsertUnreadMarker(markerInserted, markerAt, msgId) {
  return !markerInserted && markerAt > 0 && msgId > markerAt;
}

// unreadCountAfter counts loaded messages newer than the cursor that aren't mine
// — the tally the mark-unread action shows immediately (the server re-syncs the
// exact figure on next load). Pure; mirrors the read.unread reducer in state.js.
export function unreadCountAfter(messages, cursor, meId) {
  return (messages || []).filter((m) => m.id > cursor && m.user_id !== meId).length;
}
