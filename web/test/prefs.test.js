import { test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, normalizeTheme, createPrefs } from "../static/prefs.js";

// A Map-backed Storage stand-in (node:test has no localStorage).
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _dump: () => Object.fromEntries(m),
  };
}

// A Storage that throws on every access (private mode / blocked).
const throwingStorage = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("blocked"); },
};

test("normalizeTheme passes every known theme through unchanged", () => {
  for (const t of THEMES) assert.equal(normalizeTheme(t), t);
});

test("normalizeTheme falls back to 'default' for unknown/empty/missing values", () => {
  assert.equal(normalizeTheme("chartreuse"), "default");
  assert.equal(normalizeTheme(""), "default");
  assert.equal(normalizeTheme(undefined), "default");
  assert.equal(normalizeTheme(null), "default");
});

test("notif pref round-trips through storage as 1/0", () => {
  const s = fakeStorage();
  const p = createPrefs(s);
  assert.equal(p.loadNotif(), false); // missing → default false
  p.saveNotif(true);
  assert.equal(s._dump()["rivendell.notifications"], "1");
  assert.equal(p.loadNotif(), true);
  p.saveNotif(false);
  assert.equal(s._dump()["rivendell.notifications"], "0");
  assert.equal(p.loadNotif(), false);
});

test("a stored value other than '1' reads as false", () => {
  const p = createPrefs(fakeStorage({ "rivendell.notifications": "yes" }));
  assert.equal(p.loadNotif(), false);
});

test("PTT enabled round-trips and PTT keycode defaults to Backquote", () => {
  const s = fakeStorage();
  const p = createPrefs(s);
  assert.equal(p.loadPttEnabled(), false);
  assert.equal(p.loadPttKeyCode(), "Backquote"); // missing → default
  p.savePtt(true, "KeyT");
  assert.equal(p.loadPttEnabled(), true);
  assert.equal(p.loadPttKeyCode(), "KeyT");
  assert.equal(s._dump()["rivendell.ptt"], "1");
  assert.equal(s._dump()["rivendell.pttKey"], "KeyT");
});

test("savePtt persists both fields together", () => {
  const s = fakeStorage();
  createPrefs(s).savePtt(false, "Space");
  assert.deepEqual(s._dump(), { "rivendell.ptt": "0", "rivendell.pttKey": "Space" });
});

test("a blank stored keycode falls back to Backquote", () => {
  const p = createPrefs(fakeStorage({ "rivendell.pttKey": "" }));
  assert.equal(p.loadPttKeyCode(), "Backquote");
});

test("rich-text pref defaults ON and only an explicit '0' disables it", () => {
  const s = fakeStorage();
  const p = createPrefs(s);
  assert.equal(p.loadRichText(), true); // missing → default on
  p.saveRichText(false);
  assert.equal(s._dump()["rivendell.richtext"], "0");
  assert.equal(p.loadRichText(), false);
  p.saveRichText(true);
  assert.equal(p.loadRichText(), true);
  // any non-"0" value (incl. junk) stays on — only "0" turns it off
  assert.equal(createPrefs(fakeStorage({ "rivendell.richtext": "whatever" })).loadRichText(), true);
});

test("reads return defaults when storage throws (private mode / blocked)", () => {
  const p = createPrefs(throwingStorage);
  assert.equal(p.loadNotif(), false);
  assert.equal(p.loadPttEnabled(), false);
  assert.equal(p.loadPttKeyCode(), "Backquote");
  assert.equal(p.loadRichText(), true); // default on even when storage is blocked
});

test("writes are best-effort and never throw when storage is blocked", () => {
  const p = createPrefs(throwingStorage);
  assert.doesNotThrow(() => p.saveNotif(true));
  assert.doesNotThrow(() => p.savePtt(true, "KeyT"));
});

test("createPrefs with no storage (no localStorage) degrades to defaults safely", () => {
  const p = createPrefs(undefined);
  assert.equal(p.loadNotif(), false);
  assert.equal(p.loadPttKeyCode(), "Backquote");
  assert.doesNotThrow(() => p.saveNotif(true));
});

test("recent emoji: push is most-recent-first, dedupes on value+kind, and caps", () => {
  const s = fakeStorage();
  const p = createPrefs(s);
  assert.deepEqual(p.loadRecentEmoji(), []); // missing → empty

  p.pushRecentEmoji("🔥", false);
  p.pushRecentEmoji("tada", true);
  assert.deepEqual(p.loadRecentEmoji(), [{ v: "tada", c: 1 }, { v: "🔥", c: 0 }]);

  // Re-picking moves to front without duplicating.
  p.pushRecentEmoji("🔥", false);
  assert.deepEqual(p.loadRecentEmoji(), [{ v: "🔥", c: 0 }, { v: "tada", c: 1 }]);

  // Same value, different kind is a distinct entry (literal glyph vs shortcode).
  p.pushRecentEmoji("tada", false);
  assert.deepEqual(p.loadRecentEmoji(),
    [{ v: "tada", c: 0 }, { v: "🔥", c: 0 }, { v: "tada", c: 1 }]);

  // Cap at 16: push 20 distinct, keep the newest 16.
  for (let i = 0; i < 20; i++) p.pushRecentEmoji(`e${i}`, true);
  const list = p.loadRecentEmoji();
  assert.equal(list.length, 16);
  assert.equal(list[0].v, "e19"); // newest first
  assert.equal(list[15].v, "e4");
});

test("recent emoji: malformed or non-array stored value reads as empty", () => {
  assert.deepEqual(createPrefs(fakeStorage({ "rivendell.recentEmoji": "not json" })).loadRecentEmoji(), []);
  assert.deepEqual(createPrefs(fakeStorage({ "rivendell.recentEmoji": '{"v":"x"}' })).loadRecentEmoji(), []);
  // Junk entries are filtered out; valid ones survive.
  assert.deepEqual(
    createPrefs(fakeStorage({ "rivendell.recentEmoji": '[{"v":"ok","c":1},{"bad":1},null,42]' })).loadRecentEmoji(),
    [{ v: "ok", c: 1 }],
  );
});

test("recent emoji: blocked storage reads empty and writes never throw", () => {
  const p = createPrefs(throwingStorage);
  assert.deepEqual(p.loadRecentEmoji(), []);
  assert.doesNotThrow(() => p.pushRecentEmoji("🔥", false));
  assert.deepEqual(p.pushRecentEmoji("🔥", false), [{ v: "🔥", c: 0 }]);
});
