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

  const wrap = page.locator("#message-list .embed-wrap").filter({ has: page.locator("a.link-preview") });
  await expect(wrap).toBeVisible();

  // The × is author-only and inside the wrap; click it (force past the hover gate).
  await wrap.locator(".embed-remove").click({ force: true });

  // Card gone, URL now an angle-bracket plain link, message marked edited.
  await expect(page.locator("#message-list a.link-preview")).toHaveCount(0);
  const link = page.locator(`#message-list a[href="${extURL}"]`);
  await expect(link).toBeVisible();
  await expect(page.locator("#message-list .edited").last()).toBeVisible();

  await page.unroute("**/api/link-preview*");
});

test("author removes a bare-URL inline image via the hover ×", async () => {
  // 2×2 opaque PNG so the otherwise-unreachable <img> lays out and is clickable
  // (the offline sandbox can't fetch the remote host) — same trick as the gallery spec.
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNkYPhfz0AEYBxVSAYAAAEEAQB2L4hHAAAAAElFTkSuQmCC";
  await page.route("https://example.invalid/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_B64, "base64") }),
  );

  const imgURL = `https://example.invalid/pic-${TS}.png`;
  const ch = await makeChannel(page, `rmimg${TS}`);
  await postMessage(page, ch, `look ${imgURL}`);
  await openChannel(page, ch);

  const imgLink = page.locator("#message-list a.msg-image-url");
  await expect(imgLink).toBeVisible();

  await imgLink.locator(".embed-remove").click({ force: true });

  // Image gone, URL now a plain (non-image) link.
  await expect(page.locator("#message-list img.msg-image")).toHaveCount(0);
  await expect(page.locator(`#message-list a[href="${imgURL}"]`)).toBeVisible();

  await page.unroute("https://example.invalid/**");
});
