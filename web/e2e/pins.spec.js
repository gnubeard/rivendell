// e2e/pins.spec.js — end-to-end pinned-messages modal against a real server.
//
// Written BEFORE the planned app.js → pins.js extraction (the feature-module
// method): it must pass green against the un-extracted code first, so a later red
// means the extraction regressed. The pins modal is fetch-then-render DOM with a
// last-writer-wins refresh guard (no extractable pure core), so e2e is its only
// net. It pins the user-visible contract:
//   1. pinning a message and opening the modal lists it
//   2. the jump link closes the modal and navigates to the message
//   3. unpinning from inside the modal empties the list
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

function makeChannel(p, name) {
  return p.evaluate(async (name) => {
    const ch = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name, topic: "", is_private: false }),
    }).then((r) => r.json());
    return ch.id;
  }, name);
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

// pin hovers the message row (the action bar is hover-revealed) and clicks 📌,
// then waits for the pin-mark — proof the server applied it and the broadcast
// re-rendered, so a subsequent server-side pins fetch will see it.
async function pin(p, msgId) {
  const row = p.locator(`#message-list [data-msg-id="${msgId}"]`).first();
  await row.hover();
  await row.getByTitle("Pin").click();
  await expect(row.locator(".pin-mark")).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);
});

test.afterAll(async () => {
  await ctx?.close();
});

test("a pinned message shows in the pins modal and its jump link navigates", async () => {
  const ch = await makeChannel(page, `pinjump${TS}`);
  const msgId = await postMessage(page, ch, `pin me ${TS}`);
  await openChannel(page, ch);
  await pin(page, msgId);

  await page.click("#pins-btn");
  await expect(page.locator("#pins-modal")).toBeVisible();
  const row = page.locator("#pins-list .pin-row", { hasText: `pin me ${TS}` });
  await expect(row).toBeVisible();

  // The time link jumps to the message and dismisses the modal.
  await row.locator("a.msg-time").click();
  await expect(page.locator("#pins-modal")).toBeHidden();
  await expect(page.locator(`#message-list :text("pin me ${TS}")`).first()).toBeVisible();
});

test("unpinning from the modal empties the list", async () => {
  const ch = await makeChannel(page, `pinunpin${TS}`);
  const msgId = await postMessage(page, ch, `unpin me ${TS}`);
  await openChannel(page, ch);
  await pin(page, msgId);

  await page.click("#pins-btn");
  await expect(page.locator("#pins-list .pin-row", { hasText: `unpin me ${TS}` })).toBeVisible();

  await page.click("#pins-list .pin-row button.link");
  await expect(page.locator("#pins-list")).toContainText("No pinned messages yet.");
});
