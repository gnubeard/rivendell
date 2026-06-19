// e2e/exif-strip.spec.js — the privacy guarantee, end to end: an image pasted into
// the composer is stripped of EXIF/GPS by exif.js BEFORE it hits the network, so the
// bytes the server stores carry no location/timestamp metadata.
//
// The store is content-addressed, so we can't reuse composer-paste's "re-POST the
// same bytes → same hash" probe (the upload is deliberately NOT the source bytes
// anymore). Instead we capture the actual POST body to /api/uploads and assert the
// GPS sentinel never left the browser.
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

let ctx, page;

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.goto("/");
  await page.fill("#login-username", ADMIN);
  await page.fill("#login-password", PASSWORD);
  await page.press("#login-password", "Enter");
  await expect(page.locator("#me-name")).toBeVisible();
  await page.evaluate(async (name) => {
    const users = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    const other = users.find((u) => u.username === name);
    await fetch("/api/dms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ user_id: other.id }),
    });
  }, USER2);
  const row = page.locator("#dm-list li", { hasText: USER2 }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator("#composer-input")).toBeVisible();
});

test.afterAll(async () => {
  await ctx?.close();
});

test("pasted JPEG is uploaded with its EXIF/GPS metadata stripped", async () => {
  // Capture exactly the bytes api.uploadBlob hands to fetch (a Blob body, which
  // Playwright's postDataBuffer can't read). Wrap fetch in-page; api.js calls the
  // global fetch at call time, so this intercepts the real upload.
  await page.evaluate(() => {
    const orig = window.fetch;
    window.__uploadBody = null;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/uploads") && init && init.body instanceof Blob) {
        window.__uploadBody = Array.from(new Uint8Array(await init.body.arrayBuffer()));
      }
      return orig(input, init);
    };
  });

  // Build a JPEG carrying an Exif APP1 with a recognizable "GPSLEAK!" sentinel, then
  // paste it through the clipboard channel exactly as a real paste would.
  await page.evaluate(() => {
    const a = (s) => [...s].map((c) => c.charCodeAt(0));
    const seg = (m, p) => [0xff, m, ((p.length + 2) >> 8) & 0xff, (p.length + 2) & 0xff, ...p];
    const exif = [
      ...a("Exif"), 0, 0,
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00, // one IFD0 entry: Orientation = 1
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      ...a("GPSLEAK!"),
    ];
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      ...seg(0xe0, [...a("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
      ...seg(0xe1, exif),
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xab, 0xcd, 0xff, 0xd9,
    ]);
    const dt = new DataTransfer();
    dt.items.add(new File([jpeg], "photo.jpg", { type: "image/jpeg" }));
    const el = document.querySelector("#composer-input");
    el.focus();
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });

  // Wait for the upload to resolve (spinner gone).
  await expect(page.locator("#composer-attachments .attachment:not(.uploading)")).toHaveCount(1);

  const body = await page.evaluate(() => window.__uploadBody);
  expect(body, "upload body was captured").not.toBeNull();
  const text = String.fromCharCode(...body);
  expect(body[0] === 0xff && body[1] === 0xd8, "still a valid JPEG").toBe(true);
  expect(text.includes("GPSLEAK!"), "GPS metadata must not leave the browser").toBe(false);
  expect(text.includes("Exif"), "Exif block stripped entirely (orientation was default)").toBe(false);
});
