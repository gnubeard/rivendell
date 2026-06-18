// e2e/admin.spec.js — end-to-end admin panel against a real server.
//
// The admin panel is a DOM-heavy feature (a settings panel that fetches stats,
// users, invitations, bot tokens, deleted channels and emojis, renders tables,
// and wires their create/revoke forms). It has no extractable pure core, so the
// net is this spec, written *before* the app.js → admin.js extraction and proven
// green against the un-extracted code. It pins the user-visible contract the
// admin module must keep:
//   1. the gear opens the panel and instance stats render
//   2. the logged-in admin appears in the user table with a role control
//   3. creating an invitation shows a one-time link and lists it as pending
//   4. creating a bot token shows the token once and lists it
//   5. the "Manage custom emojis" button opens the emoji manager
import { test, expect } from "@playwright/test";
import { ADMIN, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page;
const TS = Date.now();

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

// openPanel clicks the gear (admin-only, hidden for non-admins) and waits for the
// panel to show. openAdmin re-wires its forms on every call, so re-opening between
// tests is safe.
async function openPanel(p) {
  await expect(p.locator("#admin-btn")).toBeVisible();
  await p.click("#admin-btn");
  await expect(p.locator("#admin-panel")).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);
});

test.afterAll(async () => {
  await ctx?.close();
});

test("the gear opens the panel and renders instance stats", async () => {
  await openPanel(page);
  // Stats render as labelled tiles; "users" is always ≥ 1 (we're logged in).
  const stats = page.locator("#admin-stats .admin-stat");
  await expect(stats.first()).toBeVisible();
  const usersTile = stats.filter({ hasText: "users" }).first();
  await expect(usersTile.locator(".admin-stat-value")).toHaveText(/\d+/);
});

test("the logged-in admin appears in the user table with a role control", async () => {
  const row = page.locator(`#admin-user-rows tr`, { hasText: ADMIN });
  await expect(row).toBeVisible();
  // role <select> defaults to the user's current role.
  await expect(row.locator("select")).toHaveValue("admin");
});

test("creating an invitation shows a one-time link and lists it", async () => {
  await page.click("#admin-invite-create");
  // The just-created link is copyable in the out box…
  const link = page.locator("#admin-invite-out input.linkbox");
  await expect(link).toBeVisible();
  await expect(link).toHaveValue(/https?:\/\/.+/);
  // …and a pending row shows in the list.
  await expect(page.locator("#admin-invite-list table tbody tr", { hasText: "pending" }).first()).toBeVisible();
});

test("creating a bot token shows the token once and lists it", async () => {
  const name = `e2e-token-${TS}`;
  await page.fill("#admin-token-name", name);
  // The user picker is populated from the roster; bind the token to the first
  // entry (the admin is the only user when this spec runs against a fresh DB).
  await page.selectOption("#admin-token-user", { index: 0 });
  await page.click("#admin-token-form button[type=submit]");

  const token = page.locator("#admin-token-out input.linkbox");
  await expect(token).toBeVisible();
  await expect(token).toHaveValue(/.+/);
  await expect(page.locator("#admin-token-list table tbody tr", { hasText: name })).toBeVisible();
});

test("the Manage custom emojis button opens the emoji manager", async () => {
  await page.click("#admin-emoji-manage");
  await expect(page.locator("#emoji-manager-modal")).toBeVisible();
  // Fresh instance: no custom emojis yet.
  await expect(page.locator("#emoji-manager-list")).toContainText("No custom emojis yet.");
});
