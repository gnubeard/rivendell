// e2e/lightbox-gallery.spec.js — the image lightbox doubles as a per-channel
// gallery. Clicking an inline image opens it large (openLightbox), and the
// channel's other LOADED images become reachable via the ‹ › buttons, the
// Left/Right arrow keys, and (mobile) a horizontal swipe — all driven off a DOM
// snapshot of #message-list's a.msg-image-link anchors, no server round-trip.
//
// This spec posts messages carrying bare image URLs (they render as inline
// a.msg-image-link > img.msg-image). The offline sandbox can't fetch the remote
// src — and a 0×0 broken image isn't clickable — so we route-fulfill the URLs
// with real PNG bytes purely so the anchors lay out and take a click. The
// gallery logic itself reads hrefs, not pixels. Pins:
//   1. opening at the clicked image, then stepping next/prev with wrap-around
//      via arrows AND the buttons
//   2. a lone image hides the nav buttons
//   3. closing clears the gallery snapshot
import { test, expect } from "@playwright/test";
import { ADMIN, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

const TS = Date.now();
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

async function typeAndSend(p, text) {
  await p.locator("#composer-input").click();
  await p.keyboard.type(text);
  await p.keyboard.press("Enter");
}

const lightboxSrc = (p) => p.locator("#lightbox-img").getAttribute("src");

// Distinct bare image URLs, in post order. The href === src in imageEmbed, so a
// lightbox src ending in one of these tells us which gallery slot is showing.
const IMG_A = `https://example.invalid/a-${TS}.png`;
const IMG_B = `https://example.invalid/b-${TS}.png`;
const IMG_C = `https://example.invalid/c-${TS}.png`;

// 2×2 opaque PNG — small but comfortably non-zero so the anchor takes a click.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNkYPhfz0AEYBxVSAYAAAEEAQB2L4hHAAAAAElFTkSuQmCC";

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  // Serve real bytes for the (otherwise unreachable) image hosts so the inline
  // <img> elements lay out and are clickable.
  await page.route("https://example.invalid/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(PNG_B64, "base64"),
    }),
  );
  await uiLogin(page, ADMIN);
  channelId = await makeChannel(page, `gallery-${TS}`);
  await openChannel(page, channelId);
});

test.afterAll(async () => { await ctx?.close(); });

test("opens at the clicked image and steps next/prev with wrap (arrows + buttons)", async () => {
  for (const url of [IMG_A, IMG_B, IMG_C]) await typeAndSend(page, url);
  const links = page.locator("#message-list a.msg-image-link");
  await expect(links).toHaveCount(3);

  // Open on the MIDDLE image — the gallery must start there, not at index 0.
  await links.nth(1).click();
  await expect(page.locator("#lightbox")).toBeVisible();
  expect(await lightboxSrc(page)).toBe(IMG_B);

  // A multi-image gallery shows both nav buttons.
  await expect(page.locator("#lightbox-prev")).toBeVisible();
  await expect(page.locator("#lightbox-next")).toBeVisible();

  // Right arrow → next.
  await page.keyboard.press("ArrowRight");
  expect(await lightboxSrc(page)).toBe(IMG_C);
  // Right again wraps to the first.
  await page.keyboard.press("ArrowRight");
  expect(await lightboxSrc(page)).toBe(IMG_A);
  // Left arrow wraps back to the last.
  await page.keyboard.press("ArrowLeft");
  expect(await lightboxSrc(page)).toBe(IMG_C);

  // The ‹ › buttons step the same way.
  await page.locator("#lightbox-next").click();
  expect(await lightboxSrc(page)).toBe(IMG_A);
  await page.locator("#lightbox-prev").click();
  expect(await lightboxSrc(page)).toBe(IMG_C);

  // Esc closes and clears the snapshot.
  await page.keyboard.press("Escape");
  await expect(page.locator("#lightbox")).toBeHidden();
});

test("a lone image hides the nav buttons", async () => {
  const solo = await makeChannel(page, `gallery-solo-${TS}`);
  await openChannel(page, solo);
  await typeAndSend(page, IMG_A);
  const links = page.locator("#message-list a.msg-image-link");
  await expect(links).toHaveCount(1);

  await links.first().click();
  await expect(page.locator("#lightbox")).toBeVisible();
  expect(await lightboxSrc(page)).toBe(IMG_A);
  await expect(page.locator("#lightbox-prev")).toBeHidden();
  await expect(page.locator("#lightbox-next")).toBeHidden();

  await page.keyboard.press("Escape");
  await expect(page.locator("#lightbox")).toBeHidden();
});
