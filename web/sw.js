// sw.js — Rivendell service worker.
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
      // Reuse an open Rivendell tab if there is one: focus it and tell the app
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
