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
  };
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

export function setPresence(state, userId, online, status) {
  const prev = state.users[userId];
  if (!prev) return state;
  return {
    ...state,
    users: { ...state.users, [userId]: { ...prev, online, status } },
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

// applyEvent folds a realtime websocket event into state. Returns new state.
export function applyEvent(state, evt) {
  switch (evt.type) {
    case "presence.update":
      return setPresence(state, evt.payload.user_id, evt.payload.online, evt.payload.status);
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
    default:
      return state;
  }
}
