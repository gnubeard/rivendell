// e2e/image-pin.spec.js — a late-loading image at the live tail must not strand a
// pinned reader above the newest message.
//
// scrollToBottom (history.js) pins across frames AND re-pins on each <img> load,
// because images here carry no intrinsic height (CSS max-height only) so they
// reserve ~0px until decoded and then expand the container. The subtle bug: an
// image's `load` event can fire BEFORE the browser reflows it to full height, so a
// single synchronous re-pin reads a stale scrollHeight, lands short, and the reflow
// then pushes the new message off the bottom. The fix gives the late re-pin the same
// multi-frame treatment as the initial pin; this spec reproduces the window by
// route-fulfilling the image with a delay + real tall PNG bytes and asserting the
// reader ends pinned to the bottom once it has loaded.
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

const TS = Date.now();
let ctxA, ctxB, pageA, pageB, channelId;

// Tall solid PNG (240×480). Rendered it clamps to .msg-image's max-height (280px) —
// comfortably more than NEAR_BOTTOM_PX (80), so the post-load reflow would strand the
// reader if the re-pin lands short. Distinct host so we can route + delay it.
const IMG_URL = `https://example.invalid/tall-${TS}.png`;
const TALL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAAHgCAIAAAAUlnfqAAAFDUlEQVR4nO3SUQkAIBTAwNfJTnayrSUEYRxcgH1s1j6QMd8L4CFDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphibF0KQYmhRDk2JoUgxNiqFJMTQphiblAhzgA4f13ZgHAAAAAElFTkSuQmCC";

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

const row = (p, id) => p.locator(`#message-list [data-msg-id="${id}"]`);

// Distance the reader sits above the live tail. < NEAR_BOTTOM_PX (80) === pinned.
const distanceFromBottom = (p) =>
  p.evaluate(() => {
    const el = document.getElementById("message-list");
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });

test.beforeAll(async ({ browser }) => {
  ctxA = await browser.newContext();
  pageA = await ctxA.newPage();
  // Only the READER's layout matters. Fulfill the image with a deliberate delay so its
  // `load` fires well after the initial scroll-to-bottom pin — the race window.
  await pageA.route("https://example.invalid/**", async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(TALL_PNG_B64, "base64"),
    });
  });
  await uiLogin(pageA, ADMIN);

  ctxB = await browser.newContext();
  pageB = await ctxB.newPage();
  await uiLogin(pageB, USER2);

  // Create after both are connected so each gets the channel.new live.
  channelId = await makeChannel(pageA, `imgpin-${TS}`);
  // Fill the pane past one viewport so it actually scrolls and the image's post-load
  // expansion can strand the reader.
  for (let i = 0; i < 40; i++) await postMessage(pageA, channelId, `filler ${i} ${TS}`);
  await openChannel(pageA, channelId);
  await openChannel(pageB, channelId);
  // Reader starts pinned at the live tail.
  await expect.poll(() => distanceFromBottom(pageA)).toBeLessThan(80);
});

test.afterAll(async () => {
  await ctxA?.close();
  await ctxB?.close();
});

test("a late-loading image at the tail keeps the reader pinned to the bottom", async () => {
  // Another user posts a message whose last element is an image. pageA appends it at
  // the tail and pins; the image then loads (delayed) and expands the container.
  const id = await postMessage(pageB, channelId, IMG_URL);
  await expect(row(pageA, id)).toBeVisible();
  await expect(row(pageA, id).locator("img.msg-image")).toBeVisible();

  // Once the image has loaded and reflowed, the reader must still be at the bottom.
  // A retrying poll waits out the delayed load + reflow instead of sampling once, so
  // it's the steady state being asserted, not a single frame.
  await expect
    .poll(() => distanceFromBottom(pageA), { timeout: 5000 })
    .toBeLessThan(80);
});
