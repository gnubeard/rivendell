// e2e/modals.spec.js — the modal cluster (new-channel, edit-profile, invite, and
// the read-only user card) against a real server.
//
// Written BEFORE the planned app.js → modals.js extraction (the feature-module
// method): it must pass green against the un-extracted code first, so a later red
// means the extraction regressed. These are DOM-building modals with no pure core,
// so e2e is their net. Contracts pinned:
//   1. the new-channel modal creates a channel that shows in the sidebar
//   2. the profile modal opens populated with the current user's details
//   3. the invite modal adds a non-member to a private channel ("add" → "in channel")
//   4. clicking a message author opens their user card; "Message" opens a DM
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page, ctx2, page2;
let user2Name; // USER2's display name (resolved from the roster, not assumed)
const TS = Date.now();

async function uiLogin(p, username) {
  await p.goto("/");
  await p.fill("#login-username", username);
  await p.fill("#login-password", PASSWORD);
  await p.press("#login-password", "Enter");
  await expect(p.locator("#me-name")).toBeVisible();
}

function makeChannel(p, name, isPrivate = false) {
  return p.evaluate(async ({ name, isPrivate }) => {
    const ch = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name, topic: "", is_private: isPrivate }),
    }).then((r) => r.json());
    return ch.id;
  }, { name, isPrivate });
}

function postMessage(p, channelId, content) {
  return p.evaluate(async ({ channelId, content }) => {
    const msg = await fetch(`/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ content, reply_to_id: null }),
    }).then((r) => r.json());
    return msg.id;
  }, { channelId, content });
}

async function openChannel(p, channelId) {
  await p.click(`#channel-list li[data-ch-id="${channelId}"]`);
  await expect(p.locator(`#channel-list li[data-ch-id="${channelId}"]`)).toHaveClass(/active/);
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);

  ctx2 = await browser.newContext();
  page2 = await ctx2.newPage();
  await uiLogin(page2, USER2);

  user2Name = await page.evaluate(async (name) => {
    const us = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    return (us.find((u) => u.username === name) || {}).display_name;
  }, USER2);
});

test.afterAll(async () => {
  await ctx?.close();
  await ctx2?.close();
});

test("the new-channel modal creates a channel shown in the sidebar", async () => {
  const name = `mcnew${TS}`;
  await page.click("#new-channel-btn");
  await expect(page.locator("#channel-modal")).toBeVisible();

  await page.fill("#channel-new-name", name);
  await page.press("#channel-new-name", "Enter"); // submits #channel-create-form

  await expect(page.locator("#channel-modal")).toBeHidden();
  await expect(page.locator("#channel-list li", { hasText: name })).toBeVisible();
});

test("the profile modal opens populated with the current user's details", async () => {
  await page.click("#me-name");
  await expect(page.locator("#profile-modal")).toBeVisible();
  // Populated from state.me — display name is non-empty and the theme select has a value.
  await expect(page.locator("#profile-display")).not.toHaveValue("");
  await expect(page.locator("#profile-theme")).not.toHaveValue("");

  await page.keyboard.press("Escape");
  await expect(page.locator("#profile-modal")).toBeHidden();
});

test("the invite modal adds a non-member to a private channel", async () => {
  const priv = await makeChannel(page, `mcinv${TS}`, true);
  await openChannel(page, priv);

  await page.click("#invite-btn");
  await expect(page.locator("#invite-modal")).toBeVisible();

  const row = page.locator("#invite-list .invite-row", { hasText: user2Name });
  await expect(row).toBeVisible();
  await row.locator("button.link").click(); // "add"
  await expect(row.locator(".invite-in")).toHaveText("in channel");

  await page.click("#invite-close");
  await expect(page.locator("#invite-modal")).toBeHidden();
});

test("clicking a message author opens their user card; Message opens a DM", async () => {
  const pub = await makeChannel(page, `mccard${TS}`);
  // USER2 posts so ADMIN has someone else's authored message to click.
  const msgId = await postMessage(page2, pub, `hi from user2 ${TS}`);
  await openChannel(page, pub);

  const msg = page.locator(`#message-list [data-msg-id="${msgId}"]`).first();
  await msg.locator(".msg-author.clickable").click();

  await expect(page.locator("#user-modal")).toBeVisible();
  await expect(page.locator("#user-card")).toContainText(user2Name);
  await expect(page.locator("#user-card")).toContainText("@" + USER2);

  // "Message" closes the card and opens the DM with USER2.
  await page.locator("#user-card button.primary").click();
  await expect(page.locator("#user-modal")).toBeHidden();
  await expect(page.locator("#dm-list")).toContainText(user2Name);
});
