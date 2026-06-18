// e2e/link-previews.spec.js — end-to-end link/embed previews against a real
// server.
//
// buildLinkPreview is DOM-bound (it builds cards and wires click→navigate) and
// async (fetch a message / fetch an og: card, then re-render on a debounce), so
// it can't be unit-tested without a real browser + server. This spec pins the
// user-visible contract that the link-preview module must keep across the
// app.js → linkpreview.js extraction:
//   1. a same-origin message permalink renders an inline .msg-embed card, and
//      clicking it navigates to that message (here: in another channel)
//   2. a bare YouTube URL renders a client-side .yt-thumb linking to the video
//   3. a bare external URL renders an og: .link-preview card from the
//      /api/link-preview response (stubbed via route so the test needs no
//      external network)
import { test, expect } from "@playwright/test";
import { ADMIN, PASSWORD, BASE } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page;
// Unique per run so a reused e2e database / preview cache never collides with
// prior fixtures.
const TS = Date.now();
const TOKEN = `lpz${TS}`;

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

// makeChannel creates a fresh public channel through the public API (the page's
// session cookie rides along) and returns its id.
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

// postMessage posts content into a channel and returns the created message id.
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

// openChannel clicks a channel in the sidebar and waits for it to become active.
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

test("a same-origin message permalink renders an embed card and clicking it jumps", async () => {
  // Target message lives in one channel; the permalink that embeds it lives in
  // another, so clicking the embed proves a real cross-channel jump.
  const target = await makeChannel(page, `lptarget${TS}`);
  const home = await makeChannel(page, `lphome${TS}`);
  const targetMsgId = await postMessage(page, target, `embed me ${TOKEN}`);
  await postMessage(page, home, `${BASE}/#c${target}/m${targetMsgId}`);

  await openChannel(page, home);

  const embed = page.locator("#message-list .msg-embed");
  await expect(embed).toBeVisible();
  await expect(embed.locator(".msg-embed-author")).toContainText(ADMIN);
  await expect(embed.locator(".msg-embed-body")).toContainText(TOKEN);

  // Clicking the card navigates to the target message in its channel.
  await embed.click();
  await expect(page.locator(`#channel-list li[data-ch-id="${target}"]`)).toHaveClass(/active/);
  await expect(page.locator(`#message-list :text("embed me ${TOKEN}")`).first()).toBeVisible();
});

test("a bare YouTube URL renders a client-side thumbnail embed", async () => {
  const ch = await makeChannel(page, `lpyt${TS}`);
  await postMessage(page, ch, "watch this https://www.youtube.com/watch?v=dQw4w9WgXcQ");

  await openChannel(page, ch);

  const yt = page.locator("#message-list .yt-thumb");
  await expect(yt).toBeVisible();
  await expect(yt).toHaveAttribute("href", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await expect(yt.locator("img")).toHaveAttribute("src", /dQw4w9WgXcQ/);
});

test("a bare external URL renders an og: link-preview card", async () => {
  // Stub the server's link-preview endpoint so the card render is deterministic
  // and needs no outbound network. The URL is unique per run so the client-side
  // extPreviews cache can't serve a stale entry.
  const extURL = `https://example.com/article-${TS}`;
  await page.route("**/api/link-preview*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: `Headline ${TOKEN}`,
        description: "A stubbed description.",
        site_name: "Example",
        image_url: "",
      }),
    }),
  );

  const ch = await makeChannel(page, `lpext${TS}`);
  await postMessage(page, ch, `read this ${extURL}`);

  await openChannel(page, ch);

  const card = page.locator("#message-list a.link-preview");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("href", extURL);
  await expect(card.locator(".link-preview-site")).toHaveText("Example");
  await expect(card.locator(".link-preview-title")).toHaveText(`Headline ${TOKEN}`);
  await expect(card.locator(".link-preview-desc")).toHaveText("A stubbed description.");

  await page.unroute("**/api/link-preview*");
});
