// e2e/channel-reorder.spec.js — moderator drag-to-reorder of sidebar channels.
//
// The reorder controller is pure DOM gesture handling: a mousedown that arms,
// a move past a small threshold that "unsticks" the row, live reordering among
// siblings by pointer midpoint, and a drop that persists the new order via
// PATCH. None of that has meaning without a real pointer + layout, so it's e2e
// territory (the order *math* is already unit-tested in channelorder.test.js).
// This spec pins the contract across the app.js → channeldrag.js extraction:
//   - dragging a row reorders it in the sidebar
//   - the new order survives a reload (it was persisted, not just moved in the DOM)
//
// Only the mouse path is automated here; the touch long-press path drives the
// same beginDrag/updateDrag/endDrag core, so this covers the shared logic.
import { test, expect } from "@playwright/test";
import { ADMIN, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page;
// Unique, late-sorting names so the trio groups together at the bottom of the
// list (regular channels sort by position then name) and never collides with
// fixtures left by other specs in the reused e2e database.
const TS = Date.now();
const PFX = `zzdrag${TS}`;
const N1 = `${PFX}a`, N2 = `${PFX}b`, N3 = `${PFX}c`;

async function login(p) {
  await p.goto("/");
  await p.fill("#login-username", ADMIN);
  await p.fill("#login-password", PASSWORD);
  await p.press("#login-password", "Enter");
  await expect(p.locator("#me-name")).toBeVisible();
}

// trioOrder returns our three channels' names in current sidebar order.
async function trioOrder() {
  const names = await page.locator("#channel-list .channel .ch-name").allTextContents();
  return names.filter((n) => n.startsWith(PFX));
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await login(page);
  await page.evaluate(async (names) => {
    for (const name of names) {
      await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name, topic: "", is_private: false }),
      });
    }
  }, [N1, N2, N3]);
  // Realtime channel.new adds the rows; wait until all three are present.
  for (const n of [N1, N2, N3]) {
    await expect(page.locator("#channel-list .channel", { hasText: n })).toBeVisible();
  }
});

test.afterAll(async () => {
  await ctx?.close();
});

test("dragging a row reorders it, and the order persists across reload", async () => {
  // Sanity: fresh channels (position 0) sort by name → a, b, c.
  expect(await trioOrder()).toEqual([N1, N2, N3]);

  // The reused e2e database accumulates channels across runs; the trio can sit
  // below the sidebar's scroll fold. Scroll it into view first so the drag
  // coordinates land on real on-screen rows (the three are adjacent, so bringing
  // N3 into view shows N1/N2 too).
  const srcRow = page.locator("#channel-list .channel", { hasText: N3 });
  const dstRow = page.locator("#channel-list .channel", { hasText: N1 });
  await srcRow.scrollIntoViewIfNeeded();
  const src = await srcRow.boundingBox();
  const dst = await dstRow.boundingBox();

  // Drag N3 (bottom) to above N1 (top of the trio).
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  // Move past the 5px arm threshold so beginDrag fires, then wait for the row to
  // actually enter the dragging state before reordering — removes the race
  // between beginDrag and the next move.
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2 - 10, { steps: 3 });
  await expect(page.locator("#channel-list .channel.dragging")).toBeVisible();
  // ...then up above N1's vertical midpoint so it inserts before it.
  await page.mouse.move(dst.x + dst.width / 2, dst.y + 2, { steps: 10 });
  await page.mouse.up();

  await expect.poll(trioOrder).toEqual([N3, N1, N2]);

  // The drop PATCHed positions; a reload rebuilds the list from the server and
  // must show the same order (proves persistence, not just a live DOM move).
  await page.reload();
  await expect(page.locator("#me-name")).toBeVisible();
  await expect(page.locator("#channel-list .channel", { hasText: N3 })).toBeVisible();
  expect(await trioOrder()).toEqual([N3, N1, N2]);
});
