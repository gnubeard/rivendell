// e2e/remove-embed.spec.js — the author-only "remove embed" affordance.
//
// Wrapping a URL in <angle brackets> renders it as a plain link with no inline
// image or preview card (format.js's autolink branch + the extract* skips). The
// author can reach that state from a rendered embed via a hover × that edits the
// message to wrap the URL — this is DOM-bound (real hover + a real edit round-trip)
// so it lives here rather than in the format.js unit suite. Pins:
//   1. an og: card carries a .embed-remove for the author; clicking it edits the
//      message to <url>, the card disappears, a plain link + (edited) remain
//   2. a bare-URL inline image carries .embed-remove; clicking it drops the image
import { test, expect } from "@playwright/test";
import { ADMIN, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page;
const TS = Date.now();

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

// assertButtonOverEmbed checks the × sits INSIDE the embed's box (top-right corner),
// not floating in the margin gap above it (the bug this fix targets). The button
// keeps a layout box even while visibility:hidden, so this is measurable without
// depending on CSS :hover — which Playwright can't reliably hold across awaits, so
// the actual click below uses a force click (hover+click atomically) instead.
async function assertButtonOverEmbed(p, embedSel) {
  const r = await p.evaluate((sel) => {
    const embed = document.querySelector(sel);
    const btn = embed && embed.querySelector(".embed-remove");
    if (!embed || !btn) return null;
    const e = embed.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    return { e: { top: e.top, right: e.right, bottom: e.bottom, left: e.left }, b: { top: b.top, right: b.right, bottom: b.bottom, left: b.left } };
  }, embedSel);
  expect(r, `embed ${embedSel} and its .embed-remove both present`).not.toBeNull();
  // Button's center lies within the embed's box (a small tolerance for the inset).
  const cx = (r.b.left + r.b.right) / 2;
  const cy = (r.b.top + r.b.bottom) / 2;
  expect(cx).toBeGreaterThanOrEqual(r.e.left - 1);
  expect(cx).toBeLessThanOrEqual(r.e.right + 1);
  expect(cy).toBeGreaterThanOrEqual(r.e.top - 1);
  expect(cy).toBeLessThanOrEqual(r.e.bottom + 1);
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);
});

test.afterAll(async () => {
  await ctx?.close();
});

test("author removes an og: card embed via the hover ×", async () => {
  const extURL = `https://example.com/remove-${TS}`;
  await page.route("**/api/link-preview*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ title: "Headline", description: "Desc.", site_name: "Example", image_url: "" }),
    }),
  );

  const ch = await makeChannel(page, `rmext${TS}`);
  await postMessage(page, ch, `read this ${extURL}`);
  await openChannel(page, ch);

  const card = page.locator("#message-list a.link-preview");
  await expect(card).toBeVisible();

  // The × is appended into the card and sits at its top-right corner (not the gap
  // above). Reveal is CSS row-hover; the force click hovers+clicks atomically.
  await assertButtonOverEmbed(page, "#message-list a.link-preview");
  await card.locator(".embed-remove").click({ force: true });

  // Card gone, URL now an angle-bracket plain link, message marked edited.
  await expect(page.locator("#message-list a.link-preview")).toHaveCount(0);
  await expect(page.locator(`#message-list a[href="${extURL}"]`)).toBeVisible();
  await expect(page.locator("#message-list .edited").last()).toBeVisible();

  await page.unroute("**/api/link-preview*");
});

test("author removes a bare-URL inline image via the hover ×", async () => {
  // A real 120×80 PNG so the <img> (and the anchor that hosts the ×) lay out at a
  // sane size — the offline sandbox can't fetch the remote host, so we fulfill it.
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAqElEQVR4nO3QAQkAIADAMOMY0YjGsoXCHTzA2Zhr60Lj+cEngQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnSrA7Pdvw1MhnooAAAAAElFTkSuQmCC";
  await page.route("https://example.invalid/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_B64, "base64") }),
  );

  const imgURL = `https://example.invalid/pic-${TS}.png`;
  const ch = await makeChannel(page, `rmimg${TS}`);
  await postMessage(page, ch, `look ${imgURL}`);
  await openChannel(page, ch);

  const imgLink = page.locator("#message-list a.msg-image-url");
  await expect(imgLink).toBeVisible();

  // The × is appended into the image anchor and sits over the image's top-right
  // corner (the inner img margin is moved to the anchor so it doesn't push the ×
  // into the gap above). Reveal is CSS row-hover; force click hovers+clicks atomically.
  await assertButtonOverEmbed(page, "#message-list a.msg-image-url");
  await imgLink.locator(".embed-remove").click({ force: true });

  // Image gone, URL now a plain (non-image) link.
  await expect(page.locator("#message-list img.msg-image")).toHaveCount(0);
  await expect(page.locator(`#message-list a[href="${imgURL}"]`)).toBeVisible();

  await page.unroute("https://example.invalid/**");
});
