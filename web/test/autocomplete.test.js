import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mentionedUsernames,
  filterMentionCandidates,
  filterEmojiCandidates,
  filterChannelCandidates,
  clampIndex,
} from "../static/autocomplete.js";

// ---- mentionedUsernames ----

test("mentionedUsernames collects @-mentions, lowercased", () => {
  const s = mentionedUsernames("hi @Alice and @bob_2", -1);
  assert.deepEqual([...s].sort(), ["alice", "bob_2"]);
});

test("mentionedUsernames excludes the mention being typed at triggerAt", () => {
  // "@al" is being typed at index 3; the earlier @bob counts, this one doesn't.
  const text = "@bob @al";
  const triggerAt = text.indexOf("@al"); // 5
  assert.deepEqual([...mentionedUsernames(text, triggerAt)], ["bob"]);
});

test("mentionedUsernames ignores @ preceded by a word char (e.g. emails)", () => {
  assert.equal(mentionedUsernames("mail me at bob@host today", -1).size, 0);
});

test("mentionedUsernames requires 2+ char names (matches the trigger regex)", () => {
  assert.equal(mentionedUsernames("hey @a there", -1).size, 0);
});

// ---- filterMentionCandidates ----

const users = {
  1: { id: 1, username: "alice", display_name: "Alice A", is_active: true },
  2: { id: 2, username: "alvin", display_name: "Alvin", is_active: true },
  3: { id: 3, username: "bob", display_name: "Bob", is_active: true },
  4: { id: 4, username: "me", display_name: "Me", is_active: true },
  5: { id: 5, username: "gone", display_name: "Gone", is_active: false },
};
const opts = (over = {}) => ({ meId: 4, activeMemberIds: null, alreadyMentioned: new Set(), ...over });

test("filterMentionCandidates prefix-matches username or display name", () => {
  const r = filterMentionCandidates(users, "al", opts()).map((u) => u.username);
  assert.deepEqual(r, ["alice", "alvin"]); // alphabetical
});

test("filterMentionCandidates excludes me, inactive users, and the already-mentioned", () => {
  const r = filterMentionCandidates(users, "", opts({ alreadyMentioned: new Set(["alice"]) }))
    .map((u) => u.username);
  assert.deepEqual(r, ["alvin", "bob"]); // no me (id 4), no gone (inactive), no alice (mentioned)
});

test("filterMentionCandidates honors the channel audience gate when set", () => {
  const r = filterMentionCandidates(users, "", opts({ activeMemberIds: new Set([1, 3]) }))
    .map((u) => u.username);
  assert.deepEqual(r, ["alice", "bob"]); // only members 1 and 3
});

test("filterMentionCandidates matches on display name too", () => {
  const r = filterMentionCandidates(users, "bo", opts()).map((u) => u.username);
  assert.deepEqual(r, ["bob"]);
});

test("filterMentionCandidates caps at 8", () => {
  const many = {};
  for (let i = 0; i < 20; i++) many[i] = { id: i, username: "user" + String(i).padStart(2, "0"), is_active: true };
  assert.equal(filterMentionCandidates(many, "user", opts({ meId: -1 })).length, 8);
});

// ---- filterEmojiCandidates ----

const builtins = { smile: "🙂", smirk: "😏", tada: "🎉" };

test("filterEmojiCandidates prefix-matches and sorts the combined list by code", () => {
  // builtins and custom are merged then sorted by code (not grouped); a builtin
  // and custom with the same code keep builtin-first (stable sort).
  const r = filterEmojiCandidates("sm", builtins, ["smol_cat", "smile"]);
  assert.deepEqual(r, [
    { code: "smile", glyph: "🙂" }, // builtin smile
    { code: "smile" },              // custom smile (same code, stays after builtin)
    { code: "smirk", glyph: "😏" },
    { code: "smol_cat" },
  ]);
});

test("filterEmojiCandidates empty partial returns everything (capped)", () => {
  assert.equal(filterEmojiCandidates("", builtins, []).length, 3);
});

// ---- filterChannelCandidates ----

const channels = {
  10: { id: 10, name: "general", is_dm: false },
  11: { id: 11, name: "games", is_dm: false },
  12: { id: 12, name: "dm-1-2", is_dm: true },
};

test("filterChannelCandidates prefix-matches non-DM channels, alphabetical", () => {
  assert.deepEqual(filterChannelCandidates(channels, "g").map((c) => c.name), ["games", "general"]);
});

test("filterChannelCandidates never returns DMs", () => {
  assert.deepEqual(filterChannelCandidates(channels, "dm").map((c) => c.name), []);
});

// ---- clampIndex ----

test("clampIndex keeps the highlight in range as the list shrinks", () => {
  assert.equal(clampIndex(5, 3), 2); // past the end → last row
  assert.equal(clampIndex(1, 3), 1); // in range → unchanged
  assert.equal(clampIndex(2, 0), 0); // empty list → 0
});
