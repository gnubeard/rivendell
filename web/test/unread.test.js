import { test } from "node:test";
import assert from "node:assert/strict";
import { createUnreadTracker, unreadCountAfter, classifyIncomingMessage, shouldInsertUnreadMarker } from "../static/unread.js";

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

// --- shouldInsertUnreadMarker: the "New messages" divider placement decision ---

test("shouldInsertUnreadMarker fires for the first message past the cursor", () => {
  assert.equal(shouldInsertUnreadMarker(false, 10, 11), true);
  assert.equal(shouldInsertUnreadMarker(false, 10, 10), false); // not strictly newer
  assert.equal(shouldInsertUnreadMarker(false, 10, 9), false);
});

test("shouldInsertUnreadMarker fires at most once per render", () => {
  // markerInserted already true ⇒ never again, even for a qualifying message.
  assert.equal(shouldInsertUnreadMarker(true, 10, 99), false);
});

test("shouldInsertUnreadMarker is suppressed when there's no divider cursor", () => {
  // markerAt 0 means "no unreads when the channel opened" — no divider at all.
  assert.equal(shouldInsertUnreadMarker(false, 0, 5), false);
});

// --- classifyIncomingMessage: the unread/mention/ping decision matrix ---

// me = alice (id 1). Channel 7 is a regular channel; channel 9 is a DM. Channel 7
// already holds a message of mine (id 100) so replies-to-me can be detected.
const ME = { id: 1, username: "alice" };
function S0(over = {}) {
  return {
    me: ME,
    channels: { 7: { id: 7, is_dm: false }, 9: { id: 9, is_dm: true } },
    messages: { 7: [{ id: 100, user_id: 1 }] },
    muted: {},
    ...over,
  };
}
function evNew(over = {}) {
  return { type: "message.new", payload: { channel_id: 7, user_id: 2, id: 200, content: "hello", ...over } };
}
const view = (o = {}) => ({ active: false, focused: true, adminPanelOpen: false, ...o });

test("classify: my own message is never unread or a ping", () => {
  const d = classifyIncomingMessage(S0(), evNew({ user_id: 1 }), view());
  assert.equal(d.isNewFromMe, true);
  assert.equal(d.isNewFromOther, false);
  assert.equal(d.countUnread, false);
  assert.equal(d.ping, false);
});

test("classify: plain message in an unviewed channel counts unread but doesn't ping", () => {
  const d = classifyIncomingMessage(S0(), evNew(), view({ active: false }));
  assert.equal(d.countUnread, true);
  assert.equal(d.countMention, false);
  assert.equal(d.pingsMe, false);
  assert.equal(d.ping, false);
});

test("classify: an @-mention counts unread + mention and pings", () => {
  const d = classifyIncomingMessage(S0(), evNew({ content: "hey @alice" }), view({ active: false }));
  assert.equal(d.mentioned, true);
  assert.equal(d.countUnread, true);
  assert.equal(d.countMention, true);
  assert.equal(d.ping, true);
});

test("classify: a reply to my message pings (via payload or loaded history), to others' doesn't", () => {
  // reply_to_user_id names me directly.
  let d = classifyIncomingMessage(S0(), evNew({ content: "ok", reply_to_id: 100, reply_to_user_id: 1 }), view());
  assert.equal(d.mentioned, true);
  assert.equal(d.ping, true);
  // reply_to_user_id absent → matched by looking up the loaded message (id 100 is mine).
  d = classifyIncomingMessage(S0(), evNew({ content: "ok", reply_to_id: 100 }), view());
  assert.equal(d.mentioned, true, "reply matched via loaded messages");
  // A reply to someone else's message is not a ping.
  d = classifyIncomingMessage(
    S0({ messages: { 7: [{ id: 100, user_id: 3 }] } }),
    evNew({ content: "ok", reply_to_id: 100, reply_to_user_id: 3 }), view());
  assert.equal(d.mentioned, false);
  assert.equal(d.ping, false);
});

test("classify: any DM message pings", () => {
  const d = classifyIncomingMessage(S0(), evNew({ channel_id: 9 }), view({ active: false }));
  assert.equal(d.pingsMe, true);
  assert.equal(d.ping, true);
});

test("classify: an authorless system line in a DM never pings (no 'Someone' alert)", () => {
  // "Call ended" et al.: is_system, user_id null. It slips past isNewFromMe and reads as
  // from-other, but it's not a person pinging you — it must not chime or notify. Still
  // counts as unread like any new line.
  const d = classifyIncomingMessage(
    S0(), evNew({ channel_id: 9, user_id: null, is_system: true, content: "Call ended" }), view({ active: false }));
  assert.equal(d.isNewFromOther, true);
  assert.equal(d.pingsMe, false);
  assert.equal(d.ping, false);
  assert.equal(d.countUnread, true);
});

test("classify: muting silences everything — no badge, no ping", () => {
  const d = classifyIncomingMessage(
    S0({ muted: { 9: true } }), evNew({ channel_id: 9, content: "@alice" }), view({ active: false }));
  assert.equal(d.muted, true);
  assert.equal(d.countUnread, false);
  assert.equal(d.countMention, false);
  assert.equal(d.ping, false);
});

test("classify: the focused active channel marks read, and a ping there only alerts under the admin panel", () => {
  // Viewing it, focused → not unread.
  assert.equal(classifyIncomingMessage(S0(), evNew(), view({ active: true, focused: true })).countUnread, false);
  // A ping while you're looking right at it: no alert...
  assert.equal(
    classifyIncomingMessage(S0(), evNew({ content: "@alice" }), view({ active: true, focused: true, adminPanelOpen: false })).ping,
    false, "looking at it → no alert");
  // ...unless the admin panel is covering the conversation.
  assert.equal(
    classifyIncomingMessage(S0(), evNew({ content: "@alice" }), view({ active: true, focused: true, adminPanelOpen: true })).ping,
    true, "admin panel covers it → alert anyway");
});

test("classify: the active channel while unfocused still counts unread and pings", () => {
  const d = classifyIncomingMessage(S0(), evNew({ content: "@alice" }), view({ active: true, focused: false }));
  assert.equal(d.countUnread, true);
  assert.equal(d.ping, true);
});
