// sw.js — rivendell service worker.
//
// Single purpose: Web Push. It renders an incoming push as an OS notification
// (so DMs and @-mentions arrive even when the app is fully closed) and routes a
// click on one back to the right message. It deliberately does NOT cache or
// intercept fetches — there is no offline-app behaviour here, just notifications.
// Dependency-free, like the rest of the client.
//
// The push payload is the JSON the server sends in sendPushNotifications:
//   { title, body, channelId, url, tag }
// where `url` is a permalink hash path ("/#c<channelId>/m<messageId>").

self.addEventListener("install", () => {
  // Activate immediately rather than waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of already-open tabs so they can receive postMessage routing.
  event.waitUntil(self.clients.claim());
});

// urlBase64ToUint8Array decodes a base64url VAPID key into the Uint8Array
// pushManager.subscribe expects. Duplicated from notify.js because a classic
// service worker can't import the page's ES modules. Keep the two in sync.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// pushsubscriptionchange fires when the browser rotates or expires our push
// endpoint (Firefox does this periodically). Without re-registering the new
// subscription with the server, the server keeps pushing to the dead endpoint,
// gets 410 Gone, prunes it, and the user silently stops receiving pushes until
// they next reload the page with notifications on. So renew it here, from the
// worker, with no tab open. The session cookie is SameSite=Lax + same-origin, so
// credentialed fetches still authenticate. Best-effort throughout.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        // Firefox usually hands us the replacement directly; Chrome leaves it
        // null and expects us to re-subscribe with the original server key.
        let sub = event.newSubscription || null;
        if (!sub) {
          const keyResp = await fetch("/api/push/key", { credentials: "include" });
          if (!keyResp.ok) return;
          const { enabled, key } = await keyResp.json();
          if (!enabled || !key) return;
          sub = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key),
          });
        }
        const json = sub.toJSON();
        await fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: { p256dh: json.keys && json.keys.p256dh, auth: json.keys && json.keys.auth },
          }),
        });
        // Drop the stale endpoint server-side so it doesn't linger as a dead row.
        const old = event.oldSubscription && event.oldSubscription.endpoint;
        if (old && old !== json.endpoint) {
          await fetch("/api/push/unsubscribe", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: old }),
          });
        }
      } catch (e) {
        /* best-effort renewal — nothing useful to do on failure here */
      }
    })()
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || "New message";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    icon: "/static/icon-192.png",
    badge: "/static/icon-192.png",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  // pickClient chooses the best existing window to surface: a currently-visible
  // rivendell tab first, else any same-origin one, else the first client. Focusing
  // wins[0] blindly could foreground the wrong (or a non-visible) tab when several
  // are open.
  function pickClient(wins) {
    let sameOrigin = null;
    for (const c of wins) {
      if (c.visibilityState === "visible") return c;
      if (!sameOrigin && c.url && c.url.indexOf(self.registration.scope) === 0) sameOrigin = c;
    }
    return sameOrigin || wins[0] || null;
  }

  // openWindow/focus must run inside waitUntil or the user-gesture is lost.
  event.waitUntil(
    (async () => {
      const scope = self.registration.scope;
      const isOurs = (c) => c.url && c.url.indexOf(scope) === 0;

      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = pickClient(wins);

      // First, point a live app at the message and ask its tab to the foreground.
      // navigate() drops the permalink hash (the page's hashchange listener jumps
      // from it) and postMessage jumps an already-foreground app without a reload —
      // the two are de-duped app-side. focus() requests the foreground transition
      // (it works on desktop/Chrome). All three are harmless no-ops on a dead client.
      if (client) {
        if (client.navigate) {
          try { await client.navigate(url); } catch (e) { /* detached/cross-origin */ }
        }
        try { client.postMessage({ type: "notificationclick", url }); } catch (e) { /* dead client */ }
        try { if (client.focus) await client.focus(); } catch (e) { /* focus() can reject */ }
      }

      // Then openWindow UNLESS a rivendell view is genuinely frontmost now. The only
      // trustworthy signal is the live visibility from a fresh matchAll — NOT the
      // WindowClient that focus() resolves with, which on Firefox (a browser tab AND
      // an installed PWA) optimistically reports "visible" even though the view never
      // came forward and stays buried behind whatever was on top. So: focus() worked
      // (desktop/Chrome) ⇒ a tab is now visible ⇒ skip openWindow, no duplicate; the
      // view is buried, a fully-closed tab, or the PWA didn't surface ⇒ nothing is
      // visible ⇒ openWindow to actually bring it forward. Gating on visibility first
      // means an already-front view is never duplicated.
      const after = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const surfaced = after.some((c) => isOurs(c) && c.visibilityState === "visible");
      if (!surfaced && self.clients.openWindow) {
        try { await self.clients.openWindow(url); } catch (e) { /* nothing more we can do */ }
      }
    })()
  );
});
