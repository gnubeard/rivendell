// notify.js — opt-in desktop notifications via the browser Notification API.
//
// Like ws.js, the decision logic is split out as a pure, unit-testable predicate
// (shouldNotify) from the thin browser glue (request/show), which touches the
// global Notification object and is feature-detected + try/caught throughout.
//
// Scope: foreground notifications only — these fire while a tab is open or
// backgrounded. True background delivery when the app is fully closed (Web Push)
// is a separate, deferred piece of work.

// shouldNotify decides whether to raise an OS notification for a ping. Pure.
//   permission — the current Notification.permission ("granted"/"denied"/"default")
//   enabled    — the user's saved opt-in preference (they toggled it on)
//   focused    — whether the user is actually looking at this tab right now
// We only notify when the user has opted in, granted the OS permission, and
// isn't already looking here (no point shouting at someone who can see it).
export function shouldNotify({ permission, enabled, focused }) {
  return enabled === true && permission === "granted" && focused === false;
}

// notificationsSupported reports whether this browser exposes the Notification
// API at all (older/embedded browsers may not).
export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

// currentPermission returns the browser's current permission string, or "denied"
// when the API is absent (so callers can treat "can't notify" uniformly).
export function currentPermission() {
  if (!notificationsSupported()) return "denied";
  return Notification.permission;
}

// requestNotificationPermission prompts the user to allow notifications and
// resolves to the resulting permission string. Handles both the modern
// promise-based API and the legacy callback form, and never throws.
export async function requestNotificationPermission() {
  if (!notificationsSupported()) return "denied";
  try {
    // Some implementations return a promise; older ones take a callback.
    const result = Notification.requestPermission();
    if (result && typeof result.then === "function") return await result;
    return await new Promise((resolve) => Notification.requestPermission(resolve));
  } catch (e) {
    console.warn("rivendell: notification permission request failed:", e && e.message);
    return currentPermission();
  }
}

// showNotification raises a single OS notification, guarded on support and a
// granted permission. `tag` collapses repeat pings for the same channel into one
// notification rather than stacking. `onclick` fires when the user activates it.
// Returns the Notification (or null) and never throws.
export function showNotification(title, { body = "", tag, icon, onclick } = {}) {
  if (!notificationsSupported() || Notification.permission !== "granted") return null;
  try {
    const n = new Notification(title, {
      body: body.length > 180 ? body.slice(0, 179) + "…" : body,
      tag,
      icon,
    });
    if (onclick) {
      n.onclick = () => {
        try {
          window.focus();
        } catch {}
        try {
          onclick();
        } catch {}
        n.close();
      };
    }
    return n;
  } catch (e) {
    console.warn("rivendell: could not show notification:", e && e.message);
    return null;
  }
}
