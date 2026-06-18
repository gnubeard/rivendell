// e2e/dm-call.spec.js — end-to-end WebRTC DM call tests, two real browser
// contexts against a real server (started in global-setup).
//
// What this covers that unit tests can't: actual RTCPeerConnection
// offer/answer/ICE over the live WS hub, with Chromium's fake capture devices
// providing real (synthetic, moving) media. Three behaviors are pinned:
//   1. happy path  — ring → accept → both ends connected, audio flowing
//   2. renegotiation — camera enabled MID-call (addTrack → onnegotiationneeded
//      → re-offer); the remote tile must show advancing frames
//   3. glare — BOTH ends enable cameras simultaneously, producing colliding
//      offers; Perfect Negotiation (impolite lower-id wins, polite higher-id
//      rolls back and answers) must converge with video flowing both ways
//
// Frame-advance assertions use videoWidth > 0 AND currentTime strictly
// increasing across a delay — a tile that decoded one frame and paused (the old
// autoplay-policy freeze) fails the second check, so a regression there is
// caught, not just "an element exists".
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx1, ctx2, page1, page2;

async function uiLogin(page, username) {
  await page.goto("/");
  await page.fill("#login-username", username);
  await page.fill("#login-password", PASSWORD);
  await page.press("#login-password", "Enter");
  // Logged in when the sidebar user profile renders (always non-empty, unlike
  // #channel-list which has zero height on a fresh database with no channels).
  await expect(page.locator("#me-name")).toBeVisible();
}

// openDM creates (or reopens) the DM with `otherUsername` through the public
// API from inside the page (session cookie rides along), then selects it in
// the sidebar — the realtime channel.new broadcast adds the row, no reload.
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

// assertLiveVideo: at least `min` distinct video TRACKS are actually playing — real
// dimensions and a currentTime seen to advance. Accumulates liveness per track id
// across samples (in a widened ~1.2s window) rather than counting tiles that advance
// in one shared window: under full-suite CPU load the decoders stutter and rarely all
// advance simultaneously, so the simpler count is itself flaky. A dead stream never
// accumulates, so this loosens the measurement artifact without hiding a real drop.
// CANONICAL copy + rationale: group-call.spec.js / docs/testing/flaky-e2e.md — the five
// call specs each carry this; keep them in sync.
async function assertLiveVideo(page, min = 1) {
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
});

test.afterAll(async () => {
  await ctx1?.close();
  await ctx2?.close();
});

test("happy path: ring, accept, both ends connected", async () => {
  await openDM(page1, USER2);
  await openDM(page2, ADMIN);

  await page1.click("#call-btn"); // sends voice.ring
  await page2.click("#ring-accept-btn"); // callee accepts → both join

  await inCall(page1);
  await inCall(page2);
});

test("renegotiation: camera enabled mid-call reaches the other end", async () => {
  // Caller turns the camera on mid-call: addTrack → onnegotiationneeded →
  // re-offer; the callee's existing answer path renegotiates transparently.
  await page1.click("#call-camera-btn");
  // Callee (camera off) must receive a live remote tile.
  await assertLiveVideo(page2, 1);
});

test("hang up ends the call for both parties", async () => {
  await page1.click("#call-leave-btn");
  await expect(page1.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
  // DM calls end for BOTH parties server-side (voice.end) — the callee's UI
  // must close on its own, no local action.
  await expect(page2.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
});

test("glare: simultaneous first-time camera adds converge under Perfect Negotiation", async () => {
  test.setTimeout(150_000); // two assertLiveVideo calls, each up to a 45s convergence ceiling
  // A real offer collision needs BOTH ends to addTrack (first-time camera →
  // renegotiation offer) at once, from a camera-off join. The per-channel
  // camera preference would auto-enable page1's camera at join after the
  // previous test, so clear it on both ends first.
  for (const p of [page1, page2]) {
    await p.evaluate(() => localStorage.removeItem("rivendell.cameraEnabled"));
  }

  await page1.click("#call-btn");
  await page2.click("#ring-accept-btn");
  await inCall(page1);
  await inCall(page2);

  // Flip both cameras as close to simultaneously as the driver allows. Both
  // sides addTrack → onnegotiationneeded → offer; the offers cross on the WS
  // and Perfect Negotiation must resolve the collision (impolite lower-id
  // offer wins, polite higher-id implicitly rolls back and answers). Even on a
  // run where the timing doesn't collide, the assertion still pins two-way
  // renegotiated video.
  await Promise.all([
    page1.click("#call-camera-btn"),
    page2.click("#call-camera-btn"),
  ]);

  // Both ends must converge to live video: local preview + remote tile.
  await assertLiveVideo(page1, 2);
  await assertLiveVideo(page2, 2);

  await page1.click("#call-leave-btn");
  await expect(page1.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
  await expect(page2.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
});

test("sequential camera adds: the SECOND camera also reaches the other end", async () => {
  test.setTimeout(180_000); // three assertLiveVideo calls, each up to a 45s convergence ceiling
  // Regression guard. The glare test above adds both cameras at once (neither side
  // yet has a video transceiver, so both addTrack and both offer). The bug this pins
  // is the SEQUENTIAL case: once one side sends video, the other holds a RECVONLY
  // video transceiver for it — and a naive "reuse an idle video sender" replaceTrack
  // would grab that receive slot and never renegotiate, so the second camera's video
  // silently never sent. Turn cameras on one at a time; BOTH ends must end with two
  // live tiles (remote + local PiP).
  for (const p of [page1, page2]) {
    await p.evaluate(() => localStorage.removeItem("rivendell.cameraEnabled"));
  }
  await page1.click("#call-btn");
  await page2.click("#ring-accept-btn");
  await inCall(page1);
  await inCall(page2);

  // First camera (page1): page2 sees one live remote tile.
  await page1.click("#call-camera-btn");
  await assertLiveVideo(page2, 1);

  // Second camera (page2) — the regressing direction: page1 must now see page2's
  // video too (its own local PiP + the newly-arriving remote tile = two live tiles).
  await page2.click("#call-camera-btn");
  await assertLiveVideo(page1, 2);
  await assertLiveVideo(page2, 2);

  await page1.click("#call-leave-btn");
  await expect(page1.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
  await expect(page2.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
});
