// state.js — a pure reducer for the client's view of the world.
//
// All functions take the current state and return a NEW state object; nothing
// mutates in place and nothing touches the DOM. This keeps the tricky logic
// (merging realtime events, dedup, ordering) unit-testable in isolation.

export function initialState() {
  return {
    me: null,
    users: {}, // id -> user (with .online)
    channels: {}, // id -> channel
    channelOrder: [], // sorted channel ids
    messages: {}, // channelId -> array of messages (oldest first)
    activeChannelId: null,
    unread: {}, // channelId -> count of unseen messages
    mentions: {}, // channelId -> count of unseen @-mentions of me
    muted: {}, // channelId -> true for channels the user has silenced
    typing: {}, // channelId -> { userId -> true } for active typers
    emojis: {}, // shortcode -> emoji record (custom instance-wide emojis)
  };
}

// setEmojis replaces the custom-emoji registry from the server's list, keyed by
// shortcode so format.js can test membership in O(1) while rendering.
export function setEmojis(state, list) {
  const emojis = {};
  for (const e of list || []) emojis[e.shortcode] = e;
  return { ...state, emojis };
}

// upsertEmoji adds (or replaces) a single emoji — used for the emoji.add event.
export function upsertEmoji(state, emoji) {
  return { ...state, emojis: { ...state.emojis, [emoji.shortcode]: emoji } };
}

// removeEmoji drops an emoji by shortcode — used for the emoji.delete event.
export function removeEmoji(state, shortcode) {
  if (!state.emojis[shortcode]) return state;
  const emojis = { ...state.emojis };
  delete emojis[shortcode];
  return { ...state, emojis };
}

// setMutedChannels replaces the muted set from the server's durable list.
export function setMutedChannels(state, ids) {
  const muted = {};
  for (const id of ids || []) muted[id] = true;
  return { ...state, muted };
}

// setMuted toggles a single channel's muted flag.
export function setMuted(state, channelId, isMutedNow) {
  const muted = { ...state.muted };
  if (isMutedNow) muted[channelId] = true;
  else delete muted[channelId];
  return { ...state, muted };
}

// isMuted reports whether a channel is silenced.
export function isMuted(state, channelId) {
  return !!state.muted[channelId];
}

// bumpUnread increments the unseen-message count for a channel.
export function bumpUnread(state, channelId) {
  const n = (state.unread[channelId] || 0) + 1;
  return { ...state, unread: { ...state.unread, [channelId]: n } };
}

// clearUnread resets a channel's unseen count (e.g. when it becomes active).
export function clearUnread(state, channelId) {
  if (!state.unread[channelId]) return state;
  const unread = { ...state.unread };
  delete unread[channelId];
  return { ...state, unread };
}

// bumpMention increments the unseen-mention count for a channel (a subset of
// unread: messages that @-mention me).
export function bumpMention(state, channelId) {
  const n = (state.mentions[channelId] || 0) + 1;
  return { ...state, mentions: { ...state.mentions, [channelId]: n } };
}

// clearMention resets a channel's unseen-mention count.
export function clearMention(state, channelId) {
  if (!state.mentions[channelId]) return state;
  const mentions = { ...state.mentions };
  delete mentions[channelId];
  return { ...state, mentions };
}

// setUnreadSummary replaces the unread + mention maps wholesale from the server's
// durable counts (the /api/unread payload's `channels` array). This is what makes
// the badges survive a refresh/reconnect: the client trusts the server's numbers
// rather than its own ephemeral tally. Zero counts are dropped so the maps only
// hold channels that actually have something unseen.
export function setUnreadSummary(state, channels) {
  const unread = {};
  const mentions = {};
  for (const c of channels || []) {
    if (c.unread) unread[c.channel_id] = c.unread;
    if (c.mentions) mentions[c.channel_id] = c.mentions;
  }
  return { ...state, unread, mentions };
}

// totalUnread / totalMentions sum the per-channel maps. totalMentions is the
// global "missed notifications" number (DMs + @-mentions) shown in the title and
// header badge.
export function totalUnread(state) {
  let n = 0;
  for (const id in state.unread) n += state.unread[id];
  return n;
}

export function totalMentions(state) {
  let n = 0;
  for (const id in state.mentions) n += state.mentions[id];
  return n;
}

export function setMe(state, me) {
  return { ...state, me };
}

export function setUsers(state, list) {
  const users = {};
  for (const u of list || []) users[u.id] = u;
  return { ...state, users };
}

export function upsertUser(state, user) {
  const prev = state.users[user.id] || {};
  return { ...state, users: { ...state.users, [user.id]: { ...prev, ...user } } };
}

export function setPresence(state, userId, online, status, idle = false) {
  const prev = state.users[userId];
  if (!prev) return state;
  return {
    ...state,
    users: { ...state.users, [userId]: { ...prev, online, status, idle } },
  };
}

function sortChannels(channels) {
  return Object.values(channels)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .map((c) => c.id);
}

export function setChannels(state, list) {
  const channels = {};
  for (const c of list || []) channels[c.id] = c;
  return { ...state, channels, channelOrder: sortChannels(channels) };
}

export function upsertChannel(state, channel) {
  const channels = { ...state.channels, [channel.id]: channel };
  return { ...state, channels, channelOrder: sortChannels(channels) };
}

export function removeChannel(state, channelId) {
  const channels = { ...state.channels };
  delete channels[channelId];
  const next = { ...state, channels, channelOrder: sortChannels(channels) };
  if (state.activeChannelId === channelId) next.activeChannelId = next.channelOrder[0] || null;
  return next;
}

