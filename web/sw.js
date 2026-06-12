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
  // openWindow/focus must run inside waitUntil or the user-gesture is lost.
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open rivendell tab if there is one: focus it and tell the app
      // where to navigate (it parses the permalink hash).
      for (const c of wins) {
        if ("focus" in c) {
          await c.focus();
          try {
            c.postMessage({ type: "notificationclick", url });
          } catch (e) {
            /* a focused client that can't receive a message still got focused */
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })()
  );
});
