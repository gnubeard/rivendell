// api.js — thin wrappers over the rivendell HTTP API. Every call is same-origin and
// relies on the session cookie, so there are no tokens to manage here.

async function req(method, path, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg = (data && data.error) || res.statusText || "request failed";
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  // instance metadata (public)
  instance: () => req("GET", "/api/instance"),

  // auth
  login: (username, password) => req("POST", "/api/auth/login", { username, password }),
  logout: () => req("POST", "/api/auth/logout"),
  checkMagic: (token) => req("GET", `/api/auth/magic/${encodeURIComponent(token)}`),
  setPassword: (token, password) => req("POST", "/api/auth/set-password", { token, password }),

  // self
  me: () => req("GET", "/api/me"),
  updateMe: (patch) => req("PATCH", "/api/me", patch),
  setStatus: (status) => req("PUT", "/api/me/status", { status }),
  publishIdentityKey: (key) => req("PUT", "/api/me/identity-key", { key }),

  // web push (offline notifications)
  pushKey: () => req("GET", "/api/push/key"),
  pushSubscribe: (subscription) => req("POST", "/api/push/subscribe", subscription),
  pushUnsubscribe: (endpoint) => req("POST", "/api/push/unsubscribe", { endpoint }),

  uploadAvatar: async (file) => {
    const res = await fetch("/api/me/avatar", {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error("avatar upload failed");
    return res.json();
  },

  // users
  users: () => req("GET", "/api/users"),
  avatarURL: (userId) => `/api/users/${userId}/avatar`,
  getUserNote: (userId) => req("GET", `/api/users/${userId}/note`),
  putUserNote: (userId, note) => req("PUT", `/api/users/${userId}/note`, { note }),
  adminUploadAvatar: async (userId, file) => {
    const res = await fetch(`/api/admin/users/${userId}/avatar`, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error("avatar upload failed");
    return res.json();
  },
  adminClearAvatar: (userId) => req("DELETE", `/api/admin/users/${userId}/avatar`),

  // custom emojis
  emojis: () => req("GET", "/api/emojis"),
  emojiURL: (shortcode) => `/api/emojis/${encodeURIComponent(shortcode)}/image`,
  uploadEmoji: async (shortcode, file) => {
    const res = await fetch(`/api/emojis?shortcode=${encodeURIComponent(shortcode)}`, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || "emoji upload failed");
    return data;
  },
  deleteEmoji: (shortcode) => req("DELETE", `/api/emojis/${encodeURIComponent(shortcode)}`),

  // channels
  channels: () => req("GET", "/api/channels"),
  createChannel: (name, topic, isPrivate) =>
    req("POST", "/api/channels", { name, topic, is_private: !!isPrivate }),
  updateChannel: (id, patch) => req("PATCH", `/api/channels/${id}`, patch),
  archiveChannel: (id) => req("DELETE", `/api/channels/${id}`),
  channelMembers: (id) => req("GET", `/api/channels/${id}/members`),
  addChannelMember: (id, userId) => req("POST", `/api/channels/${id}/members`, { user_id: userId }),
  removeChannelMember: (id, userId) => req("DELETE", `/api/channels/${id}/members/${userId}`),

  // fetch a single channel by id (works for closed DMs and private channels
  // the caller belongs to; returns 403 for inaccessible channels).
  getChannel: (id) => req("GET", `/api/channels/${id}`),

  // direct messages (create-or-find the two-member private channel); closeDM
  // hides it from the caller's sidebar (server-authoritative, per-user).
  createDM: (userId) => req("POST", "/api/dms", { user_id: userId }),
  closeDM: (channelId) => req("DELETE", `/api/dms/${channelId}`),

  // messages
  messages: (channelId, opts = {}) => {
    const q = new URLSearchParams();
    if (opts.before) q.set("before", opts.before);
    if (opts.after) q.set("after", opts.after);
    if (opts.around) q.set("around", opts.around);
    if (opts.limit) q.set("limit", opts.limit);
    const qs = q.toString();
    return req("GET", `/api/channels/${channelId}/messages${qs ? "?" + qs : ""}`);
  },
  sendMessage: (channelId, content, replyTo) =>
    req("POST", `/api/channels/${channelId}/messages`, { content, reply_to_id: replyTo || null }),
  // search messages across all accessible channels, newest first; `before` is a
  // keyset cursor (the id of the oldest result so far) for paging older hits.
  search: (q, opts = {}) => {
    const p = new URLSearchParams({ q });
    if (opts.before) p.set("before", opts.before);
    if (opts.limit) p.set("limit", opts.limit);
    return req("GET", `/api/search?${p.toString()}`);
  },
  editMessage: (id, content) => req("PATCH", `/api/messages/${id}`, { content }),
  deleteMessage: (id) => req("DELETE", `/api/messages/${id}`),
  pinnedMessages: (channelId) => req("GET", `/api/channels/${channelId}/pins`),
  pinMessage: (id) => req("PUT", `/api/messages/${id}/pin`),
  unpinMessage: (id) => req("DELETE", `/api/messages/${id}/pin`),
  // reactions — emoji is a custom shortcode or a literal Unicode grapheme, carried
  // in the body so Unicode needs no URL encoding. Both return {message_id,
  // channel_id, reactions}.
  addReaction: (id, emoji) => req("PUT", `/api/messages/${id}/reactions`, { emoji }),
  removeReaction: (id, emoji) => req("DELETE", `/api/messages/${id}/reactions`, { emoji }),

  // durable unread / notifications
  unread: () => req("GET", "/api/unread"),
  markRead: (channelId, messageId) =>
    req("POST", `/api/channels/${channelId}/read`, { message_id: messageId }),
  markUnread: (channelId, messageId) =>
    req("POST", `/api/channels/${channelId}/unread`, { message_id: messageId }),
  muteChannel: (channelId) => req("PUT", `/api/channels/${channelId}/mute`),
  unmuteChannel: (channelId) => req("DELETE", `/api/channels/${channelId}/mute`),

  // signup via invitation (unauthenticated)
  checkInvitation: (token) => req("GET", `/api/auth/invitation/${encodeURIComponent(token)}`),
  signup: (token, username, password) => req("POST", "/api/auth/signup", { token, username, password }),

  // admin
  adminStats: () => req("GET", "/api/admin/stats"),
  createInvitation: () => req("POST", "/api/admin/invitations"),
  listInvitations: () => req("GET", "/api/admin/invitations"),
  deleteInvitation: (id) => req("DELETE", `/api/admin/invitations/${id}`),
  createMagicLink: (userId) => req("POST", `/api/admin/users/${userId}/magic-link`),
  setRole: (userId, role) => req("PUT", `/api/admin/users/${userId}/role`, { role }),
  setActive: (userId, active) => req("PUT", `/api/admin/users/${userId}/active`, { active }),
  setBot: (userId, bot) => req("PUT", `/api/admin/users/${userId}/bot`, { bot }),
  archivedChannels: () => req("GET", "/api/admin/channels/archived"),
  restoreChannel: (id) => req("POST", `/api/admin/channels/${id}/restore`),
  purgeChannel: (id) => req("DELETE", `/api/admin/channels/${id}`),

  // voice / WebRTC
  voiceState: () => req("GET", "/api/voice/state"),
  voiceParticipants: (channelId) => req("GET", `/api/channels/${channelId}/voice`),
  rtcCredentials: () => req("GET", "/api/rtc/credentials"),

  // file uploads (images only for v1); returns { hash, url, content_type, size }
  uploadBlob: async (file) => {
    const res = await fetch("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || "upload failed");
    return data;
  },
  blobURL: (hash) => `/api/blobs/${hash}`,

  // single message fetch (for same-origin message embed previews)
  getMessage: (id) => req("GET", `/api/messages/${id}`),

  // bot tokens
  listBotTokens: () => req("GET", "/api/admin/bot-tokens"),
  createBotToken: (name, userId) =>
    req("POST", "/api/admin/bot-tokens", userId != null ? { name, user_id: userId } : { name }),
  deleteBotToken: (id) => req("DELETE", `/api/admin/bot-tokens/${id}`),
};
