import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../static/state.js";

test("setChannels tolerates a null response (JSON null) without throwing", () => {
  const s = S.setChannels(S.initialState(), null);
  assert.deepEqual(s.channelOrder, []);
  assert.deepEqual(s.channels, {});
});

test("setUsers and setMessages tolerate null", () => {
  assert.deepEqual(S.setUsers(S.initialState(), null).users, {});
  assert.deepEqual(S.setMessages(S.initialState(), 1, null).messages[1], []);
});

test("initialState is empty but well-formed", () => {
  const s = S.initialState();
  assert.equal(s.me, null);
  assert.deepEqual(s.users, {});
  assert.deepEqual(s.channelOrder, []);
});

test("setUsers indexes by id", () => {
  const s = S.setUsers(S.initialState(), [{ id: 1, username: "a" }, { id: 2, username: "b" }]);
  assert.equal(s.users[1].username, "a");
  assert.equal(s.users[2].username, "b");
});

test("setPresence updates online/status/idle and is a no-op for unknown user", () => {
  let s = S.setUsers(S.initialState(), [{ id: 1, username: "a", online: false }]);
  s = S.setPresence(s, 1, true, "online");
  assert.equal(s.users[1].online, true);
  assert.equal(s.users[1].status, "online");
  assert.equal(s.users[1].idle, false, "idle defaults to false");
  s = S.setPresence(s, 1, true, "away", true);
  assert.equal(s.users[1].idle, true, "idle propagates when set");
  const before = s;
  s = S.setPresence(s, 99, true, "online");
  assert.equal(s, before, "unknown user returns same state reference");
});

test("presenceMatches detects whether a payload changes the displayed presence", () => {
  const user = { online: true, status: "online", idle: false };
  // Same on all three fields → unchanged.
  assert.equal(S.presenceMatches(user, { online: true, status: "online", idle: false }), true);
  // Any one field differing → changed.
  assert.equal(S.presenceMatches(user, { online: false, status: "online", idle: false }), false, "online differs");
  assert.equal(S.presenceMatches(user, { online: true, status: "away", idle: false }), false, "status differs");
  assert.equal(S.presenceMatches(user, { online: true, status: "online", idle: true }), false, "idle differs");
  // Truthiness is coerced: a missing idle reads as false and matches.
  assert.equal(S.presenceMatches(user, { online: true, status: "online" }), true, "missing idle == false");
  assert.equal(S.presenceMatches({ online: 1, status: "online", idle: 0 }, { online: true, status: "online", idle: false }), true, "1/0 coerce to booleans");
  // Missing user or payload never matches.
  assert.equal(S.presenceMatches(null, { online: true, status: "online" }), false);
  assert.equal(S.presenceMatches(user, null), false);
});

test("isAdmin and canModerate gate on the role hierarchy", () => {
  // admin > moderator > member.
  assert.equal(S.isAdmin({ role: "admin" }), true);
  assert.equal(S.isAdmin({ role: "moderator" }), false, "moderator is not admin");
  assert.equal(S.isAdmin({ role: "member" }), false);

  assert.equal(S.canModerate({ role: "admin" }), true, "admin can moderate");
  assert.equal(S.canModerate({ role: "moderator" }), true);
  assert.equal(S.canModerate({ role: "member" }), false);

  // Missing user, missing role, or an unknown role → lowest privilege (member).
  assert.equal(S.isAdmin(null), false);
  assert.equal(S.canModerate(null), false);
  assert.equal(S.isAdmin({}), false);
  assert.equal(S.canModerate({ role: "guest" }), false);
});

test("channels sort by position then name", () => {
  const s = S.setChannels(S.initialState(), [
    { id: 3, name: "zeta", position: 0 },
    { id: 1, name: "alpha", position: 0 },
    { id: 2, name: "mid", position: -1 },
  ]);
  assert.deepEqual(s.channelOrder, [2, 1, 3]);
});

test("removeChannel reselects active channel", () => {
  let s = S.setChannels(S.initialState(), [
    { id: 1, name: "a", position: 0 },
    { id: 2, name: "b", position: 1 },
  ]);
  s = S.setActiveChannel(s, 1);
  s = S.removeChannel(s, 1);
  assert.equal(s.channels[1], undefined);
  assert.equal(s.activeChannelId, 2);
});

