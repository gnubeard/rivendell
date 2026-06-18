// e2e/video-grid.spec.js — pins the contract of the video-grid feature module
// (renderVideoGrid + the DM/group renderers, show/hide, fullscreen, the mobile
// chat↔video toggle). Written BEFORE the grid was carved out of app.js and run
// green against the un-extracted code, so a later failure means the extraction
// regressed — not that the spec was wrong.
//
// The dm-call/group-call specs already pin live tiles (videoWidth>0 +
// advancing currentTime); this one pins what those don't — the grid's own
// show/hide behavior:
//   1. camera on → #video-grid visible, body.video-active set, the corner
//      ⛶ fullscreen control present, and (DM) NOT the group-grid class
//   2. the mobile 💬/📺 header toggle (videoViewHidden) hides the grid while
//      the call keeps running, and toggling back restores it
//   3. both cameras off → the grid hides again and body.video-active clears
//
// Two real browser contexts against the live server (global-setup), same as
// dm-call. Driven through a DM so the 2-tile layout is exercised.
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
  // Login isn't realtime-ready until the WS connects (startRealtime runs last), so a
  // *.new broadcast right after login can outrun the socket and be missed. Wait for it
  // (see flaky-e2e #3).
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

// assertLiveVideo: at least `min` distinct video TRACKS playing — real dimensions and
// a currentTime seen to advance, accumulated per track id across a widened ~1.2s window
// (the simple "count tiles advancing in one shared window" is flaky under full-suite CPU
// stutter). CANONICAL copy + rationale: group-call.spec.js / docs/testing/flaky-e2e.md —
// keep the five call specs' copies in sync.
async function assertLiveVideo(page, min) {
  await expect.poll(async () => page.locator("#video-grid video").count(), {
    timeout: 45_000,
  }).toBeGreaterThanOrEqual(min);
  const liveTracks = new Set();
  await expect.poll(async () => {
    const advanced = await page.evaluate(async () => {
      const vids = [...document.querySelectorAll("#video-grid video")];
      const trackId = (v) => (v.srcObject && v.srcObject.getVideoTracks()[0] && v.srcObject.getVideoTracks()[0].id) || null;
      const before = vids.map((v) => ({ id: trackId(v), t: v.currentTime, w: v.videoWidth }));
      await new Promise((r) => setTimeout(r, 1200));
      const out = [];
      vids.forEach((v, i) => {
        if (before[i].id && before[i].w > 0 && v.currentTime > before[i].t) out.push(before[i].id);
      });
      return out;
    });
    advanced.forEach((id) => liveTracks.add(id));
    return liveTracks.size;
  }, { timeout: 45_000 }).toBeGreaterThanOrEqual(min);
}

async function inCall(page) {
  await expect(page.locator("#call-strip")).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  ctx1 = await browser.newContext();
  ctx2 = await browser.newContext();
  page1 = await ctx1.newPage();
  page2 = await ctx2.newPage();
  await uiLogin(page1, ADMIN);
  await uiLogin(page2, USER2);
  // Start audio-only — drive the camera explicitly.
  for (const p of [page1, page2]) {
    await p.evaluate(() => localStorage.removeItem("rivendell.cameraEnabled"));
  }
});

test.afterAll(async () => {
  await ctx1?.close();
  await ctx2?.close();
});

test("camera on reveals the grid with fullscreen control and video-active", async () => {
  await openDM(page1, USER2);
  await openDM(page2, ADMIN);

  await page1.click("#call-btn");        // ring
  await page2.click("#ring-accept-btn"); // accept → both join
  await inCall(page1);
  await inCall(page2);

  await page1.click("#call-camera-btn"); // caller camera on

  // The camera-off callee receives a live remote tile in a revealed grid.
  await assertLiveVideo(page2, 1);
  await expect(page2.locator("#video-grid")).toBeVisible();
  await expect(page2.locator("#video-grid .video-fullscreen-btn")).toHaveCount(1);
  // DM layout is the 2-tile path, not the N-tile group gallery.
  await expect(page2.locator("#video-grid")).not.toHaveClass(/group-grid/);
  // The grid takes over the conversation pane.
  await expect.poll(async () =>
    page2.evaluate(() => document.body.classList.contains("video-active"))
  ).toBe(true);
});

test("mobile chat/video toggle hides the grid without ending the call", async () => {
  // The 💬/📺 header button is CSS-hidden on a desktop viewport; click its real
  // handler directly to exercise the videoViewHidden seam regardless of layout.
  await page2.evaluate(() => document.querySelector("#header-camera-btn").click());

  // Grid collapses and the conversation pane returns — but the call is untouched.
  await expect(page2.locator("#video-grid")).toBeHidden();
  await expect.poll(async () =>
    page2.evaluate(() => document.body.classList.contains("video-active"))
  ).toBe(false);
  await expect(page2.locator("#call-strip")).toBeVisible();

  // Toggling back restores the video view.
  await page2.evaluate(() => document.querySelector("#header-camera-btn").click());
  await expect(page2.locator("#video-grid")).toBeVisible();
  await assertLiveVideo(page2, 1);
});

test("both cameras off hides the grid and clears video-active", async () => {
  await page1.click("#call-camera-btn"); // caller camera off → no video either side

  for (const page of [page1, page2]) {
    await expect(page.locator("#video-grid")).toBeHidden({ timeout: 15_000 });
    await expect.poll(async () =>
      page.evaluate(() => document.body.classList.contains("video-active"))
    ).toBe(false);
  }

  await page1.click("#call-leave-btn");
  await expect(page1.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
  await expect(page2.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
});
