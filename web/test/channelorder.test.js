import { test } from "node:test";
import assert from "node:assert/strict";
import {
  regularChannelOrder,
  sidebarChannelOrder,
  dmDisplayName,
  channelReorderPatches,
} from "../static/channelorder.js";

// A minimal state stub shaped like state.js's model, enough for these selectors.
function makeState() {
  return {
    me: { id: 1, username: "me", display_name: "Me" },
    users: {
      1: { id: 1, username: "me", display_name: "Me" },
      2: { id: 2, username: "bob", display_name: "Bob" },
    },
    channels: {
      10: { id: 10, name: "general", is_dm: false, position: 0 },
      11: { id: 11, name: "random", is_dm: false, position: 1 },
      20: { id: 20, name: "dm-1-2", is_dm: true, position: 0 },
    },
    channelOrder: [10, 11, 20],
  };
}

test("regularChannelOrder drops DMs, keeps stored order", () => {
  assert.deepEqual(regularChannelOrder(makeState()), [10, 11]);
});

test("sidebarChannelOrder lists regular channels first, then DMs", () => {
  assert.deepEqual(sidebarChannelOrder(makeState()), [10, 11, 20]);
});

test("sidebarChannelOrder keeps DMs after channels even when channelOrder interleaves", () => {
  const s = makeState();
  s.channelOrder = [20, 10, 11]; // a DM sorted to the top of the raw order
  assert.deepEqual(sidebarChannelOrder(s), [10, 11, 20]);
});

test("dmDisplayName resolves the other participant", () => {
  const s = makeState();
  assert.equal(dmDisplayName(s, s.channels[20]), "Bob");
});

test("dmDisplayName falls back to the raw channel name when the user isn't loaded", () => {
  const s = makeState();
  delete s.users[2];
  assert.equal(dmDisplayName(s, s.channels[20]), "dm-1-2");
});

test("dmDisplayName appends (you) for a self-DM", () => {
  const s = makeState();
  s.channels[21] = { id: 21, name: "dm-1-1", is_dm: true, position: 0 };
  assert.equal(dmDisplayName(s, s.channels[21]), "Me (you)");
});

test("dmDisplayName self-DM falls back to username when display_name is absent", () => {
  const s = makeState();
  s.me = { id: 1, username: "me" };
  s.users[1] = { id: 1, username: "me" };
  s.channels[21] = { id: 21, name: "dm-1-1", is_dm: true, position: 0 };
  assert.equal(dmDisplayName(s, s.channels[21]), "me (you)");
});

test("channelReorderPatches returns only the positions that changed", () => {
  const channels = {
    10: { id: 10, position: 0 },
    11: { id: 11, position: 1 },
    12: { id: 12, position: 2 },
  };
  // Swap the first two: 11 -> idx0, 10 -> idx1, 12 stays at idx2.
  const { patches } = channelReorderPatches([11, 10, 12], channels);
  assert.deepEqual(patches, [
    { cid: 11, idx: 0 },
    { cid: 10, idx: 1 },
  ]);
});

test("channelReorderPatches yields no patches when the order is unchanged", () => {
  const channels = {
    10: { id: 10, position: 0 },
    11: { id: 11, position: 1 },
  };
  const { patches } = channelReorderPatches([10, 11], channels);
  assert.deepEqual(patches, []);
});

test("channelReorderPatches folds new positions into all listed channels for the optimistic update", () => {
  const channels = {
    10: { id: 10, position: 0 },
    11: { id: 11, position: 1 },
  };
  const { updated } = channelReorderPatches([11, 10], channels);
  const byId = Object.fromEntries(updated.map((c) => [c.id, c.position]));
  assert.equal(byId[11], 0);
  assert.equal(byId[10], 1);
});

test("channelReorderPatches leaves channels absent from the order untouched (DMs)", () => {
  const channels = {
    10: { id: 10, position: 0 },
    11: { id: 11, position: 1 },
    20: { id: 20, position: 5, is_dm: true }, // a DM, not part of the reorder
  };
  const { updated } = channelReorderPatches([11, 10], channels);
  const dm = updated.find((c) => c.id === 20);
  assert.equal(dm.position, 5); // unchanged
});

test("channelReorderPatches renormalizes fresh-install positions (all default 0) to contiguous", () => {
  const channels = {
    10: { id: 10, position: 0 },
    11: { id: 11, position: 0 },
    12: { id: 12, position: 0 },
  };
  const { patches } = channelReorderPatches([10, 11, 12], channels);
  // 10 already at idx0; 11 and 12 move off the shared 0.
  assert.deepEqual(patches, [
    { cid: 11, idx: 1 },
    { cid: 12, idx: 2 },
  ]);
});