test("setMessages sorts ascending by id", () => {
  const s = S.setMessages(S.initialState(), 1, [
    { id: 3, channel_id: 1 },
    { id: 1, channel_id: 1 },
    { id: 2, channel_id: 1 },
  ]);
  assert.deepEqual(s.messages[1].map((m) => m.id), [1, 2, 3]);
});

test("addMessage appends new and dedups/replaces existing", () => {
  let s = S.setMessages(S.initialState(), 1, [{ id: 1, channel_id: 1, content: "a" }]);
  s = S.addMessage(s, { id: 2, channel_id: 1, content: "b" });
  assert.equal(s.messages[1].length, 2);
  // Replace id 1 (edit) — no duplicate.
  s = S.addMessage(s, { id: 1, channel_id: 1, content: "edited" });
  assert.equal(s.messages[1].length, 2);
  assert.equal(s.messages[1].find((m) => m.id === 1).content, "edited");
});

test("prependMessages merges older without duplicates", () => {
  let s = S.setMessages(S.initialState(), 1, [{ id: 5, channel_id: 1 }, { id: 6, channel_id: 1 }]);
  s = S.prependMessages(s, 1, [{ id: 4, channel_id: 1 }, { id: 5, channel_id: 1 }]);
  assert.deepEqual(s.messages[1].map((m) => m.id), [4, 5, 6]);
});

test("oldestMessageId returns the smallest loaded id or null", () => {
  let s = S.initialState();
  assert.equal(S.oldestMessageId(s, 1), null);
  s = S.setMessages(s, 1, [{ id: 5, channel_id: 1 }, { id: 3, channel_id: 1 }, { id: 8, channel_id: 1 }]);
  assert.equal(S.oldestMessageId(s, 1), 3);
  // After prepending older history the cursor moves back.
  s = S.prependMessages(s, 1, [{ id: 1, channel_id: 1 }]);
  assert.equal(S.oldestMessageId(s, 1), 1);
});

test("appendMessages merges newer without duplicates", () => {
  let s = S.setMessages(S.initialState(), 1, [{ id: 5, channel_id: 1 }, { id: 6, channel_id: 1 }]);
  s = S.appendMessages(s, 1, [{ id: 6, channel_id: 1 }, { id: 7, channel_id: 1 }]);
  assert.deepEqual(s.messages[1].map((m) => m.id), [5, 6, 7]);
});

test("newestMessageId returns the largest loaded id or null", () => {
  let s = S.initialState();
  assert.equal(S.newestMessageId(s, 1), null);
  s = S.setMessages(s, 1, [{ id: 5, channel_id: 1 }, { id: 3, channel_id: 1 }, { id: 8, channel_id: 1 }]);
  assert.equal(S.newestMessageId(s, 1), 8);
  // After appending newer messages the forward cursor advances.
  s = S.appendMessages(s, 1, [{ id: 12, channel_id: 1 }]);
  assert.equal(S.newestMessageId(s, 1), 12);
});

test("markMessageDeleted clears content and sets deleted_at", () => {
  let s = S.setMessages(S.initialState(), 1, [{ id: 1, channel_id: 1, content: "secret" }]);
  s = S.markMessageDeleted(s, 1, 1);
  assert.equal(s.messages[1][0].content, "");
  assert.ok(s.messages[1][0].deleted_at);
});

test("applyEvent routes presence.update", () => {
  let s = S.setUsers(S.initialState(), [{ id: 1, online: false }]);
  s = S.applyEvent(s, { type: "presence.update", payload: { user_id: 1, online: true, status: "online" } });
  assert.equal(s.users[1].online, true);
  assert.equal(s.users[1].idle, false, "idle false when absent from payload");
  s = S.applyEvent(s, { type: "presence.update", payload: { user_id: 1, online: true, status: "online", idle: true } });
  assert.equal(s.users[1].idle, true, "idle propagated from event payload");
  s = S.applyEvent(s, { type: "presence.update", payload: { user_id: 1, online: true, status: "online", idle: false } });
  assert.equal(s.users[1].idle, false, "idle cleared by event payload");
});

