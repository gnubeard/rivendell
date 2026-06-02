import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../static/state.js";

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
