// notify.js — opt-in desktop notifications via the browser Notification API.
//
// Like ws.js, the decision logic is split out as a pure, unit-testable predicate
// (shouldNotify) from the thin browser glue (request/show), which touches the
// global Notification object and is feature-detected + try/caught throughout.
//
// Scope: foreground notifications only — these fire while a tab is open or
// backgrounded. True background delivery when the app is fully closed is handled
// separately by Web Push (push.go + web/sw.js + the subscription lifecycle in
// notifyui.js).

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

// --- Web Push (offline notifications) ------------------------------------
//
// Foreground notifications (above) fire while a tab is alive. Web Push delivers
// them when the app is fully closed, via a service worker (sw.js) and a push
// subscription registered with the server's VAPID key. The pure helpers here are
// unit-tested; the browser glue is feature-detected and try/caught throughout.

// urlBase64ToUint8Array decodes a base64url string (the VAPID application server
// key) into the Uint8Array that pushManager.subscribe expects. Pure.
export function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// pushSubscriptionPayload trims a PushSubscription down to the exact shape the
// server's strict JSON decoder accepts: { endpoint, keys: { p256dh, auth } }.
// Accepts either a real PushSubscription (with .toJSON()) or a plain object.
// Pure.
export function pushSubscriptionPayload(sub) {
  const json = sub && typeof sub.toJSON === "function" ? sub.toJSON() : sub || {};
  const keys = json.keys || {};
  return { endpoint: json.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

// pushSupported reports whether this browser can do Web Push at all (a service
// worker and the Push API). Notifications can still work foreground-only without
// these.
export function pushSupported() {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window
  );
}

let swRegistration = null;

// ensureServiceWorker registers sw.js (idempotent) and caches the registration.
// Returns the registration or null if unsupported / failed. Never throws.
export async function ensureServiceWorker() {
  if (!pushSupported()) return null;
  if (swRegistration) return swRegistration;
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    return swRegistration;
  } catch (e) {
    console.warn("rivendell: service worker registration failed:", e && e.message);
    return null;
  }
}

// subscribeToPush ensures the service worker is registered and returns a push
// subscription, reusing an existing one or creating it with the given VAPID key.
// Returns the PushSubscription or null. Never throws.
export async function subscribeToPush(applicationServerKeyB64) {
  const reg = await ensureServiceWorker();
  if (!reg) return null;
  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, // mandatory in Chrome
        applicationServerKey: urlBase64ToUint8Array(applicationServerKeyB64),
      });
    }
    return sub;
  } catch (e) {
    console.warn("rivendell: push subscribe failed:", e && e.message);
    return null;
  }
}

// unsubscribeFromPush cancels the browser's push subscription and returns the
// endpoint it had (so the caller can tell the server to drop it), or null. Never
// throws.
export async function unsubscribeFromPush() {
  if (!pushSupported()) return null;
  try {
    const reg = swRegistration || (await navigator.serviceWorker.getRegistration());
    if (!reg) return null;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return null;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    return endpoint;
  } catch (e) {
    console.warn("rivendell: push unsubscribe failed:", e && e.message);
    return null;
  }
}

// showViaServiceWorker shows a notification through the service worker
// registration instead of the page-context constructor. This is the path that
// works on mobile (Android Chrome throws on `new Notification()`), and routing
// clicks goes through the SW's notificationclick handler via `data.url`. Returns
// true if it showed, false to signal the caller to fall back. Never throws.
export async function showViaServiceWorker(title, { body = "", tag, icon, url } = {}) {
  const reg = swRegistration || (pushSupported() ? await navigator.serviceWorker.getRegistration() : null);
  if (!reg || typeof reg.showNotification !== "function") return false;
  try {
    await reg.showNotification(title, {
      body: body.length > 180 ? body.slice(0, 179) + "…" : body,
      tag,
      renotify: Boolean(tag),
      icon,
      data: { url: url || "/" },
    });
    return true;
  } catch (e) {
    return false;
  }
}

// closeNotificationsByTag dismisses any currently-shown service-worker
// notifications carrying the given tag. The OS won't remove a notification on its
// own when the underlying event resolves (e.g. an incoming call that gets
// answered/declined/times out), so callers use this to auto-dismiss it. Only the
// SW path is addressable by tag after the fact; a page-context Notification must
// be closed via its own handle. Never throws.
export async function closeNotificationsByTag(tag) {
  if (!tag) return;
  try {
    const reg = swRegistration || (pushSupported() ? await navigator.serviceWorker.getRegistration() : null);
    if (!reg || typeof reg.getNotifications !== "function") return;
    const list = await reg.getNotifications({ tag });
    for (const n of list) n.close();
  } catch (e) {
    // best-effort — dismissing a stale notification should never surface an error
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