test("applyEvent routes message.new and message.delete", () => {
  let s = S.initialState();
  s = S.applyEvent(s, { type: "message.new", payload: { id: 1, channel_id: 7, content: "hi" } });
  assert.equal(s.messages[7].length, 1);
  s = S.applyEvent(s, { type: "message.delete", payload: { id: 1, channel_id: 7 } });
  assert.equal(s.messages[7][0].content, "");
});

test("applyEvent message.new bumps last_message_at; message.update does not", () => {
  let s = S.initialState();
  s = S.applyEvent(s, { type: "channel.new", payload: { id: 7, name: "g", position: 0, last_message_at: null } });
  s = S.applyEvent(s, { type: "message.new", payload: { id: 1, channel_id: 7, content: "hi", created_at: "2026-06-14T10:00:00Z" } });
  assert.equal(s.channels[7].last_message_at, "2026-06-14T10:00:00Z", "message.new advances last_message_at");
  // An edit to an existing message must not move recency.
  s = S.applyEvent(s, { type: "message.update", payload: { id: 1, channel_id: 7, content: "edited", created_at: "2026-06-14T11:00:00Z" } });
  assert.equal(s.channels[7].last_message_at, "2026-06-14T10:00:00Z", "message.update leaves last_message_at unchanged");
  // A message for an unknown channel is still stored; there's just no channel to bump.
  s = S.applyEvent(s, { type: "message.new", payload: { id: 2, channel_id: 99, content: "x", created_at: "2026-06-14T12:00:00Z" } });
  assert.equal(s.messages[99].length, 1, "message stored even without a known channel");
});

test("applyEvent member.remove drops my channel unless I'm an admin", () => {
  const base = () => {
    let s = S.initialState();
    s = S.setMe(s, { id: 1, role: "member" });
    return S.applyEvent(s, { type: "channel.new", payload: { id: 7, name: "priv", position: 0 } });
  };
  // I (a member) was removed → channel dropped.
  let s = S.applyEvent(base(), { type: "member.remove", payload: { channel_id: 7, user_id: 1 } });
  assert.equal(s.channels[7], undefined, "member removed from own channel → dropped");

  // An admin keeps bypass access → channel retained (reducer is a no-op).
  let admin = S.setMe(base(), { id: 1, role: "admin" });
  s = S.applyEvent(admin, { type: "member.remove", payload: { channel_id: 7, user_id: 1 } });
  assert.equal(s, admin, "admin self-removal is a no-op in the reducer");
  assert.ok(s.channels[7], "admin retains the channel (bypass access)");

  // Someone *else* being removed is roster-only bookkeeping the handler does;
  // the reducer leaves state untouched.
  const before = base();
  s = S.applyEvent(before, { type: "member.remove", payload: { channel_id: 7, user_id: 2 } });
  assert.equal(s, before, "another user's removal is a no-op in the reducer");
});

test("applyEvent routes channel lifecycle", () => {
  let s = S.initialState();
  s = S.applyEvent(s, { type: "channel.new", payload: { id: 1, name: "g", position: 0 } });
  assert.equal(s.channelOrder.length, 1);
  s = S.applyEvent(s, { type: "channel.archive", payload: { id: 1 } });
  assert.equal(s.channelOrder.length, 0);
});

test("applyEvent ignores unknown types", () => {
  const s = S.initialState();
  assert.equal(S.applyEvent(s, { type: "nope.nope", payload: {} }), s);
});

test("dmParticipants parses ids only for DM channels", () => {
  assert.deepEqual(S.dmParticipants({ is_dm: true, name: "dm-3-7" }), [3, 7]);
  // Non-DM channel, even if named like one, yields nothing.
  assert.deepEqual(S.dmParticipants({ is_dm: false, name: "dm-3-7" }), []);
  // Unparseable / regular names yield nothing.
  assert.deepEqual(S.dmParticipants({ is_dm: true, name: "general" }), []);
  assert.deepEqual(S.dmParticipants(null), []);
});

