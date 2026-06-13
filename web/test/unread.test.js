import { test } from "node:test";
import assert from "node:assert/strict";
import { createUnreadTracker, unreadCountAfter } from "../static/unread.js";

test("markerFor is 0 for an untouched channel", () => {
  const u = createUnreadTracker();
  assert.equal(u.markerFor("c1"), 0);
});

test("openChannel places the divider at the old cursor only when there were unreads", () => {
  const u = createUnreadTracker();
  u.openChannel("c1", true, 42);
  assert.equal(u.markerFor("c1"), 42);

  // Caught up: divider suppressed (0) so it doesn't pop on the next arrival.
  u.openChannel("c2", false, 99);
  assert.equal(u.markerFor("c2"), 0);
});

test("openChannel tolerates a missing last-read cursor", () => {
  const u = createUnreadTracker();
  u.openChannel("c1", true, undefined);
  assert.equal(u.markerFor("c1"), 0);
});

test("openChannel lifts mark-unread suppression", () => {
  const u = createUnreadTracker();
  u.setManualUnread("c1");
  assert.equal(u.isManualUnread("c1"), true);
  u.openChannel("c1", true, 10);
  assert.equal(u.isManualUnread("c1"), false);
});

test("seedMarker mirrors openChannel's rule but only on first set (idempotent)", () => {
  const u = createUnreadTracker();
  u.seedMarker("c1", true, 7);
  assert.equal(u.markerFor("c1"), 7);
  // A second seed must not move an already-placed divider.
  u.seedMarker("c1", true, 999);
  assert.equal(u.markerFor("c1"), 7);
});

test("seedMarker does not move a divider explicitly set to 0", () => {
  const u = createUnreadTracker();
  u.openChannel("c1", false, 50); // marker = 0
  u.seedMarker("c1", true, 50); // would set 50 if treated as unset
  assert.equal(u.markerFor("c1"), 0);
});

test("pinMarkerIfUnset plants the divider once, then leaves it", () => {
  const u = createUnreadTracker();
  u.pinMarkerIfUnset("c1", 5);
  assert.equal(u.markerFor("c1"), 5);
  // A later arrival must not move it down.
  u.pinMarkerIfUnset("c1", 20);
  assert.equal(u.markerFor("c1"), 5);
});

test("pinMarkerIfUnset treats a missing cursor as 0", () => {
  const u = createUnreadTracker();
  u.pinMarkerIfUnset("c1", undefined);
  assert.equal(u.markerFor("c1"), 0);
});

test("setMarker moves the divider explicitly, including to 0", () => {
  const u = createUnreadTracker();
  u.setMarker("c1", 12);
  assert.equal(u.markerFor("c1"), 12);
  u.setMarker("c1", 0);
  assert.equal(u.markerFor("c1"), 0);
});

test("manual-unread flag round-trips", () => {
  const u = createUnreadTracker();
  assert.equal(u.isManualUnread("c1"), false);
  u.setManualUnread("c1");
  assert.equal(u.isManualUnread("c1"), true);
  u.clearManualUnread("c1");
  assert.equal(u.isManualUnread("c1"), false);
});

test("alreadyMarked dedupes only the exact recorded id", () => {
  const u = createUnreadTracker();
  assert.equal(u.alreadyMarked("c1", 100), false);
  u.recordMarked("c1", 100);
  assert.equal(u.alreadyMarked("c1", 100), true);
  assert.equal(u.alreadyMarked("c1", 101), false); // a newer message still POSTs
});

test("forgetMarked clears the dedupe so a re-read re-POSTs", () => {
  const u = createUnreadTracker();
  u.recordMarked("c1", 100);
  u.forgetMarked("c1");
  assert.equal(u.alreadyMarked("c1", 100), false);
});

test("trackers are independent instances (no shared module state)", () => {
  const a = createUnreadTracker();
  const b = createUnreadTracker();
  a.setManualUnread("c1");
  a.setMarker("c1", 9);
  assert.equal(b.isManualUnread("c1"), false);
  assert.equal(b.markerFor("c1"), 0);
});

test("unreadCountAfter counts loaded messages past the cursor that aren't mine", () => {
  const msgs = [
    { id: 1, user_id: 7 },
    { id: 2, user_id: 1 }, // me
    { id: 3, user_id: 7 },
    { id: 4, user_id: 9 },
  ];
  assert.equal(unreadCountAfter(msgs, 1, 1), 2); // ids 3 and 4 (id 2 is mine)
  assert.equal(unreadCountAfter(msgs, 4, 1), 0); // nothing past the newest
  assert.equal(unreadCountAfter(msgs, 0, 1), 3); // all but my own
});

test("unreadCountAfter tolerates a null/empty message list", () => {
  assert.equal(unreadCountAfter(null, 0, 1), 0);
  assert.equal(unreadCountAfter([], 5, 1), 0);
});
