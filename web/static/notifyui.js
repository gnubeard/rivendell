// notifyui.js — the foreground-notification UX layer (the secretui.js / voiceui.js
// method applied to alerts). notify.js owns the pure decision (shouldNotify) and the
// browser primitives (the Notification API + Web Push subscribe/unsubscribe);
// prefs.js owns the opt-in persistence. This module owns the orchestration that
// wires those to the DOM and the realtime handler: the global "missed" count in the
// title + sidebar badge, the focused-tab ping toast, firePing's chime/toast/OS-alert
// decision, the Web Push subscription lifecycle, and the profile opt-in control.
//
// It owns two values that were app.js module state — `enabled` (the per-browser
// opt-in, seeded from prefs.loadNotif()) and `baseTitle` (the brand title sans any
// "(N)" prefix) — inside the factory closure. app.js reads the opt-in through
// isEnabled() (the ring path in voiceui.js reads it the same way, via the getter
// app.js injects), pushes the instance name in through setBaseTitle(), and drives
// the profile toggle through setEnabled().
//
// Deps: $/el (DOM helpers), getState (() => state, read fresh), api (push key +
// subscribe/unsubscribe + avatar URL), prefs (saveNotif), selectChannel/jumpToMessage
// (toast + SW-click navigation), and tabUnfocused (the focus predicate app.js owns).
// The pure decision (notify.js), the label/permalink helpers (format.js), the roster
// lookup (state.js), and the chime (tones.js) are imported directly.

import {
  shouldNotify,
  showNotification,
  showViaServiceWorker,
  requestNotificationPermission,
  currentPermission,
  notificationsSupported,
  pushSupported,
  ensureServiceWorker,
  subscribeToPush,
  unsubscribeFromPush,
  pushSubscriptionPayload,
} from "./notify.js";
import { totalMentions, displayNameOf } from "./state.js";
import { pingLabel, permalinkHash, decidePermalinkRoute } from "./format.js";
import { boop } from "./tones.js";

