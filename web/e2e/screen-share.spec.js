// e2e/screen-share.spec.js — end-to-end desktop screen sharing, two real browser
// contexts against a real server (started in global-setup).
//
// getDisplayMedia is STUBBED on the sharer's context to return Chromium's fake
// camera+mic as a stand-in "screen" + "system audio". That's deliberate and matches
// the suite's philosophy: we own the WebRTC plumbing (the source swap, the audio
// track riding into the peer, the teardown), the browser owns real screen capture —
// which is headless-flaky and not ours to test. The stub gives a known-moving video
// + a real audio track so the assertions below pin OUR behavior:
//   1. start a share → the remote receives live screen VIDEO, and the shared AUDIO
//      arrives on its OWN msid, split onto a SECOND per-peer <audio> element (two
//      elements, one track each — the design that lets the receiver give the share
//      its own playout volume, independent of the peer's voice), and the DM header's
//      separate "stream volume" slider appears
//   2. switch to the camera → the video source swaps and the shared audio is dropped
//      (back to mic-only, one element, on the remote), exercising the screen→camera path
//
// Frame-advance assertions (videoWidth > 0 AND currentTime increasing) match
// dm-call.spec.js: a tile that decoded one frame and paused fails the second check.
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

// remoteAudioTrackCount totals the audio tracks across every <audio> element
// voice.js created for remote peers. Mic-only = 1; mic + shared screen audio = 2
// (now split across TWO elements, one track each — totals the same 2).
async function remoteAudioTrackCount(page) {
  return page.evaluate(() => {
    let n = 0;
    for (const a of document.querySelectorAll("audio")) {
      if (a.srcObject) n += a.srcObject.getAudioTracks().length;
    }
    return n;
  });
}

// remoteLiveAudioCount totals the audio tracks that are actually carrying media
// (not muted). This is "what the peer can hear". The screen share's audio is fully
// REMOVED on stop (pc.removeTrack → the receiver's screen <audio> element is torn
// down), so both the raw count and the live count fall back to 1 (mic) on release.
async function remoteLiveAudioCount(page) {
  return page.evaluate(() => {
    let n = 0;
    for (const a of document.querySelectorAll("audio")) {
      if (a.srcObject) n += a.srcObject.getAudioTracks().filter((t) => !t.muted).length;
    }
    return n;
  });
}

async function inCall(page) {
  await expect(page.locator("#call-strip")).toBeVisible({ timeout: 20_000 });
}

// localVideoHint reads the contentHint off the sharer's OWN screen track via its local
// preview tile (#video-grid carries getLocalVideoEl(), whose srcObject is localStream).
// contentHint is a local-only sender property — it never crosses the wire — so this is
// how we observe the fps-driven auto-switch: a share starts "detail" and the congestion
// monitor flips it to "motion" once it sees the screen is playing high-fps video.
async function localVideoHint(page) {
  return page.evaluate(() => {
    for (const v of document.querySelectorAll("#video-grid video")) {
      const t = v.srcObject && v.srcObject.getVideoTracks && v.srcObject.getVideoTracks()[0];
      if (t && t.contentHint) return t.contentHint; // skip remote tracks (default empty hint)
    }
    return null;
  });
}

test.beforeAll(async ({ browser }) => {
  ctx1 = await browser.newContext();
  ctx2 = await browser.newContext();
  // Stub getDisplayMedia on the sharer only: delegate to the fake getUserMedia
  // device so the "screen" is a known-moving video and the "system audio" is a real
  // audio track. video:true always; audio mirrors the requested constraint.
  await ctx1.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = (c) =>
      navigator.mediaDevices.getUserMedia({ video: true, audio: !!(c && c.audio) });
  });
  page1 = await ctx1.newPage();
  page2 = await ctx2.newPage();
  await uiLogin(page1, ADMIN);
  await uiLogin(page2, USER2);
  // Start calls voice-only (clear any per-DM camera memory) so the screen share is
  // the first and only video source — keeps the remote-video assertions unambiguous.
  for (const p of [page1, page2]) {
    await p.evaluate(() => localStorage.removeItem("rivendell.cameraEnabled"));
  }
});

test.afterAll(async () => {
  await ctx1?.close();
  await ctx2?.close();
});

test("screen share reaches the remote as live video + mixed audio", async () => {
  await openDM(page1, USER2);
  await openDM(page2, ADMIN);

  await page1.click("#call-btn"); // ring
  await page2.click("#ring-accept-btn"); // accept → both join voice-only
  await inCall(page1);
  await inCall(page2);

  // The desktop share button is visible during a call (viewport is desktop-width).
  await expect(page1.locator("#header-share-btn")).toBeVisible();
  // Baseline: the remote hears the mic only.
  await expect.poll(() => remoteAudioTrackCount(page2), { timeout: 20_000 }).toBe(1);

  await page1.click("#header-share-btn"); // start sharing (video + audio)

  // The remote receives live screen video...
  await assertLiveVideo(page2, 1);
  // ...and the shared audio on its OWN msid: split onto a SECOND <audio> element so
  // it carries its own playout volume — two elements, one track each, both flowing.
  await expect.poll(() => page2.locator("audio").count(), { timeout: 20_000 }).toBe(2);
  await expect.poll(() => remoteAudioTrackCount(page2), { timeout: 20_000 }).toBe(2);
  await expect.poll(() => remoteLiveAudioCount(page2), { timeout: 20_000 }).toBe(2);

  // The remote's DM header now offers a SEPARATE "stream volume" slider (revealed
  // by the 🔊 toggle), and moving it sets a screen gain distinct from the voice one.
  await page2.click("#channel-dm-call");
  await expect(page2.locator("#dm-screen-volume")).toBeVisible();
  await page2.locator("#dm-screen-volume input").fill("0.3");
  expect(await page2.evaluate(() => {
    const a = document.getElementById("dm-screen-volume").querySelector("input").value;
    const v = document.getElementById("dm-volume").value;
    return [a, v];
  })).toEqual(["0.3", "1"]); // screen turned down, voice untouched
  await page2.click("#channel-dm-call"); // collapse again

  // Sharer UI: the share button is lit and the camera reads "off" (📷).
  await expect(page1.locator("#header-share-btn")).toHaveClass(/active/);
  await expect(page1.locator("#call-camera-btn")).toHaveText("📷");

  // The stubbed "screen" is Chromium's fake video device — a known high-fps moving
  // image — so the congestion monitor's fps detection should auto-switch the share
  // from "detail" to the "motion" profile within a few 2.5s ticks.
  await expect.poll(() => localVideoHint(page1), { timeout: 25_000 }).toBe("motion");
});

test("switching to the camera swaps the source and drops the shared audio", async () => {
  await page1.click("#call-camera-btn"); // screen → camera (replaceTrack swap)

  // Camera video keeps flowing to the remote...
  await assertLiveVideo(page2, 1);
  // ...and the shared audio is fully released: stopScreenAudio removes the sender
  // (renegotiation drops the m-line), so the remote's screen-audio track ends, its
  // separate <audio> element is torn down, and it's back to mic-only — one element.
  await expect.poll(() => remoteAudioTrackCount(page2), { timeout: 20_000 }).toBe(1);
  await expect.poll(() => page2.locator("audio").count(), { timeout: 20_000 }).toBe(1);
  await expect(page1.locator("#header-share-btn")).not.toHaveClass(/active/);
});

test("hang up ends the call for both parties", async () => {
  await page1.click("#call-leave-btn");
  await expect(page1.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
  await expect(page2.locator("#call-strip")).toBeHidden({ timeout: 15_000 });
});