export function setActiveChannel(state, channelId) {
  return { ...state, activeChannelId: channelId };
}

// dmParticipants extracts the two user ids encoded in a DM channel's canonical
// name (dm-<a>-<b>). Returns [] for non-DM channels or unparseable names, so the
// UI can fall back to the channel name.
export function dmParticipants(channel) {
  if (!channel || !channel.is_dm) return [];
  const m = /^dm-(\d+)-(\d+)$/.exec(channel.name || "");
  return m ? [Number(m[1]), Number(m[2])] : [];
}

// otherDMParticipant returns the id of the *other* member of a DM (the one who
// isn't `meId`), or null if this isn't a DM we're part of.
export function otherDMParticipant(channel, meId) {
  const ids = dmParticipants(channel);
  const other = ids.find((id) => id !== meId);
  return other == null ? null : other;
}

// setMessages replaces the message list for a channel (used on initial load).
export function setMessages(state, channelId, list) {
  const sorted = [...(list || [])].sort((a, b) => a.id - b.id);
  return { ...state, messages: { ...state.messages, [channelId]: sorted } };
}

// prependMessages adds older messages fetched via pagination.
export function prependMessages(state, channelId, older) {
  const existing = state.messages[channelId] || [];
  const seen = new Set(existing.map((m) => m.id));
  const merged = [...(older || []).filter((m) => !seen.has(m.id)), ...existing].sort((a, b) => a.id - b.id);
  return { ...state, messages: { ...state.messages, [channelId]: merged } };
}

// appendMessages adds newer messages fetched when paging forward through a
// history window toward the present. Mirror of prependMessages; dedups and keeps
// the list sorted ascending.
export function appendMessages(state, channelId, newer) {
  const existing = state.messages[channelId] || [];
  const seen = new Set(existing.map((m) => m.id));
  const merged = [...existing, ...(newer || []).filter((m) => !seen.has(m.id))].sort((a, b) => a.id - b.id);
  return { ...state, messages: { ...state.messages, [channelId]: merged } };
}

// oldestMessageId returns the smallest loaded message id for a channel (messages
// are kept sorted ascending), or null if none are loaded. Used as the `before`
// cursor when scrolling back through history.
export function oldestMessageId(state, channelId) {
  const arr = state.messages[channelId];
  return arr && arr.length ? arr[0].id : null;
}

// newestMessageId returns the largest loaded message id for a channel, or null.
// Used as the `after` cursor when paging forward toward the present.
export function newestMessageId(state, channelId) {
  const arr = state.messages[channelId];
  return arr && arr.length ? arr[arr.length - 1].id : null;
}

// addMessage appends or replaces a single message (realtime new/edit), keeping
// the list ordered and free of duplicates.
export function addMessage(state, msg) {
  const existing = state.messages[msg.channel_id] || [];
  const idx = existing.findIndex((m) => m.id === msg.id);
  let next;
  if (idx >= 0) {
    next = [...existing];
    next[idx] = msg;
  } else {
    next = [...existing, msg].sort((a, b) => a.id - b.id);
  }
  return { ...state, messages: { ...state.messages, [msg.channel_id]: next } };
}

// markMessageDeleted flags a message as soft-deleted in place.
export function markMessageDeleted(state, channelId, messageId) {
  const existing = state.messages[channelId] || [];
  const next = existing.map((m) =>
    m.id === messageId ? { ...m, deleted_at: new Date().toISOString(), content: "" } : m
  );
  return { ...state, messages: { ...state.messages, [channelId]: next } };
}

// setTyping marks a user as typing (active=true) or done (active=false) in a channel.
// Removing the last typer in a channel drops the channel key entirely.
export function setTyping(state, channelId, userId, active) {
  const prev = state.typing[channelId] || {};
  const next = { ...prev };
  if (active) next[userId] = true;
  else delete next[userId];
  const typing = { ...state.typing };
  if (Object.keys(next).length === 0) delete typing[channelId];
  else typing[channelId] = next;
  return { ...state, typing };
}

// applyEvent folds a realtime websocket event into state. Returns new state.
export function applyEvent(state, evt) {
  switch (evt.type) {
    case "presence.update":
      return setPresence(state, evt.payload.user_id, evt.payload.online, evt.payload.status, !!evt.payload.idle);
    case "user.update":
      return upsertUser(state, evt.payload);
    case "channel.new":
    case "channel.update":
      return upsertChannel(state, evt.payload);
    case "channel.archive":
      return removeChannel(state, evt.payload.id);
    case "message.new":
    case "message.update":
      return addMessage(state, evt.payload);
    case "message.delete":
      return markMessageDeleted(state, evt.payload.channel_id, evt.payload.id);
    case "read.update":
      // Another of my own sessions advanced the read cursor for a channel; the
      // cursor only ever moves to the latest, so clear both counts here too.
      return clearMention(clearUnread(state, evt.payload.channel_id), evt.payload.channel_id);
    case "mute.update":
      // Another of my sessions muted/unmuted a channel; mirror it.
      return setMuted(state, evt.payload.channel_id, evt.payload.muted);
    case "typing.update":
      return setTyping(state, evt.payload.channel_id, evt.payload.user_id, evt.payload.active);
    case "emoji.add":
      return upsertEmoji(state, evt.payload);
    case "emoji.delete":
      return removeEmoji(state, evt.payload.shortcode);
    default:
      return state;
  }
}