export function createNotifyUI({
  $, el, getState, api, prefs, selectChannel, jumpToMessage, tabUnfocused,
}) {
  // Per-browser desktop-notification opt-in. The OS permission is separate and
  // browser-owned; this is the in-app preference that gates it.
  let enabled = prefs.loadNotif();
  // The brand title, sans any "(N)" notification prefix. Seeded from the current
  // document title; applyInstanceName overwrites it via setBaseTitle once the
  // instance name loads.
  let baseTitle = document.title;

  // renderNotificationTotal reflects the global "missed notifications" count (the
  // sum of pings across channels) in the sidebar badge and the page title, so it's
  // visible even when the tab is in the background.
  function renderNotificationTotal() {
    const n = totalMentions(getState());
    const badge = $("#notif-total");
    if (badge) {
      badge.textContent = n > 99 ? "99+" : String(n);
      badge.hidden = n === 0;
    }
    document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
  }

  // showPingToast renders a brief top-of-screen toast for a ping that arrives while
  // the tab is focused (where OS notifications are suppressed). Auto-dismisses after
  // 4 s; tapping navigates to the channel. Mobile only — on desktop the toast is more
  // intrusive than useful (the message is already on screen or one click away), so it
  // is gated behind the mobile-layout breakpoint.
  function showPingToast(evt, ch) {
    if (!window.matchMedia("(max-width: 720px)").matches) return;
    const container = $("#ping-toasts");
    if (!container) return;
    const label = pingLabel(displayNameOf(getState(), evt.payload.user_id), ch);
    const body = (evt.payload.content || "").replace(/\n+/g, " ");
    const toast = el("div", { class: "ping-toast" },
      el("span", { class: "ping-toast-who" }, label),
      body ? el("span", { class: "ping-toast-body" }, body) : null,
    );
    let timer;
    const dismiss = () => { clearTimeout(timer); toast.remove(); };
    toast.onclick = () => { dismiss(); selectChannel(evt.payload.channel_id); };
    container.append(toast);
    timer = setTimeout(dismiss, 4000);
  }

  // firePing alerts the user to a ping (DM or @-mention): always a soft chime, plus
  // an in-app toast when the tab is focused (OS notifications are suppressed then),
  // or an OS notification when they've opted in and aren't looking here. The OS path
  // routes through the service worker when one is registered (works on mobile, and
  // clicks deep-link via the SW), falling back to a page-context Notification.
  function firePing(evt, ch) {
    boop();
    if (!tabUnfocused()) {
      showPingToast(evt, ch);
      return;
    }
    if (!shouldNotify({ permission: currentPermission(), enabled, focused: false })) {
      return;
    }
    const state = getState();
    const author = state.users[evt.payload.user_id];
    const title = pingLabel(displayNameOf(state, evt.payload.user_id), ch);
    const body = evt.payload.content || "";
    const tag = `rivendell-ch-${evt.payload.channel_id}`;
    const icon = author && author.has_avatar ? api.avatarURL(author.id) : undefined;
    const url = "/" + permalinkHash(evt.payload.channel_id, evt.payload.id);
    showViaServiceWorker(title, { body, tag, icon, url }).then((shown) => {
      if (!shown) {
        showNotification(title, { body, tag, icon, onclick: () => selectChannel(evt.payload.channel_id) });
      }
    });
  }

  // enablePush registers the service worker and a push subscription, then sends it
  // to the server so DMs/@-mentions arrive when the app is fully closed. Idempotent
  // and best-effort — any failure (older browser, blocked SW, denied permission)
  // leaves foreground notifications working and is logged, not surfaced.
  async function enablePush() {
    if (!pushSupported()) return;
    try {
      const { enabled: serverOn, key } = await api.pushKey();
      if (!serverOn || !key) return; // server has push disabled
      const sub = await subscribeToPush(key);
      if (!sub) return;
      await api.pushSubscribe(pushSubscriptionPayload(sub));
    } catch (e) {
      console.warn("rivendell: enable push failed:", e && e.message);
    }
  }

  // disablePush cancels the browser's push subscription and tells the server to
  // drop it. Best-effort.
  async function disablePush() {
    try {
      const endpoint = await unsubscribeFromPush();
      if (endpoint) await api.pushUnsubscribe(endpoint);
    } catch (e) {
      console.warn("rivendell: disable push failed:", e && e.message);
    }
  }

  // routeToPermalink is the single sink for a notification click reaching an
  // already-open tab. A click can arrive two ways, and on mobile only the second
  // is reliable:
  //   1. the SW postMessage — works while the page's message listener is alive
  //      (desktop), but a backgrounded/frozen mobile tab may never run it;
  //   2. the SW's client.navigate(), which sets the permalink hash on the tab and
  //      fires `hashchange` (or surfaces on the next visibility flip) — this is the
  //      path that survives a frozen tab. It only does anything because we listen
  //      for it here: the app otherwise reads the hash exactly once, at boot, so
  //      without this navigate() was inert (the "URL is in the location" half of
  //      sw.js's plan was never wired up — that was the mobile bug).
  // jumpToMessage self-handles a channel absent from local state (a closed DM): it
  // fetches/reopens it, or flashes a notice if it's genuinely inaccessible — so the
  // jump is no longer gated on the channel already being loaded. messageId 0 is the
  // ring "open the channel" sentinel (real ids start at 1), with no message to jump
  // to. Both delivery paths can fire for one click, so a repeat of the same target
  // within a short window is collapsed.
  let lastRouted = { key: "", at: 0 };
  function routeToPermalink(hash) {
    const r = decidePermalinkRoute(hash, {
      channelLoaded: (id) => !!getState().channels[id],
      now: Date.now(),
      last: lastRouted,
    });
    if (r.skip) return;
    lastRouted = r.last;
    history.replaceState(null, "", "/"); // clean the hash back out (no hashchange)
    if (r.action === "jump") jumpToMessage(r.channelId, r.messageId);
    else if (r.action === "select") selectChannel(r.channelId);
  }

  // initPushRouting wires the notification-click routing (both delivery paths),
  // and — when notifications are already enabled — makes the SW live and refreshes
  // the push subscription. Called once at app start.
  function initPushRouting() {
    // The SW's client.navigate() drops the permalink hash on the (possibly
    // backgrounded/frozen) tab; react to it. hashchange covers a live fragment
    // navigation; the visibility check catches the case where the tab was frozen
    // when navigate() ran and only wakes up on foreground. Both are de-duped and
    // no-op on the cleaned-out "/" hash, so neither needs a service worker.
    window.addEventListener("hashchange", () => routeToPermalink(location.hash));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") routeToPermalink(location.hash);
    });
    if (!pushSupported()) return;
    // The other path: an in-app message the SW posts (desktop, listener alive).
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.type !== "notificationclick" || !data.url) return;
      const hash = data.url.indexOf("#") >= 0 ? data.url.slice(data.url.indexOf("#")) : "";
      routeToPermalink(hash);
      try { window.focus(); } catch (e) { /* best-effort */ }
    });
    // If notifications are already on, make sure the SW is live and the
    // subscription is fresh (it can be rotated by the browser at any time).
    if (enabled && currentPermission() === "granted") {
      ensureServiceWorker().then(() => enablePush());
    }
  }

  // setEnabled drives the profile opt-in toggle. Turning it on requests the OS
  // permission and registers for offline (Web Push) delivery; turning it off just
  // drops the in-app preference (the OS grant is sticky and only the browser can
  // revoke it). Best-effort on the push side: a failure there still leaves
  // foreground notifications working. Persists the result and re-renders the control.
  async function setEnabled(on) {
    if (on) {
      const perm = await requestNotificationPermission();
      enabled = perm === "granted";
      if (enabled) enablePush();
    } else {
      enabled = false;
      disablePush();
    }
    prefs.saveNotif(enabled);
    renderNotifControl();
  }

  // renderNotifControl reflects the desktop-notification opt-in into the profile
  // modal: the checkbox shows the *effective* state (preference AND OS permission),
  // and the hint explains anything blocking it.
  function renderNotifControl() {
    const cb = $("#notif-enable");
    const status = $("#notif-status");
    if (!cb) return;
    const supported = notificationsSupported();
    const perm = currentPermission();
    cb.checked = enabled && perm === "granted";
    cb.disabled = !supported || perm === "denied";
    if (!status) return;
    if (!supported) status.textContent = "Your browser doesn't support notifications.";
    else if (perm === "denied") status.textContent = "Blocked in your browser settings — allow notifications there to use this.";
    else if (enabled && perm === "granted") status.textContent = pushSupported()
      ? "On — you'll be notified of DMs and @-mentions, even when the app is closed."
      : "On — you'll be notified of DMs and @-mentions when this tab isn't focused.";
    else status.textContent = "Off — turn on to get alerts for DMs and @-mentions.";
  }

  return {
    renderNotificationTotal,
    firePing,
    initPushRouting,
    renderNotifControl,
    setEnabled,
    isEnabled: () => enabled,
    setBaseTitle: (name) => { baseTitle = name; },
  };
}