test("bumpUnread and clearUnread track per-channel counts", () => {
  let s = S.initialState();
  s = S.bumpUnread(s, 7);
  s = S.bumpUnread(s, 7);
  s = S.bumpUnread(s, 9);
  assert.equal(s.unread[7], 2);
  assert.equal(s.unread[9], 1);
  s = S.clearUnread(s, 7);
  assert.equal(s.unread[7], undefined);
  assert.equal(s.unread[9], 1);
  // clearing an already-clear channel is a no-op returning the same reference.
  const before = s;
  s = S.clearUnread(s, 7);
  assert.equal(s, before);
});

test("bumpMention and clearMention track per-channel mention counts", () => {
  let s = S.initialState();
  s = S.bumpMention(s, 3);
  s = S.bumpMention(s, 3);
  assert.equal(s.mentions[3], 2);
  s = S.clearMention(s, 3);
  assert.equal(s.mentions[3], undefined);
  const before = s;
  s = S.clearMention(s, 3); // no-op
  assert.equal(s, before);
});

test("otherDMParticipant returns the member that isn't me", () => {
  const dm = { is_dm: true, name: "dm-3-7" };
  assert.equal(S.otherDMParticipant(dm, 3), 7);
  assert.equal(S.otherDMParticipant(dm, 7), 3);
  // id 0 is a valid id and must not be confused with "no other participant".
  assert.equal(S.otherDMParticipant({ is_dm: true, name: "dm-0-5" }, 5), 0);
  // Not a DM -> null.
  assert.equal(S.otherDMParticipant({ is_dm: false, name: "general" }, 1), null);
});

test("setUnreadSummary seeds both maps and drops zero counts", () => {
  let s = S.initialState();
  s = S.setUnreadSummary(s, [
    { channel_id: 1, unread: 3, mentions: 1 },
    { channel_id: 2, unread: 5, mentions: 0 },
    { channel_id: 3, unread: 0, mentions: 0 },
  ]);
  assert.deepEqual(s.unread, { 1: 3, 2: 5 });
  assert.deepEqual(s.mentions, { 1: 1 });
  // It replaces wholesale (durability: server is the source of truth).
  s = S.setUnreadSummary(s, [{ channel_id: 9, unread: 2, mentions: 2 }]);
  assert.deepEqual(s.unread, { 9: 2 });
  assert.deepEqual(s.mentions, { 9: 2 });
});

test("setUnreadSummary tolerates null", () => {
  const s = S.setUnreadSummary(S.initialState(), null);
  assert.deepEqual(s.unread, {});
  assert.deepEqual(s.mentions, {});
});

test("totalUnread and totalMentions sum the maps", () => {
  const s = S.setUnreadSummary(S.initialState(), [
    { channel_id: 1, unread: 3, mentions: 1 },
    { channel_id: 2, unread: 5, mentions: 2 },
  ]);
  assert.equal(S.totalUnread(s), 8);
  assert.equal(S.totalMentions(s), 3);
  assert.equal(S.totalMentions(S.initialState()), 0);
});

test("displayNameOf returns the roster display name, or 'Someone' for an unknown id", () => {
  const s = S.setUsers(S.initialState(), [{ id: 7, display_name: "Frodo" }]);
  assert.equal(S.displayNameOf(s, 7), "Frodo");
  assert.equal(S.displayNameOf(s, 999), "Someone");
  assert.equal(S.displayNameOf(S.initialState(), 7), "Someone");
});

test("setMutedChannels / setMuted / isMuted", () => {
  let s = S.setMutedChannels(S.initialState(), [1, 2]);
  assert.equal(S.isMuted(s, 1), true);
  assert.equal(S.isMuted(s, 3), false);
  s = S.setMuted(s, 3, true);
  assert.equal(S.isMuted(s, 3), true);
  s = S.setMuted(s, 1, false);
  assert.equal(S.isMuted(s, 1), false);
});

test("setMutedChannels tolerates null", () => {
  assert.deepEqual(S.setMutedChannels(S.initialState(), null).muted, {});
});

test("applyEvent mute.update folds in the mute flag", () => {
  let s = S.applyEvent(S.initialState(), { type: "mute.update", payload: { channel_id: 5, muted: true } });
  assert.equal(S.isMuted(s, 5), true);
  s = S.applyEvent(s, { type: "mute.update", payload: { channel_id: 5, muted: false } });
  assert.equal(S.isMuted(s, 5), false);
});

