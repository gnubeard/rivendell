// e2e/listen-only.spec.js — graceful degradation when a caller has no usable
// microphone (2.0.1). Two real browser contexts against the live server.
//
// The callee's getUserMedia is stubbed to reject (as a denied/missing mic does),
// so the join can't capture audio. Instead of the call being refused, the callee
// joins LISTEN-ONLY: no local capture, recvonly transceivers, so they still hear
// and SEE everyone — they just can't transmit. What this pins:
//   1. the callee lands in the call, flagged listen-only (disabled 🙉 mute pill,
//      "· listen-only" label, no camera/share controls)
//   2. recvonly still receives: the caller turns their camera on and the
//      listen-only callee gets the live remote tile + an inbound audio track
//
// Like the rest of web/e2e, this needs installed browsers and runs via
// `make test-e2e`, not `make test`.
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

async function remoteAudioTrackCount(page) {
  return page.evaluate(() => {
    let n = 0;
    for (const a of document.querySelectorAll("audio")) {
      if (a.srcObject) n += a.srcObject.getAudioTracks().length;
    }
    return n;
  });
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
  await openDM(page1, USER2);
  await openDM(page2, ADMIN);
  for (const p of [page1, page2]) {
    await p.evaluate(() => localStorage.removeItem("rivendell.cameraEnabled"));
  }
});

test.afterAll(async () => {
  await ctx1?.close();
  await ctx2?.close();
});

test("no mic → callee joins listen-only and still receives", async () => {
  // Block the callee's capture (denied/missing mic) and swallow the one-time
  // "you're listen-only" notice so it doesn't wedge the run.
  await page2.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
  });
  page2.on("dialog", (d) => d.dismiss());

  await page1.click("#call-btn");        // ring
  await page2.click("#ring-accept-btn"); // accept → join (degrades to listen-only)
  await inCall(page1);
  await inCall(page2);

  // The callee is in the call but flagged listen-only.
  await expect(page2.locator("#call-mute-btn")).toHaveText("🙉");
  await expect(page2.locator("#call-mute-btn")).toBeDisabled();
  await expect(page2.locator("#call-strip-label")).toContainText("listen-only");
  // No camera control — a listen-only participant has no local capture to send.
  await expect(page2.locator("#call-camera-btn")).toBeHidden();

  // Recvonly still receives: the caller turns the camera on and the listen-only
  // callee gets the live remote tile...
  await page1.click("#call-camera-btn");
  await assertLiveVideo(page2, 1);
  // ...plus the caller's inbound audio track (we can hear, we just can't talk).
  await expect.poll(() => remoteAudioTrackCount(page2), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
});

test("hang up ends the listen-only call for both", async () => {
  await page1.click("#call-leave-btn");
  await expect(page1.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
  await expect(page2.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
});
