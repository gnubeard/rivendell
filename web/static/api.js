// api.js — thin wrappers over the Rivendell HTTP API. Every call is same-origin and
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

  // channels
  channels: () => req("GET", "/api/channels"),
  createChannel: (name, topic, isPrivate) =>
    req("POST", "/api/channels", { name, topic, is_private: !!isPrivate }),
  updateChannel: (id, patch) => req("PATCH", `/api/channels/${id}`, patch),
  archiveChannel: (id) => req("DELETE", `/api/channels/${id}`),
  channelMembers: (id) => req("GET", `/api/channels/${id}/members`),
  addChannelMember: (id, userId) => req("POST", `/api/channels/${id}/members`, { user_id: userId }),
  removeChannelMember: (id, userId) => req("DELETE", `/api/channels/${id}/members/${userId}`),

  // direct messages (create-or-find the two-member private channel)
  createDM: (userId) => req("POST", "/api/dms", { user_id: userId }),

  // messages
  messages: (channelId, opts = {}) => {
    const q = new URLSearchParams();
    if (opts.before) q.set("before", opts.before);
    if (opts.limit) q.set("limit", opts.limit);
    const qs = q.toString();
    return req("GET", `/api/channels/${channelId}/messages${qs ? "?" + qs : ""}`);
  },
  sendMessage: (channelId, content, replyTo) =>
    req("POST", `/api/channels/${channelId}/messages`, { content, reply_to_id: replyTo || null }),
  editMessage: (id, content) => req("PATCH", `/api/messages/${id}`, { content }),
  deleteMessage: (id) => req("DELETE", `/api/messages/${id}`),
  pinnedMessages: (channelId) => req("GET", `/api/channels/${channelId}/pins`),
  pinMessage: (id) => req("PUT", `/api/messages/${id}/pin`),
  unpinMessage: (id) => req("DELETE", `/api/messages/${id}/pin`),

  // durable unread / notifications
  unread: () => req("GET", "/api/unread"),
  markRead: (channelId, messageId) =>
    req("POST", `/api/channels/${channelId}/read`, { message_id: messageId }),
  muteChannel: (channelId) => req("PUT", `/api/channels/${channelId}/mute`),
  unmuteChannel: (channelId) => req("DELETE", `/api/channels/${channelId}/mute`),

  // admin
  createUser: (username, displayName, role) =>
    req("POST", "/api/admin/users", { username, display_name: displayName, role }),
  createMagicLink: (userId) => req("POST", `/api/admin/users/${userId}/magic-link`),
  setRole: (userId, role) => req("PUT", `/api/admin/users/${userId}/role`, { role }),
  setActive: (userId, active) => req("PUT", `/api/admin/users/${userId}/active`, { active }),
  archivedChannels: () => req("GET", "/api/admin/channels/archived"),
  restoreChannel: (id) => req("POST", `/api/admin/channels/${id}/restore`),
  purgeChannel: (id) => req("DELETE", `/api/admin/channels/${id}`),
};