test("setUnread sets an explicit count and clears on non-positive", () => {
  let s = S.initialState();
  s = S.setUnread(s, 7, 3);
  assert.equal(s.unread[7], 3);
  // Same value is a no-op returning the same reference.
  const before = s;
  s = S.setUnread(s, 7, 3);
  assert.equal(s, before);
  // Zero (or negative) clears the entry like clearUnread.
  s = S.setUnread(s, 7, 0);
  assert.equal(s.unread[7], undefined);
});

test("applyEvent read.unread raises the unread badge from loaded messages", () => {
  let s = S.initialState();
  s = { ...s, me: { id: 3 } };
  // Channel 1 has three messages after cursor 5; two are from others (id 6, 8),
  // one is mine (id 7) and must not count toward the unread badge.
  s = S.setMessages(s, 1, [
    { id: 4, channel_id: 1, user_id: 9 },
    { id: 6, channel_id: 1, user_id: 9 },
    { id: 7, channel_id: 1, user_id: 3 },
    { id: 8, channel_id: 1, user_id: 9 },
  ]);
  s = S.applyEvent(s, { type: "read.unread", payload: { channel_id: 1, last_read_message_id: 5 } });
  assert.equal(s.lastRead[1], 5);
  assert.equal(s.unread[1], 2); // ids 6 and 8 (mine, id 7, excluded)
});

test("applyEvent read.update clears both counts for the channel", () => {
  let s = S.setUnreadSummary(S.initialState(), [
    { channel_id: 1, unread: 3, mentions: 1 },
    { channel_id: 2, unread: 5, mentions: 2 },
  ]);
  s = S.applyEvent(s, { type: "read.update", payload: { channel_id: 1, last_read_message_id: 99 } });
  assert.equal(s.unread[1], undefined);
  assert.equal(s.mentions[1], undefined);
  // Other channels untouched.
  assert.equal(s.unread[2], 5);
  assert.equal(s.mentions[2], 2);
});

test("initialState includes typing as empty object", () => {
  const s = S.initialState();
  assert.deepEqual(s.typing, {});
});

test("setTyping adds and removes typers", () => {
  let s = S.initialState();
  s = S.setTyping(s, 10, 1, true);
  assert.deepEqual(s.typing[10], { 1: true });
  s = S.setTyping(s, 10, 2, true);
  assert.deepEqual(s.typing[10], { 1: true, 2: true });
  s = S.setTyping(s, 10, 1, false);
  assert.deepEqual(s.typing[10], { 2: true });
  // Removing the last typer drops the channel key entirely.
  s = S.setTyping(s, 10, 2, false);
  assert.equal(s.typing[10], undefined);
});

test("setTyping is isolated between channels", () => {
  let s = S.initialState();
  s = S.setTyping(s, 10, 1, true);
  s = S.setTyping(s, 20, 2, true);
  assert.deepEqual(s.typing[10], { 1: true });
  assert.deepEqual(s.typing[20], { 2: true });
  s = S.setTyping(s, 10, 1, false);
  assert.equal(s.typing[10], undefined);
  assert.deepEqual(s.typing[20], { 2: true });
});

test("applyEvent routes typing.update", () => {
  let s = S.initialState();
  s = S.applyEvent(s, { type: "typing.update", payload: { channel_id: 7, user_id: 3, active: true } });
  assert.deepEqual(s.typing[7], { 3: true });
  s = S.applyEvent(s, { type: "typing.update", payload: { channel_id: 7, user_id: 3, active: false } });
  assert.equal(s.typing[7], undefined);
});

test("setEmojis indexes by shortcode and tolerates null", () => {
  let s = S.setEmojis(S.initialState(), [
    { id: 1, shortcode: "party" },
    { id: 2, shortcode: "smile_cat" },
  ]);
  assert.equal(s.emojis.party.id, 1);
  assert.equal(s.emojis.smile_cat.id, 2);
  assert.deepEqual(S.setEmojis(S.initialState(), null).emojis, {});
});

