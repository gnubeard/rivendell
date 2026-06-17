// e2e/optimistic-send.spec.js — optimistic local echo for sending a message.
//
// On Enter, app.js paints the message at the live tail immediately as a dimmed
// `.msg.pending` row (showOptimisticSend), BEFORE the server round-trips. Its own
// message.new echo then reconciles the dimmed row into the real one in place
// (reconcileOptimistic) — exactly one copy, no jump. A failed POST rolls the
// optimistic row back and restores the composer text for a retry. This spec pins:
//   1. a sent message ends up as a single, non-pending row (reconciled, not doubled)
//   2. a failed send shows the pending row, then rolls it back + restores the composer
import { test, expect } from "@playwright/test";
import { ADMIN, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

const TS = Date.now();
const SENDS = /\/api\/channels\/\d+\/messages$/;
let ctx, page, channelId;

async function uiLogin(p, username) {
  await p.goto("/");
  await p.fill("#login-username", username);
  await p.fill("#login-password", PASSWORD);
  await p.press("#login-password", "Enter");
  await expect(p.locator("#me-name")).toBeVisible();
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

async function openChannel(p, channelId) {
  await p.click(`#channel-list li[data-ch-id="${channelId}"]`);
  await expect(p.locator(`#channel-list li[data-ch-id="${channelId}"]`)).toHaveClass(/active/);
}

// typeAndSend focuses the contenteditable composer, types, and presses Enter —
// matching composer-paste.spec.js's keyboard-driven convention.
async function typeAndSend(p, text) {
  await p.locator("#composer-input").click();
  await p.keyboard.type(text);
  await p.keyboard.press("Enter");
}

const msg = (p, text) => p.locator("#message-list .msg", { hasText: text });

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);
  channelId = await makeChannel(page, `optimistic-${TS}`);
  await openChannel(page, channelId);
});

test.afterAll(async () => { await ctx?.close(); });

test("a sent message reconciles to a single, non-pending row", async () => {
  const txt = `optimistic happy ${TS}`;
  await typeAndSend(page, txt);

  // Shows up (optimistically and/or via the echo), and the echo reconciles it: the
  // pending class clears and there is exactly ONE copy (no optimistic + echo dupe).
  await expect(msg(page, txt)).toHaveCount(1);
  await expect(page.locator("#message-list .msg.pending", { hasText: txt })).toHaveCount(0);
  await expect(msg(page, txt)).toHaveCount(1);
});

test("a failed send shows the pending row, then rolls it back and restores the composer", async () => {
  const txt = `optimistic fail ${TS}`;

  // Hold the POST briefly, then abort it: the server never processes the send (no
  // WS echo), so the optimistic row stays pending and observable until the abort
  // rejects api.sendMessage and the catch rolls it back.
  await page.route(SENDS, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise((r) => setTimeout(r, 700));
    return route.abort();
  });
  page.once("dialog", (d) => d.accept()); // the failure path alert()s

  await typeAndSend(page, txt);

  // Optimistic row is visible and dimmed while the (doomed) request is in flight.
  await expect(page.locator("#message-list .msg.pending", { hasText: txt })).toBeVisible();

  // After the abort: the row is rolled back and the composer text is restored.
  await expect(msg(page, txt)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.querySelector("#composer-input").value)).toBe(txt);

  await page.unroute(SENDS);
});
