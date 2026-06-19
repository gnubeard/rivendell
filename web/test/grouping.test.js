import { test } from "node:test";
import assert from "node:assert/strict";
import { groupingAnchor, liveDeletedStillLoaded } from "../static/grouping.js";

const t = (iso) => new Date(iso).getTime();
const msg = (id, user, iso, extra = {}) => ({ id, user_id: user, created_at: iso, ...extra });

// A forward reference that mirrors the renderMessages loop's anchor accumulator
// (system + drawn-tombstone reset lastUser/lastTime; invisible deleted runs are
// transparent). The parity test below asserts the backward groupingAnchor agrees with
// it for every normal message — the two encodings must never drift.
function forwardAnchors(msgs, isLive) {
  const out = {};
  let lastUser = null;
  let lastTime = 0;
  let i = 0;
  while (i < msgs.length) {
    if (msgs[i].deleted_at) {
      let j = i;
      let drew = false;
      while (j < msgs.length && msgs[j].deleted_at) {
        if (isLive(msgs[j].id)) drew = true;
        j++;
      }
      if (drew) { lastUser = null; lastTime = 0; }
      i = j;
      continue;
    }
    const m = msgs[i];
    if (m.is_system) { lastUser = null; lastTime = 0; i++; continue; }
    out[i] = lastUser === null ? null : { user: lastUser, time: lastTime };
    lastUser = m.user_id;
    lastTime = t(m.created_at);
    i++;
  }
  return out;
}

const none = () => false;

test("groupingAnchor: first message has no anchor", () => {
  const msgs = [msg(1, 7, "2026-06-19T10:00:00Z")];
  assert.equal(groupingAnchor(msgs, 0, none), null);
});

test("groupingAnchor: groups under the immediately preceding normal message", () => {
  const msgs = [msg(1, 7, "2026-06-19T10:00:00Z"), msg(2, 7, "2026-06-19T10:00:05Z")];
  assert.deepEqual(groupingAnchor(msgs, 1, none), { user: 7, time: t("2026-06-19T10:00:00Z") });
});

test("groupingAnchor: a system line breaks the run", () => {
  const msgs = [
    msg(1, 7, "2026-06-19T10:00:00Z"),
    msg(2, 0, "2026-06-19T10:00:01Z", { is_system: true }),
    msg(3, 7, "2026-06-19T10:00:05Z"),
  ];
  assert.equal(groupingAnchor(msgs, 2, none), null);
});

test("groupingAnchor: a DRAWN tombstone breaks the run", () => {
  const msgs = [
    msg(1, 7, "2026-06-19T10:00:00Z"),
    msg(2, 7, "2026-06-19T10:00:02Z", { deleted_at: "2026-06-19T10:00:03Z" }),
    msg(3, 7, "2026-06-19T10:00:05Z"),
  ];
  // id 2 was deleted live this session → a visible tombstone → breaks grouping.
  assert.equal(groupingAnchor(msgs, 2, (id) => id === 2), null);
});

test("groupingAnchor: an invisible deleted run is transparent", () => {
  const msgs = [
    msg(1, 7, "2026-06-19T10:00:00Z"),
    msg(2, 7, "2026-06-19T10:00:02Z", { deleted_at: "2026-06-19T10:00:03Z" }),
    msg(3, 7, "2026-06-19T10:00:05Z"),
  ];
  // id 2 arrived already-deleted (not live this session) → no tombstone → transparent,
  // so msg 3 still anchors on msg 1.
  assert.deepEqual(groupingAnchor(msgs, 2, none), { user: 7, time: t("2026-06-19T10:00:00Z") });
});

test("parity: groupingAnchor matches the renderMessages forward loop for every normal row", () => {
  const msgs = [
    msg(1, 7, "2026-06-19T10:00:00Z"),
    msg(2, 7, "2026-06-19T10:00:01Z"),
    msg(3, 0, "2026-06-19T10:00:02Z", { is_system: true }),
    msg(4, 9, "2026-06-19T10:00:03Z"),
    msg(5, 9, "2026-06-19T10:00:04Z", { deleted_at: "2026-06-19T10:00:05Z" }), // invisible
    msg(6, 9, "2026-06-19T10:00:06Z"),
    msg(7, 9, "2026-06-19T10:00:07Z", { deleted_at: "2026-06-19T10:00:08Z" }), // drawn
    msg(8, 9, "2026-06-19T10:00:09Z"),
    msg(9, 3, "2026-06-19T10:00:10Z"),
  ];
  const isLive = (id) => id === 7; // only id 7 earned a visible tombstone
  const expected = forwardAnchors(msgs, isLive);
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].deleted_at || msgs[i].is_system) continue; // anchor only meaningful for normal rows
    assert.deepEqual(groupingAnchor(msgs, i, isLive), expected[i], `mismatch at index ${i}`);
  }
});

test("liveDeletedStillLoaded: keeps only ids present as a deleted row in some window", () => {
  const messagesByChannel = {
    1: [msg(10, 7, "t", { deleted_at: "t" }), msg(11, 7, "t")],
    2: [msg(20, 7, "t", { deleted_at: "t" })],
  };
  const liveDeleted = new Set([10, 20, 99]); // 99 is in no loaded window
  const kept = liveDeletedStillLoaded(messagesByChannel, liveDeleted);
  assert.deepEqual([...kept].sort((a, b) => a - b), [10, 20]);
});

test("liveDeletedStillLoaded: a non-deleted row with a matching id does not count", () => {
  const messagesByChannel = { 1: [msg(10, 7, "t")] }; // id 10 present but NOT deleted
  const kept = liveDeletedStillLoaded(messagesByChannel, [10]);
  assert.equal(kept.has(10), false);
});

test("liveDeletedStillLoaded: tolerates an empty/iterable input", () => {
  assert.equal(liveDeletedStillLoaded({}, []).size, 0);
  assert.equal(liveDeletedStillLoaded({ 1: null }, [1]).size, 0);
});