test("upsertEmoji adds/replaces and removeEmoji drops a shortcode", () => {
  let s = S.upsertEmoji(S.initialState(), { id: 1, shortcode: "party" });
  assert.equal(s.emojis.party.id, 1);
  s = S.upsertEmoji(s, { id: 9, shortcode: "party" });
  assert.equal(s.emojis.party.id, 9, "same shortcode replaces");
  s = S.removeEmoji(s, "party");
  assert.equal(s.emojis.party, undefined);
  assert.equal(S.removeEmoji(s, "absent"), s, "removing an absent emoji is a no-op");
});

test("applyEvent routes emoji.add and emoji.delete", () => {
  let s = S.initialState();
  s = S.applyEvent(s, { type: "emoji.add", payload: { id: 3, shortcode: "party" } });
  assert.equal(s.emojis.party.id, 3);
  s = S.applyEvent(s, { type: "emoji.delete", payload: { shortcode: "party" } });
  assert.equal(s.emojis.party, undefined);
});

test("nextChannelId steps through the order and clamps at the ends", () => {
  const order = [10, 20, 30, 40];
  assert.equal(S.nextChannelId(order, 20, 1), 30, "down moves to the next");
  assert.equal(S.nextChannelId(order, 20, -1), 10, "up moves to the previous");
  assert.equal(S.nextChannelId(order, 40, 1), null, "down at the bottom is a no-op");
  assert.equal(S.nextChannelId(order, 10, -1), null, "up at the top is a no-op");
  assert.equal(S.nextChannelId(order, null, 1), 10, "no active channel, down -> first");
  assert.equal(S.nextChannelId(order, null, -1), 40, "no active channel, up -> last");
  assert.equal(S.nextChannelId([], 10, 1), null, "empty list -> null");
});

test("nextUnreadChannelId finds the nearest unread in a direction", () => {
  const order = [10, 20, 30, 40, 50];
  const unread = { 10: 2, 40: 1 };
  assert.equal(S.nextUnreadChannelId(order, 20, unread, 1), 40, "skips read channels going down");
  assert.equal(S.nextUnreadChannelId(order, 30, unread, -1), 10, "skips read channels going up");
  assert.equal(S.nextUnreadChannelId(order, 40, unread, 1), null, "no unread below -> null");
  assert.equal(S.nextUnreadChannelId(order, 10, unread, -1), null, "no unread above -> null");
  assert.equal(S.nextUnreadChannelId(order, 40, unread, -1), 10, "looks past the active to a higher unread");
  assert.equal(S.nextUnreadChannelId(order, null, unread, 1), 10, "no active, down -> first unread");
  assert.equal(S.nextUnreadChannelId(order, null, unread, -1), 40, "no active, up -> last unread");
  assert.equal(S.nextUnreadChannelId(order, 20, {}, 1), null, "nothing unread -> null");
});

test("anyVideoPresent: own camera on is enough", () => {
  const vcs = { videoMuted: false, participants: [{ user_id: 1, video_muted: true }] };
  assert.equal(S.anyVideoPresent(vcs, 1), true);
});

test("anyVideoPresent: a peer's camera on counts even when ours is off", () => {
  const vcs = { videoMuted: true, participants: [{ user_id: 1, video_muted: true }, { user_id: 2, video_muted: false }] };
  assert.equal(S.anyVideoPresent(vcs, 1), true);
});

test("anyVideoPresent: all cameras off -> no video", () => {
  const vcs = { videoMuted: true, participants: [{ user_id: 1, video_muted: true }, { user_id: 2, video_muted: true }] };
  assert.equal(S.anyVideoPresent(vcs, 1), false);
});

test("anyVideoPresent: our own muted camera does not count as a peer's", () => {
  // only participant is us, camera off -> nothing to show (the some() must skip self)
  const vcs = { videoMuted: true, participants: [{ user_id: 1, video_muted: false }] };
  assert.equal(S.anyVideoPresent(vcs, 1), false);
});

test("anyVideoPresent: tolerates a missing participants list", () => {
  assert.equal(S.anyVideoPresent({ videoMuted: true }, 1), false);
  assert.equal(S.anyVideoPresent({ videoMuted: false }, 1), true);
});
