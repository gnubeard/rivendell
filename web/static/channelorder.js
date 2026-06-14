// channelorder.js — pure selectors over the channel model: sidebar ordering, DM
// display-name resolution, and the drag-reorder position diff. These are derived
// views; keeping them out of app.js makes the ordering rules unit-testable. The
// DOM/event wiring for the drag gesture itself stays in app.js (pure plumbing).

import { otherDMParticipant } from "./state.js";

// regularChannelOrder: the non-DM channel ids in their stored order.
export function regularChannelOrder(state) {
  return state.channelOrder.filter((id) => !state.channels[id].is_dm);
}

// sidebarChannelOrder: the full top-to-bottom visual order of the sidebar —
// regular channels first, then DMs — matching how renderChannels()/renderDMs()
// paint them. The ctrl-arrow navigation shortcuts walk this so "up"/"down" track
// what the user actually sees.
export function sidebarChannelOrder(state) {
  return [
    ...regularChannelOrder(state),
    ...state.channelOrder.filter((id) => state.channels[id].is_dm),
  ];
}

// dmDisplayName: resolves a DM channel to the other participant's display name,
// falling back to the raw channel name if that user isn't loaded. For a self-DM
// the "other" participant is the current user; we append "(you)".
export function dmDisplayName(state, ch) {
  const meId = state.me && state.me.id;
  const otherId = otherDMParticipant(ch, meId);
  if (otherId === meId) {
    const me = state.users[meId] || state.me;
    return (me.display_name || me.username) + " (you)";
  }
  const other = otherId != null ? state.users[otherId] : null;
  return other ? other.display_name : ch.name;
}

// channelReorderPatches: given the new top-to-bottom id order produced by a drop,
// renormalize regular channels to contiguous positions and return both the PATCH
// payloads (only the channels whose stored position actually changed) and the
// full channel list with positions folded in (for the optimistic local update).
// Positions default to 0 — channels then sort by name — so the first reorder on a
// fresh install legitimately rewrites several. Pure; the caller owns the network.
export function channelReorderPatches(ids, channels) {
  const patches = ids
    .map((cid, idx) => (channels[cid].position === idx ? null : { cid, idx }))
    .filter(Boolean);
  const updated = Object.values(channels).map((c) => {
    const pos = ids.indexOf(c.id);
    return pos === -1 ? c : { ...c, position: pos };
  });
  return { patches, updated };
}
