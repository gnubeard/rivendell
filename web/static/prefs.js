// prefs.js — browser-local user preferences (notifications, push-to-talk) and
// the theme allow-list.
//
// The notification/PTT settings live in localStorage (per browser, unlike the
// server-persisted profile). The serialization is trivial but the failure modes
// aren't: localStorage throws in private mode / when blocked, and a missing key
// must fall back to a sane default. createPrefs() centralizes that fail-safe
// handling behind a typed API, with the Storage injected so it's unit-testable
// in node:test (which has no localStorage). app.js keeps the live values in its
// own vars and calls these only to load on boot and persist on change.

export const THEMES = ["default", "light", "forest", "hotpink", "contrast", "vermillion", "cool-blue"];

// normalizeTheme clamps an arbitrary value to a known theme, falling back to the
// dark "default" so a bad or empty value can never leave the UI unstyled. Pure.
export function normalizeTheme(theme) {
  return THEMES.includes(theme) ? theme : "default";
}

const NOTIF_KEY = "rivendell.notifications";
const PTT_KEY = "rivendell.ptt";
const PTT_CODE_KEY = "rivendell.pttKey";
const DEFAULT_PTT_CODE = "Backquote"; // layout-independent KeyboardEvent.code
const RICHTEXT_KEY = "rivendell.richtext";

export function createPrefs(storage = globalThis.localStorage) {
  // Booleans persist as "1"/"0". Any storage error (private mode, blocked,
  // undefined storage) reads as the default and silently no-ops on write.
  const getBool = (key) => {
    try { return storage.getItem(key) === "1"; } catch { return false; }
  };
  const setBool = (key, on) => {
    try { storage.setItem(key, on ? "1" : "0"); } catch { /* best-effort */ }
  };

  return {
    loadNotif() { return getBool(NOTIF_KEY); },
    saveNotif(on) { setBool(NOTIF_KEY, on); },

    loadPttEnabled() { return getBool(PTT_KEY); },
    loadPttKeyCode() {
      try { return storage.getItem(PTT_CODE_KEY) || DEFAULT_PTT_CODE; } catch { return DEFAULT_PTT_CODE; }
    },
    // savePtt persists both PTT fields together (they change as a unit from the
    // profile UI: the on/off toggle and the bound-key rebind).
    savePtt(enabled, keyCode) {
      setBool(PTT_KEY, enabled);
      try { storage.setItem(PTT_CODE_KEY, keyCode); } catch { /* best-effort */ }
    },

    // Live markdown decoration in the composer (composer-richtext.js). Unlike
    // the others this defaults ON: only an explicit "0" disables it, so a fresh
    // browser (or one with storage blocked) gets the feature.
    loadRichText() {
      try { return storage.getItem(RICHTEXT_KEY) !== "0"; } catch { return true; }
    },
    saveRichText(on) { setBool(RICHTEXT_KEY, on); },
  };
}
