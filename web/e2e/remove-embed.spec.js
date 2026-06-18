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

// openChannel selects the channel AND waits for its messages GET to settle. The
// wait matters because these specs post AFTER opening: a message is otherwise
// delivered to this client twice — once by this GET, once by the WS message.new
// echo — and addMessage OVERWRITES content on the second delivery. If that second
// delivery lands after the test's "remove embed" edit, it reverts the row to the
// original (un-wrapped) content and the embed reappears. Opening the empty channel
// first, with the GET drained, leaves the WS echo as the message's sole delivery,
// so nothing can race the later edit.
async function openChannel(p, channelId) {
  const loaded = p.waitForResponse(
    (r) =>
      new RegExp(`/api/channels/${channelId}/messages(\\?|$)`).test(r.url()) &&
      r.request().method() === "GET" &&
      r.ok(),
  );
  await p.click(`#channel-list li[data-ch-id="${channelId}"]`);
  await expect(p.locator(`#channel-list li[data-ch-id="${channelId}"]`)).toHaveClass(/active/);
  await loaded;
}

// assertButtonOverEmbed checks the × sits INSIDE the embed's box (top-right corner),
// not floating in the margin gap above it (the bug this fix targets). The button
// keeps a layout box even while visibility:hidden, so this is measurable without
// depending on CSS :hover (the click below uses dispatchEvent, also hover-independent).
//
// The geometry is read inside an expect.poll because it isn't stable on the first
// frame: for the bare-URL image case the × is positioned against the anchor's box,
// which is an unsized inline-block (width ~0) until the routed <img> decodes — and
// the row is re-rendered out from under us when the message.new WS echo of our own
// post lands, swapping in a fresh loading="lazy" <img> that resets to not-complete.
// So we re-measure until the image is loaded AND the button is contained, which is
// robust to any intervening re-render rather than racing a single snapshot.
async function assertButtonOverEmbed(p, embedSel) {
  await expect
    .poll(() =>
      p.evaluate((sel) => {
        const embed = document.querySelector(sel);
        const btn = embed && embed.querySelector(".embed-remove");
        if (!embed || !btn) return { ready: false, inside: false };
        // An image embed has no measurable box until its <img> has intrinsic size.
        const img = embed.querySelector("img.msg-image");
        if (img && !(img.complete && img.naturalWidth > 0)) return { ready: false, inside: false };
        const e = embed.getBoundingClientRect();
        const b = btn.getBoundingClientRect();
        const cx = (b.left + b.right) / 2;
        const cy = (b.top + b.bottom) / 2;
        // Button center within the embed's box (a small tolerance for the inset).
        const inside = cx >= e.left - 1 && cx <= e.right + 1 && cy >= e.top - 1 && cy <= e.bottom + 1;
        return { ready: true, inside };
      }, embedSel),
    )
    .toEqual({ ready: true, inside: true });
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
  await openChannel(page, ch); // open the empty channel first; post lands via the WS echo only
  await postMessage(page, ch, `read this ${extURL}`);

  const card = page.locator("#message-list a.link-preview");
  await expect(card).toBeVisible();

  // The × is appended into the card and sits at its top-right corner (not the gap
  // above). It's pointer-events:none until CSS row-hover, so a real click depends on
  // the hover landing first (a :hover/pointer-events frame race). dispatchEvent runs
  // the handler directly — no hover dependency — exactly like emoji-picker.spec.js.
  await assertButtonOverEmbed(page, "#message-list a.link-preview");
  await card.locator(".embed-remove").dispatchEvent("click");

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
  await openChannel(page, ch); // open the empty channel first; post lands via the WS echo only
  await postMessage(page, ch, `look ${imgURL}`);

  const imgLink = page.locator("#message-list a.msg-image-url");
  await expect(imgLink).toBeVisible();

  // The × is appended into the image anchor and sits over the image's top-right
  // corner (the inner img margin is moved to the anchor so it doesn't push the ×
  // into the gap above). It's pointer-events:none until CSS row-hover, so dispatchEvent
  // runs the handler directly — no hover/pointer-events frame race (cf. emoji-picker).
  await assertButtonOverEmbed(page, "#message-list a.msg-image-url");
  await imgLink.locator(".embed-remove").dispatchEvent("click");

  // Image gone, URL now a plain (non-image) link.
  await expect(page.locator("#message-list img.msg-image")).toHaveCount(0);
  await expect(page.locator(`#message-list a[href="${imgURL}"]`)).toBeVisible();

  await page.unroute("https://example.invalid/**");
});
