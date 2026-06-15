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
const RECENT_EMOJI_KEY = "rivendell.recentEmoji";
const RECENT_EMOJI_CAP = 16; // most-recent-first; older picks fall off the end

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

    // Recently-used emoji, most-recent-first. Each entry is { v, c } — the picked
    // value (custom shortcode or literal Unicode glyph) and whether it's custom
    // (c:1 ⇒ :colon:-wrapped image; c:0 ⇒ literal grapheme). Stored as a JSON
    // array; a malformed/blocked read yields an empty list rather than throwing.
    loadRecentEmoji() {
      try {
        const arr = JSON.parse(storage.getItem(RECENT_EMOJI_KEY) || "[]");
        if (!Array.isArray(arr)) return [];
        // Defensively coerce shape so a corrupted entry can't crash a render.
        return arr
          .filter((e) => e && typeof e.v === "string")
          .map((e) => ({ v: e.v, c: e.c ? 1 : 0 }));
      } catch { return []; }
    },
    // pushRecentEmoji records a pick as most-recent, de-duplicating on value+kind
    // (so re-picking 🔥 moves it to the front, not adds a second copy) and capping
    // the list. Returns the new list so the caller can re-render without a reload.
    pushRecentEmoji(value, isCustom) {
      const entry = { v: value, c: isCustom ? 1 : 0 };
      const next = [entry, ...this.loadRecentEmoji().filter((e) => !(e.v === entry.v && e.c === entry.c))]
        .slice(0, RECENT_EMOJI_CAP);
      try { storage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
      return next;
    },
  };
}
