// e2e/group-call.spec.js — end-to-end group voice/video (1.4.0), THREE real
// browser contexts against a real server. This is the mesh case the 1:1 DM spec
// can't reach: three RTCPeerConnections per node, a shared (non-DM) voice
// channel, and the N-tile gallery layout.
//
// What it pins:
//   1. three users join the same voice channel and all see the 3-person roster
//   2. two of them turn cameras on → the third (camera off) receives BOTH live
//      remote tiles in the group gallery (#video-grid.group-grid), and each
//      camera-on user sees its own preview + the other's tile (≥2 live each)
//
// Frame-advance assertions (videoWidth>0 AND currentTime advancing) are reused
// from the DM spec's approach so a decoded-one-frame-then-paused tile fails.
//
// NOTE: like all of web/e2e, this needs installed browser binaries and is NOT
// part of `make test` — run it with `make test-e2e` on a network that allows
// Playwright's browser download.
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, USER3, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

const CHANNEL = "e2e-group-voice";
let ctxs = [], pages = [];

async function uiLogin(page, username) {
  await page.goto("/");
  await page.fill("#login-username", username);
  await page.fill("#login-password", PASSWORD);
  await page.press("#login-password", "Enter");
  await expect(page.locator("#me-name")).toBeVisible();
}

// selectChannel clicks the named row in the sidebar channel list (the realtime
// channel.new broadcast adds it after creation — no reload).
async function selectChannel(page, name) {
  const row = page.locator("#channel-list li", { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
}

// assertLiveVideo: at least `min` tiles in the grid are actually playing — real
// dimensions and a currentTime that advances between two samples.
async function assertLiveVideo(page, min) {
  await expect.poll(async () => page.locator("#video-grid video").count(), {
    timeout: 20_000,
  }).toBeGreaterThanOrEqual(min);
  await expect.poll(async () => {
    return page.evaluate(async () => {
      const vids = [...document.querySelectorAll("#video-grid video")];
      const before = vids.map((v) => v.currentTime);
      await new Promise((r) => setTimeout(r, 500));
      let live = 0;
      vids.forEach((v, i) => { if (v.videoWidth > 0 && v.currentTime > before[i]) live++; });
      return live;
    });
  }, { timeout: 20_000 }).toBeGreaterThanOrEqual(min);
}

async function inCall(page) {
  await expect(page.locator("#call-strip")).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  for (const username of [ADMIN, USER2, USER3]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await uiLogin(page, username);
    ctxs.push(ctx);
    pages.push(page);
  }
  // Admin creates a public voice channel; it broadcasts to everyone. Clear any
  // saved camera preference so joins start audio-only and we drive the cameras
  // explicitly.
  await pages[0].evaluate(async (name) => {
    await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name }),
    });
  }, CHANNEL);
  for (const page of pages) {
    await page.evaluate(() => localStorage.removeItem("rivendell.cameraEnabled"));
    await selectChannel(page, CHANNEL);
  }
});

test.afterAll(async () => {
  for (const ctx of ctxs) await ctx?.close();
});

test("three users join one voice channel", async () => {
  for (const page of pages) await page.click("#call-btn"); // 🔊 Join voice
  for (const page of pages) await inCall(page);
});

test("two cameras on → the third sees both remote tiles in the group gallery", async () => {
  // Two participants enable cameras; the renegotiations fan out across the mesh.
  await pages[0].click("#call-camera-btn");
  await pages[1].click("#call-camera-btn");

  // The camera-off third user receives BOTH camera-on remotes as live tiles.
  await assertLiveVideo(pages[2], 2);
  await expect(pages[2].locator("#video-grid")).toHaveClass(/group-grid/);

  // ...and exactly two tiles: the camera-off viewer no longer takes a slot for
  // its own avatar (2.0.1 — self tile dropped when our own camera is off).
  await expect(pages[2].locator("#video-grid .video-tile")).toHaveCount(2);

  // Each camera-on user sees its own local preview plus the other's tile.
  await assertLiveVideo(pages[0], 2);
  await assertLiveVideo(pages[1], 2);
});

test("spotlight view: one big tile + filmstrip, pin on click, toggle back", async () => {
  // The camera-off third user switches to the opt-in spotlight view (▣ control).
  const grid = pages[2].locator("#video-grid");
  await grid.locator(".video-spotlight-btn").click();

  await expect(grid).toHaveClass(/spotlight/);
  // One big stage tile playing live, the other remote down in the filmstrip.
  await expect.poll(async () =>
    pages[2].locator("#video-grid .spotlight-stage video").count()
  ).toBeGreaterThanOrEqual(1);
  await expect(grid.locator(".spotlight-strip .video-tile")).toHaveCount(1);

  // Clicking the filmstrip tile pins it as the spotlight subject; still spotlit.
  await grid.locator(".spotlight-strip .video-tile").first().click();
  await expect(grid).toHaveClass(/spotlight/);
  await expect(grid.locator(".spotlight-stage video")).toHaveCount(1);

  // Toggling the control off returns to the even gallery (no spotlight class).
  await grid.locator(".video-spotlight-btn").click();
  await expect(grid).not.toHaveClass(/spotlight/);
  await expect(grid.locator(".video-tile")).toHaveCount(2);
});

test("everyone hangs up", async () => {
  for (const page of pages) await page.click("#call-leave-btn");
  for (const page of pages) {
    await expect(page.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
  }
});
