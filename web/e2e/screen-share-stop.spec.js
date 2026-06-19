// e2e/screen-share-stop.spec.js — repro for the DM bug where STOPPING a screen
// share (not switching to the camera) ends the call for the OTHER participant
// while the sharer stays in the call.
//
// The existing screen-share spec only switches share→camera (setCameraEnabled,
// a replaceTrack swap). This exercises the untested path: clicking the share
// button again to fully STOP (setScreenShareEnabled(false) — replaceTrack(null)
// on the video sender + stopScreenAudio's removeTrack renegotiation, leaving no
// video source). The assertion is simply: both call strips stay up.
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
  await expect(page.locator("#conn-status")).toHaveClass(/\bonline\b/, { timeout: 15_000 });
}

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

async function inCall(page) {
  await expect(page.locator("#call-strip")).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  ctx1 = await browser.newContext();
  ctx2 = await browser.newContext();
  await ctx1.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = (c) =>
      navigator.mediaDevices.getUserMedia({ video: true, audio: !!(c && c.audio) });
  });
  page1 = await ctx1.newPage();
  page2 = await ctx2.newPage();
  await uiLogin(page1, ADMIN);
  await uiLogin(page2, USER2);
  for (const p of [page1, page2]) {
    await p.evaluate(() => localStorage.removeItem("rivendell.cameraEnabled"));
  }
});

test.afterAll(async () => {
  await ctx1?.close();
  await ctx2?.close();
});

test("stopping a screen share keeps the DM call up for BOTH parties", async () => {
  await openDM(page1, USER2);
  await openDM(page2, ADMIN);

  await page1.click("#call-btn"); // ring
  await page2.click("#ring-accept-btn"); // accept → both join voice-only
  await inCall(page1);
  await inCall(page2);

  // Start sharing (video + system audio), confirm it took.
  await page1.click("#header-share-btn");
  await expect(page1.locator("#header-share-btn")).toHaveClass(/active/, { timeout: 20_000 });
  await expect.poll(
    () => page2.evaluate(() => {
      let n = 0;
      for (const a of document.querySelectorAll("audio")) if (a.srcObject) n += a.srcObject.getAudioTracks().length;
      return n;
    }),
    { timeout: 20_000 },
  ).toBe(2); // mic + shared audio → the share (with its audio m-line) is fully established

  // Now STOP the share (the bug path): click the lit share button again.
  await page1.click("#header-share-btn");
  await expect(page1.locator("#header-share-btn")).not.toHaveClass(/active/, { timeout: 20_000 });

  // The renegotiation (removeTrack of screen audio) must NOT end the call. Give it
  // well past a couple of monitor/heartbeat ticks, then assert both strips remain.
  await page1.waitForTimeout(8000);
  await expect(page1.locator("#call-strip")).toBeVisible();
  await expect(page2.locator("#call-strip")).toBeVisible();
});
