import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardBody, makeCanSee, forwardTargets } from "../static/forward.js";

// A minimal state stub shaped like state.js's model. DM membership is parsed from
// the channel name (dm-<a>-<b>), so the names encode the participant ids.
function makeState() {
  return {
    me: { id: 1, username: "me", display_name: "Me" },
    users: {
      1: { id: 1, display_name: "Me", role: "member" },
      2: { id: 2, display_name: "Bob", role: "member" },
      3: { id: 3, display_name: "Carol", role: "member" },
    },
    channels: {
      10: { id: 10, name: "general", is_dm: false },
      11: { id: 11, name: "Random", is_dm: false },
      20: { id: 20, name: "dm-1-2", is_dm: true },
      21: { id: 21, name: "dm-1-3", is_dm: true },
    },
    channelOrder: [10, 11, 20, 21],
  };
}

// --- forwardBody -------------------------------------------------------------

test("forwardBody: a channel message forwards as an origin permalink", () => {
  const body = forwardBody({ id: 42 }, false, 10, "https://chat.example");
  assert.equal(body, "https://chat.example/#c10/m42");
});

test("forwardBody: a DM message forwards as a quoted copy, not a permalink", () => {
  const body = forwardBody({ id: 42, content: "hello there" }, true, 20, "https://chat.example");
  assert.equal(body, "*Forwarded:*\n> hello there");
  assert.ok(!body.includes("https://"), "DM forward must not embed a permalink");
});

test("forwardBody: a multi-line DM message quotes every line", () => {
  const body = forwardBody({ id: 7, content: "one\ntwo\nthree" }, true, 20, "https://x");
  assert.equal(body, "*Forwarded:*\n> one\n> two\n> three");
});

test("forwardBody: empty/absent DM content still yields a quoted shell", () => {
  assert.equal(forwardBody({ id: 1 }, true, 20, "https://x"), "*Forwarded:*\n> ");
  assert.equal(forwardBody({ id: 1, content: "" }, true, 20, "https://x"), "*Forwarded:*\n> ");
});

// --- makeCanSee --------------------------------------------------------------

test("makeCanSee: members and every mod/admin can see; others cannot", () => {
  const members = new Set([5]);
  const users = {
    5: { role: "member" },   // explicit member
    6: { role: "moderator" }, // non-member mod
    7: { role: "admin" },     // non-member admin
    8: { role: "member" },    // non-member member
  };
  const canSee = makeCanSee(members, users);
  assert.equal(canSee(5), true);
  assert.equal(canSee(6), true);
  assert.equal(canSee(7), true);
  assert.equal(canSee(8), false);
  assert.equal(canSee(999), false, "unknown user is not visible");
});

// --- forwardTargets ----------------------------------------------------------

test("forwardTargets: with no audience filter, lists everything in order", () => {
  const targets = forwardTargets(makeState(), null, "");
  assert.deepEqual(targets, [
    { id: 10, label: "#general" },
    { id: 11, label: "#Random" },
    { id: 20, label: "Bob" },
    { id: 21, label: "Carol" },
  ]);
});

test("forwardTargets: the needle filters by label, case-insensitively", () => {
  // Matches a channel (#Random) and a person (Carol) but not the rest.
  assert.deepEqual(forwardTargets(makeState(), null, "ran"), [{ id: 11, label: "#Random" }]);
  assert.deepEqual(forwardTargets(makeState(), null, "car"), [{ id: 21, label: "Carol" }]);
});

test("forwardTargets: canSee hides DMs whose other member can't see the source", () => {
  // Only Bob (id 2) can open the source permalink; the DM with Carol drops out,
  // but regular channels are never audience-filtered.
  const canSee = (uid) => uid === 2;
  const targets = forwardTargets(makeState(), canSee, "");
  assert.deepEqual(targets, [
    { id: 10, label: "#general" },
    { id: 11, label: "#Random" },
    { id: 20, label: "Bob" },
  ]);
});

test("forwardTargets: skips ids with no channel object", () => {
  const state = makeState();
  state.channelOrder = [10, 99, 11]; // 99 has no channels entry
  assert.deepEqual(forwardTargets(state, null, ""), [
    { id: 10, label: "#general" },
    { id: 11, label: "#Random" },
  ]);
});
