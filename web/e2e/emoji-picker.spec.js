// e2e/emoji-picker.spec.js — the shared emoji popup, end to end.
//
// The picker is interactive DOM with real layout math (it floats above the
// control that opened it, flipping below when cramped — getBoundingClientRect,
// which has no meaning under node/jsdom). It serves two targets through one
// popup: inserting a token into a text field (composer or inline-edit box) and
// reacting to a message. This spec pins that contract across the app.js →
// emoji.js extraction:
//   1. the composer button opens the palette and a pick inserts into the composer
//      (and closes — composer inserts always close, even on Shift-click, because
//      insertIntoInput hides the popup; Shift-to-keep-open applies to reactions)
//   2. moderators+ get the "Manage emojis" footer
//   3. the message reaction button opens the popup in react mode, where Shift-click
//      keeps it open for multiple picks and a plain pick adds a reaction + closes
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page, dmId;
const FIRST_UNICODE = "👍"; // first entry in COMMON_EMOJI

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.goto("/");
  await page.fill("#login-username", ADMIN);
  await page.fill("#login-password", PASSWORD);
  await page.press("#login-password", "Enter");
  await expect(page.locator("#me-name")).toBeVisible();
  // A DM gives the composer an active channel without channel-admin UI; capture
  // its id so we can seed a message to react to.
  dmId = await page.evaluate(async (name) => {
    const users = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    const other = users.find((u) => u.username === name);
    const ch = await fetch("/api/dms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ user_id: other.id }),
    }).then((r) => r.json());
    return ch.id;
  }, USER2);
  const row = page.locator("#dm-list li", { hasText: USER2 }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator("#composer-input")).toBeVisible();
});

test.afterAll(async () => {
  await ctx?.close();
});

async function clearComposer() {
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });
}

test("composer button opens the palette and a pick inserts into the composer", async () => {
  await clearComposer();
  await page.click("#emoji-btn");
  await expect(page.locator("#emoji-wrap")).toBeVisible();
  await expect(page.locator("#emoji-picker .emoji-choice").first()).toBeVisible();
  await page.locator("#emoji-picker .emoji-choice").first().click();
  await expect(page.locator("#emoji-wrap")).toBeHidden();
  expect(await page.evaluate(() => document.querySelector("#composer-input").value)).toContain(FIRST_UNICODE);
});

test("moderators+ get the Manage emojis footer", async () => {
  await page.click("#emoji-btn");
  await expect(page.locator("#emoji-wrap")).toBeVisible();
  await expect(page.locator(".emoji-manage-btn")).toBeVisible(); // ADMIN is mod+
  await page.keyboard.press("Escape"); // close without managing
});

test("react mode: Shift-click keeps the popup open; a plain pick adds a pill and closes", async () => {
  // Seed a fresh, uniquely-worded message (the e2e database is reused across runs;
  // a unique needle guarantees a row with no pre-existing reactions to toggle off).
  const needle = `react-${Date.now()}`;
  await page.evaluate(async ({ id, needle }) => {
    await fetch(`/api/channels/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ content: needle, reply_to_id: null }),
    });
  }, { id: dmId, needle });

  const row = page.locator("#message-list [data-msg-id]", { hasText: needle }).first();
  await expect(row).toBeVisible();
  await row.hover(); // reveal the action row so the button has real layout
  // The hover-revealed actions overlay the .msg-head, which intercepts a real
  // pointer click; dispatch the click straight to the button so its handler runs
  // (e.currentTarget stays the button, which the picker floats next to).
  await row.locator('button.msg-act[title="Add reaction"]').dispatchEvent("click");
  // Popup is now floated in react mode. Shift-click keeps it open...
  await expect(page.locator("#emoji-wrap")).toBeVisible();
  await page.locator("#emoji-picker .emoji-choice").first().click({ modifiers: ["Shift"] });
  await expect(page.locator("#emoji-wrap")).toBeVisible();
  await expect(row.locator(".reaction").first()).toBeVisible();
  // ...and a plain pick (a different emoji) adds another and closes the popup.
  await page.locator("#emoji-picker .emoji-choice").nth(1).click();
  await expect(page.locator("#emoji-wrap")).toBeHidden();
  await expect(row.locator(".reaction")).toHaveCount(2);
});
