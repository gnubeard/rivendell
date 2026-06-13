// unread.js — the client's ephemeral read-tracking bookkeeping.
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

// unreadCountAfter counts loaded messages newer than the cursor that aren't mine
// — the tally the mark-unread action shows immediately (the server re-syncs the
// exact figure on next load). Pure; mirrors the read.unread reducer in state.js.
export function unreadCountAfter(messages, cursor, meId) {
  return (messages || []).filter((m) => m.id > cursor && m.user_id !== meId).length;
}
