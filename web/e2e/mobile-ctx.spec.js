// e2e/mobile-ctx.spec.js — the mobile long-press message action sheet, on a
// touch-enabled context.
//
// Written BEFORE the planned app.js → mobilectx.js extraction (the feature-module
// method). The sheet is built from DOM and opened by a 450ms long-press, so it
// needs a real touch context — every other spec runs mouse-only. We synthesize the
// press by dispatching a bubbling touchstart (the open fires off the press timer;
// touchend only suppresses the follow-on click). Contracts pinned:
//   1. long-pressing a message opens the sheet with the core actions
//   2. an action (Forward) closes the sheet and runs (opens the forward modal)
//   3. a backdrop tap closes the sheet
//   4. the reactions sub-panel lists who reacted
//   5. a NON-MOD member gets a fully-rendered sheet — this guards a bug the
//      extraction fixes: showMobileCtxActions read an undeclared `activeCh`, which
//      only survived for admins/mods via `isMod || …` short-circuiting; a plain
//      member threw a ReferenceError at the Pin row. (This case fails against the
//      pre-extraction code.)
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page, ctxM, pageM;
const TS = Date.now();
let channelId, msgId;

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

// longPress synthesizes the touch long-press that opens the sheet. The app opens
// it from the 450ms press timer, so a bubbling touchstart on the row is enough;
// toBeVisible polls past the timer.
async function longPress(p, msgId) {
  await p.evaluate((id) => {
    const row = document.querySelector(`[data-msg-id="${id}"]`);
    const r = row.getBoundingClientRect();
    const t = new Touch({ identifier: 1, target: row, clientX: r.left + 5, clientY: r.top + 5 });
    row.dispatchEvent(new TouchEvent("touchstart", {
      bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t],
    }));
  }, msgId);
  await expect(p.locator("#mobile-ctx")).toBeVisible({ timeout: 3000 });
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ hasTouch: true });
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);
  channelId = await makeChannel(page, `lpmenu${TS}`);
  msgId = await postMessage(page, channelId, `longpress ${TS}`);
  await openChannel(page, channelId);

  ctxM = await browser.newContext({ hasTouch: true });
  pageM = await ctxM.newPage();
  await uiLogin(pageM, USER2);
});

test.afterAll(async () => {
  await ctx?.close();
  await ctxM?.close();
});

test("long-pressing a message opens the action sheet", async () => {
  await longPress(page, msgId);
  const inner = page.locator("#mobile-ctx-inner");
  await expect(inner.getByRole("button", { name: /React/ })).toBeVisible();
  await expect(inner.getByRole("button", { name: /Reply/ })).toBeVisible();
  await expect(inner.getByRole("button", { name: /Forward/ })).toBeVisible();
  await expect(inner.getByRole("button", { name: /Copy/ })).toBeVisible();
  // ADMIN on their own message: Edit + Delete present.
  await expect(inner.getByRole("button", { name: /Edit/ })).toBeVisible();
  await expect(inner.getByRole("button", { name: /Delete/ })).toBeVisible();

  // Close for the next test (backdrop tap).
  await page.locator("#mobile-ctx").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#mobile-ctx")).toBeHidden();
});

test("an action in the sheet runs and closes it (Forward → forward modal)", async () => {
  await longPress(page, msgId);
  await page.locator("#mobile-ctx-inner").getByRole("button", { name: /Forward/ }).click();
  await expect(page.locator("#mobile-ctx")).toBeHidden();
  await expect(page.locator("#forward-modal")).toBeVisible();
  await page.click("#forward-close");
});

test("a backdrop tap closes the sheet", async () => {
  await longPress(page, msgId);
  await page.locator("#mobile-ctx").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#mobile-ctx")).toBeHidden();
});

test("the reactions sub-panel lists who reacted", async () => {
  // Add a reaction, wait for it to land on the rendered message, then open the
  // sheet and drill into Reactions.
  await page.evaluate((id) => fetch(`/api/messages/${id}/reactions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ emoji: "👍" }),
  }), msgId);
  await expect(page.locator(`#message-list [data-msg-id="${msgId}"] .reaction`)).toBeVisible();

  await longPress(page, msgId);
  await page.locator("#mobile-ctx-inner").getByRole("button", { name: /Reactions \(/ }).click();
  const panel = page.locator(".mobile-ctx-reactions");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".mobile-ctx-reaction-row")).toContainText(ADMIN);

  await page.locator("#mobile-ctx").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#mobile-ctx")).toBeHidden();
});

test("a non-mod member gets a fully-rendered sheet (guards the activeCh fix)", async () => {
  // USER2 is a plain member. Pre-fix, showMobileCtxActions threw a ReferenceError
  // at the Pin row (undeclared activeCh, no isMod short-circuit), so the sheet
  // rendered only partially. Mark read sits AFTER the Pin row, so its presence
  // proves the function ran to completion.
  await openChannel(pageM, channelId);
  await longPress(pageM, msgId);
  const inner = pageM.locator("#mobile-ctx-inner");
  await expect(inner.getByRole("button", { name: /Reply/ })).toBeVisible();
  await expect(inner.getByRole("button", { name: /Mark (read|unread)/ })).toBeVisible();
  // A member on someone else's message: no Edit/Delete.
  await expect(inner.getByRole("button", { name: /Delete/ })).toHaveCount(0);
});
