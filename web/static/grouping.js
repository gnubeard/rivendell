// Pure message-pane run helpers — extracted from app.js so they can be unit-tested
// (app.js is DOM-carrying and unimportable under node). No DOM, no module state:
// callers thread in what these need. web/test/grouping.test.js pins them, including
// a parity check that groupingAnchor agrees with the renderMessages forward loop.

// groupingAnchor returns the { user, time } that the message at msgs[idx] would group
// UNDER, mirroring the renderMessages loop's run-breaking rules but walking backward:
//   - a system line resets grouping (returns null)
//   - a DRAWN tombstone (a live-deleted message) resets grouping (returns null)
//   - an invisible deleted run (deleted but not live this session) is transparent
//   - otherwise the first such predecessor is the anchor
// null when nothing groupable precedes it. `isLiveDeleted(id)` reports whether a
// deleted message earned a visible tombstone this session (app.js passes
// (id) => liveDeleted.has(id)). The append/optimistic fast paths call this so a single
// appended row gets the same grouped/full shape the full rebuild would.
export function groupingAnchor(msgs, idx, isLiveDeleted) {
  for (let k = idx - 1; k >= 0; k--) {
    const p = msgs[k];
    if (p.is_system) return null;
    if (p.deleted_at) {
      if (isLiveDeleted(p.id)) return null; // a drawn tombstone breaks the run
      continue;                             // an invisible deleted run is transparent
    }
    return { user: p.user_id, time: new Date(p.created_at).getTime() };
  }
  return null;
}

// liveDeletedStillLoaded returns the subset of `liveDeleted` ids that are still present
// (as a deleted row) in some loaded channel window. It's the pure core of app.js's
// pruneLiveDeleted GC: renderDeletedRun can only ever draw a tombstone for an id still
// in a loaded window, so dropping any id NOT in this subset is invisible. `messagesByChannel`
// is state.messages (channelId -> message[]); `liveDeleted` is an iterable of ids.
export function liveDeletedStillLoaded(messagesByChannel, liveDeleted) {
  const live = liveDeleted instanceof Set ? liveDeleted : new Set(liveDeleted);
  const stillLoaded = new Set();
  for (const cid in messagesByChannel) {
    for (const m of messagesByChannel[cid] || []) {
      if (m.deleted_at && live.has(m.id)) stillLoaded.add(m.id);
    }
  }
  return stillLoaded;
}
