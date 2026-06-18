// e2e/notifications.spec.js — foreground desktop-notification UX against a real
// server.
//
// Written BEFORE the planned app.js → notifyui.js extraction (the feature-module /
// e2e-net method): it must pass green against the un-extracted code first, so a
// later red means the extraction regressed — not that the spec was wrong. The pure
// decision (shouldNotify) is already unit-tested in notify.test.js; what a unit test
// can't reach is the DOM/realtime glue notifyui.js will own, so this pins it:
//   1. an @-mention I'm not looking at raises the global count — the #notif-total
//      sidebar badge AND the "(N)" page-title prefix (renderNotificationTotal)
//   2. on a mobile viewport with the tab focused, a ping I'm not looking at shows
//      an in-app #ping-toasts toast labelled with the sender; tapping it navigates
//      to that conversation (showPingToast + firePing's focused-tab branch)
//   3. the profile opt-in control reflects effective state: with OS permission
//      granted, toggling #notif-enable on flips the hint Off → On (renderNotifControl
//      + the opt-in flow that becomes notifyui's setEnabled)
//
// firePing's *OS-notification* branch (unfocused + opted-in) is the part Playwright
// can't observe reliably, and its decision is already shouldNotify's unit test; here
// we drive the two DOM-observable branches (badge/title, focused-tab toast) and the
// control. Sending is done node-side (a logged-in cookie + fetch) so it never
// perturbs which browser page holds focus — the toast branch is focus-sensitive.
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD, BASE } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page;     // ADMIN, desktop viewport — badge/title + profile control
let ctxM, pageM;   // ADMIN, mobile viewport — the focused-tab ping toast
const TS = Date.now();
let user2Cookie, adminId, channelId, dmId;

async function uiLogin(p, username) {
  await p.goto("/");
  await p.fill("#login-username", username);
  await p.fill("#login-password", PASSWORD);
  await p.press("#login-password", "Enter");
  await expect(p.locator("#me-name")).toBeVisible();
  // Login isn't realtime-ready until the WS connects (startRealtime runs last), so a
  // *.new broadcast right after login can outrun the socket and be missed. Wait for it
  // (see flaky-e2e #3).
  await expect(p.locator("#conn-status")).toHaveClass(/\bonline\b/, { timeout: 15_000 });
}

// login returns the session cookie pair so the spec can act as a user node-side,
// without a browser page (and without stealing focus from the page under test).
async function login(username) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const m = (r.headers.get("set-cookie") || "").match(/rivendell_session=[^;]+/);
  if (!m) throw new Error(`login ${username} failed: ${r.status}`);
  return m[0];
}

async function apiAs(cookie, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${path} failed: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  // Headless Chromium reports Notification.permission as "denied" regardless of
  // grantPermissions, so the opt-in toggle can't be driven through the real API.
  // The permission primitive is the browser's, not ours — fake it as granted so the
  // test deterministically exercises *our* glue (the toggle → renderNotifControl
  // reflection). The pure notify decision is unit-tested separately in notify.test.js.
  await ctx.addInitScript(() => {
    class FakeNotification {
      close() {}
      static permission = "granted";
      static requestPermission() { return Promise.resolve("granted"); }
    }
    window.Notification = FakeNotification;
  });
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);

  ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
  pageM = await ctxM.newPage();
  await uiLogin(pageM, ADMIN);

  user2Cookie = await login(USER2);
  const adminCookie = await login(ADMIN);
  const users = await apiAs(adminCookie, "GET", "/api/users");
  adminId = users.find((u) => u.username === ADMIN).id;

  // Created AFTER both ADMIN pages are connected, so each receives the channel.new
  // + message.new broadcasts live (the realtime path this spec exercises).
  const ch = await apiAs(adminCookie, "POST", "/api/channels", { name: `notif${TS}` });
  channelId = ch.id;
});

test.afterAll(async () => {
  await ctx?.close();
  await ctxM?.close();
});

test("an @-mention I'm not looking at raises the badge and title count", async () => {
  // Desktop ADMIN isn't viewing the channel (no selection) → the mention counts.
  // Bring it to front so the mobile page is backgrounded and doesn't also alert.
  await page.bringToFront();
  await apiAs(user2Cookie, "POST", `/api/channels/${channelId}/messages`, {
    content: `@${ADMIN} heads-up ${TS}`,
    reply_to_id: null,
  });

  const badge = page.locator("#notif-total");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("1");
  await expect.poll(() => page.title()).toMatch(/^\(1\) /);
});

test("a ping on a focused mobile tab shows a toast that navigates on tap", async () => {
  // The toast is mobile-only and fires only when the tab is focused — bring the
  // mobile page to front so document.hasFocus() is true there.
  await pageM.bringToFront();

  // USER2 opens a DM to ADMIN and sends into it (any DM pings). channel.new +
  // message.new reach ADMIN's mobile page live.
  const dm = await apiAs(user2Cookie, "POST", "/api/dms", { user_id: adminId });
  dmId = dm.id;
  await apiAs(user2Cookie, "POST", `/api/channels/${dmId}/messages`, {
    content: `secret hello ${TS}`,
    reply_to_id: null,
  });

  // Target this DM's toast by its unique body — headless reports both ADMIN pages
  // focused, so the prior test's mention also toasts here, and they coexist for ~4s.
  const toast = pageM.locator("#ping-toasts .ping-toast", { hasText: `secret hello ${TS}` });
  await expect(toast).toBeVisible({ timeout: 5000 });
  // A DM ping's label is just the sender's name (no "in #channel") — toHaveText is exact.
  await expect(toast.locator(".ping-toast-who")).toHaveText(USER2);

  // Tapping navigates to the DM — its message is now open in the pane.
  await toast.click();
  await expect(pageM.locator("#message-list")).toContainText(`secret hello ${TS}`);
});

test("the profile opt-in control reflects effective state and toggles On", async () => {
  await page.bringToFront();
  await page.click("#me-name");
  await expect(page.locator("#profile-modal")).toBeVisible();

  const cb = page.locator("#notif-enable");
  const status = page.locator("#notif-status");
  // Off by default (opted out), even though the OS permission is granted.
  await expect(cb).not.toBeChecked();
  await expect(status).toContainText("Off");

  await cb.check();
  // Permission is already granted, so the opt-in flow lands enabled and the hint
  // flips to the "On" copy.
  await expect(cb).toBeChecked();
  await expect(status).toContainText("On");
});
