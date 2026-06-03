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

test("setPresence updates only online/status and is a no-op for unknown user", () => {
  let s = S.setUsers(S.initialState(), [{ id: 1, username: "a", online: false }]);
  s = S.setPresence(s, 1, true, "online");
  assert.equal(s.users[1].online, true);
  assert.equal(s.users[1].status, "online");
  const before = s;
  s = S.setPresence(s, 99, true, "online");
  assert.equal(s, before, "unknown user returns same state reference");
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
});

test("applyEvent routes message.new and message.delete", () => {
  let s = S.initialState();
  s = S.applyEvent(s, { type: "message.new", payload: { id: 1, channel_id: 7, content: "hi" } });
  assert.equal(s.messages[7].length, 1);
  s = S.applyEvent(s, { type: "message.delete", payload: { id: 1, channel_id: 7 } });
  assert.equal(s.messages[7][0].content, "");
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
