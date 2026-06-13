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

test("reads return defaults when storage throws (private mode / blocked)", () => {
  const p = createPrefs(throwingStorage);
  assert.equal(p.loadNotif(), false);
  assert.equal(p.loadPttEnabled(), false);
  assert.equal(p.loadPttKeyCode(), "Backquote");
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
