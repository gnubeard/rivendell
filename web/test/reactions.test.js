// reactions.test.js — unit tests for the reaction-related reducers in state.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../static/state.js";

// base builds a state with one channel (10) holding one message (id 1).
function base() {
  let s = S.initialState();
  s = { ...s, me: { id: 7 }, activeChannelId: 10 };
  s = S.setMessages(s, 10, [{ id: 1, channel_id: 10, user_id: 7, content: "hi" }]);
  return s;
}

test("setReactions sets and then replaces a message's reaction groups", () => {
  let s = base();
  s = S.setReactions(s, 10, 1, [{ emoji: "👍", user_ids: [7, 8] }]);
  assert.deepEqual(s.messages[10][0].reactions, [{ emoji: "👍", user_ids: [7, 8] }]);
  // Replace wholesale, not merge.
  s = S.setReactions(s, 10, 1, [{ emoji: "🎉", user_ids: [8] }]);
  assert.deepEqual(s.messages[10][0].reactions, [{ emoji: "🎉", user_ids: [8] }]);
});

test("setReactions is a no-op for an unloaded channel or message", () => {
  const s = base();
  assert.equal(S.setReactions(s, 999, 1, [{ emoji: "👍", user_ids: [7] }]), s);
  assert.equal(S.setReactions(s, 10, 999, [{ emoji: "👍", user_ids: [7] }]), s);
});

test("addMessage preserves existing reactions when the update omits them", () => {
  let s = base();
  s = S.setReactions(s, 10, 1, [{ emoji: "👍", user_ids: [8] }]);
  // A realtime edit/pin payload carries no reactions field.
  s = S.addMessage(s, { id: 1, channel_id: 10, user_id: 7, content: "hi (edited)", edited_at: "now" });
  assert.equal(s.messages[10][0].content, "hi (edited)");
  assert.deepEqual(s.messages[10][0].reactions, [{ emoji: "👍", user_ids: [8] }]);
});

test("addMessage uses incoming reactions when the payload includes them", () => {
  let s = base();
  s = S.setReactions(s, 10, 1, [{ emoji: "👍", user_ids: [8] }]);
  s = S.addMessage(s, { id: 1, channel_id: 10, user_id: 7, content: "hi", reactions: [] });
  assert.deepEqual(s.messages[10][0].reactions, []);
});

test("markMessageDeleted clears reactions", () => {
  let s = base();
  s = S.setReactions(s, 10, 1, [{ emoji: "👍", user_ids: [7, 8] }]);
  s = S.markMessageDeleted(s, 10, 1);
  assert.deepEqual(s.messages[10][0].reactions, []);
  assert.ok(s.messages[10][0].deleted_at);
});

test("applyEvent routes reaction.update to setReactions", () => {
  let s = base();
  s = S.applyEvent(s, {
    type: "reaction.update",
    payload: { channel_id: 10, message_id: 1, reactions: [{ emoji: "🔥", user_ids: [7] }] },
  });
  assert.deepEqual(s.messages[10][0].reactions, [{ emoji: "🔥", user_ids: [7] }]);
});
