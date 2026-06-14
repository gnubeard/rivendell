// e2e/secret-chat.spec.js — end-to-end secret (E2E-encrypted) DM handshake, two
// real browser contexts against a real server.
//
// The secret session is established over secret.* WS frames with real WebCrypto
// (X25519/Ed25519) in two live Chromiums — exactly what unit tests can't do. This
// spec pins the user-visible contract that secretui.js (the DOM/UX layer over
// secret.js) must keep across the app.js → secretui.js extraction:
//   1. clicking the 🔒 in a DM offers a session; the peer sees an accept banner
//   2. accepting drives BOTH ends to an active session (the 🔒 goes active)
//   3. the safety number computes on both ends and MATCHES (the handshake agreed
//      on the same shared secret) — the core security property
//   4. declining an offer clears the peer's banner without starting a session
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx1, ctx2, page1, page2;

async function uiLogin(page, username) {
  await page.goto("/");
  await page.fill("#login-username", username);
  await page.fill("#login-password", PASSWORD);
  await page.press("#login-password", "Enter");
  await expect(page.locator("#me-name")).toBeVisible();
}

// openDM creates/reopens the DM with otherUsername via the API (cookie rides
// along) then selects it in the sidebar (realtime channel.new adds the row).
async function openDM(page, otherUsername) {
  await page.evaluate(async (name) => {
    const users = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    const other = users.find((u) => u.username === name);
    if (!other) throw new Error("user not found: " + name);
    await fetch("/api/dms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ user_id: other.id }),
    });
  }, otherUsername);
  const row = page.locator("#dm-list li", { hasText: otherUsername }).first();
  await expect(row).toBeVisible();
  await row.click();
}

// safetyNumber opens the safety-number modal (🔒 on an active session) and
// returns the computed number once it resolves past the "Computing…" placeholder.
async function safetyNumber(page) {
  await page.click("#secret-btn");
  await expect(page.locator("#safety-modal")).toBeVisible();
  const num = page.locator("#safety-number");
  await expect(num).not.toHaveText(/Computing|unavailable/, { timeout: 15_000 });
  return (await num.textContent()).trim();
}

// offer clicks the 🔒 to start a session and waits for the peer's accept banner.
// Both clients publish their identity key at boot (idempotent), so an offer works
// without any prior handshake; the retry absorbs the brief window between a peer
// publishing its key and the user.update broadcast reaching the offerer's roster
// (the offer no-ops/throws until the key is in memory, leaving no session, so a
// re-click is safe).
async function offer(offerer, receiver) {
  await expect.poll(async () => {
    await offerer.click("#secret-btn");
    return receiver.locator("#secret-banner").isVisible();
  }, { timeout: 15_000, intervals: [300, 700, 1500, 3000] }).toBe(true);
}

test.beforeAll(async ({ browser }) => {
  ctx1 = await browser.newContext();
  ctx2 = await browser.newContext();
  page1 = await ctx1.newPage();
  page2 = await ctx2.newPage();
  // A failed secret setup surfaces as alert(); auto-dismiss so it can't block.
  page1.on("dialog", (d) => d.dismiss());
  page2.on("dialog", (d) => d.dismiss());
  await uiLogin(page1, ADMIN);
  await uiLogin(page2, USER2);
  await openDM(page1, USER2);
  await openDM(page2, ADMIN);
  // The 🔒 button is DM-only and gated on WebCrypto support; both ends need it.
  await expect(page1.locator("#secret-btn")).toBeVisible();
  await expect(page2.locator("#secret-btn")).toBeVisible();
});

test.afterAll(async () => {
  await ctx1?.close();
  await ctx2?.close();
});

test("declining an offer clears the peer's banner without a session", async () => {
  await offer(page1, page2); // ADMIN offers USER2
  await expect(page2.locator("#secret-banner-text")).toContainText("secret chat");

  await page2.click("#secret-decline-btn");
  await expect(page2.locator("#secret-banner")).toBeHidden();
  // Neither side ended up in an active session.
  await expect(page1.locator("#secret-btn")).not.toHaveClass(/secret-btn-active/);
  await expect(page2.locator("#secret-btn")).not.toHaveClass(/secret-btn-active/);
});

test("offer + accept brings both ends to an active session with a matching safety number", async () => {
  await offer(page1, page2); // ADMIN offers USER2
  await page2.click("#secret-accept-btn"); // USER2 accepts → handshake

  // Both ends converge on an active session (🔒 goes active).
  await expect(page1.locator("#secret-btn")).toHaveClass(/secret-btn-active/, { timeout: 15_000 });
  await expect(page2.locator("#secret-btn")).toHaveClass(/secret-btn-active/, { timeout: 15_000 });

  // The security property: both computed the SAME safety number from the agreed
  // shared secret. A mismatch would mean the handshake didn't actually agree.
  const n1 = await safetyNumber(page1);
  const n2 = await safetyNumber(page2);
  expect(n1).toMatch(/\d/);
  expect(n1).toBe(n2);
});
