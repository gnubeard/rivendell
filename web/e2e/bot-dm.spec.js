// e2e/bot-dm.spec.js — the DM header's call (📞) and secret-chat (🔒) buttons
// are meaningless for peers that can't take a call or do an E2E key exchange, so
// renderDMHeader hides BOTH for a self-DM and for a bot peer. This pins that
// gating in a real browser: a bot DM and a self-DM hide both buttons, while a
// regular-user DM still shows them (the control that proves we didn't blanket-
// hide). UI-only gating, matching how self-DM has always been handled. The bot
// user (BOT) is provisioned + bot-flagged in global-setup.
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, BOT, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page;

async function uiLogin(p, username) {
  await p.goto("/");
  await p.fill("#login-username", username);
  await p.fill("#login-password", PASSWORD);
  await p.press("#login-password", "Enter");
  await expect(p.locator("#me-name")).toBeVisible();
}

// userId resolves a username to its id via the public API (cookie rides along).
async function userId(p, username) {
  return p.evaluate(async (name) => {
    const users = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    const u = users.find((x) => x.username === name);
    if (!u) throw new Error("user not found: " + name);
    return u.id;
  }, username);
}

// myId returns the logged-in user's own id (for opening a self-DM).
async function myId(p) {
  return p.evaluate(() => fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()).then((u) => u.id));
}

// openDM opens (or reopens) the DM with `otherId` via the public API, selects it
// in the sidebar, and waits for renderDMHeader to have run by pinning the title.
async function openDM(p, otherId, title, rowText) {
  await p.evaluate(async (id) => {
    await fetch("/api/dms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ user_id: id }),
    });
  }, otherId);
  const row = p.locator("#dm-list li", { hasText: rowText }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(p.locator("#channel-title")).toHaveText(title);
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);
});

test.afterAll(async () => {
  await ctx?.close();
});

test("bot DM hides both the call and secret-chat buttons", async () => {
  await openDM(page, await userId(page, BOT), "@ " + BOT, BOT);
  await expect(page.locator("#call-btn")).toBeHidden();
  await expect(page.locator("#secret-btn")).toBeHidden();
});

test("self-DM hides both the call and secret-chat buttons", async () => {
  await openDM(page, await myId(page), "@ " + ADMIN + " (you)", ADMIN);
  await expect(page.locator("#call-btn")).toBeHidden();
  await expect(page.locator("#secret-btn")).toBeHidden();
});

test("a regular-user DM shows both buttons (control)", async () => {
  await openDM(page, await userId(page, USER2), "@ " + USER2, USER2);
  await expect(page.locator("#call-btn")).toBeVisible();
  await expect(page.locator("#secret-btn")).toBeVisible();
});
