// e2e/history.spec.js — end-to-end infinite-scroll / history paging against a
// real server.
//
// Written BEFORE the planned app.js → history.js paging carve (the blessed
// sub-system lift in docs/history/frontend-decomposition.md): it must pass green against the
// un-carved code first, so a later red means the carve regressed. The paging
// machine (older/newer page fetches, the IntersectionObserver sentinels, the
// history-window banner) is fetch-then-render DOM with no extractable pure core
// beyond the near-bottom math, so e2e is its only net. It pins the user-visible
// contract:
//   1. opening a channel with > PAGE messages loads the newest page and lands
//      pinned to the newest message (the bottom-pin fix), with the oldest
//      messages NOT yet in the DOM
//   2. scrolling to the top pages in the older messages (top sentinel) without
//      snapping the view back to the bottom — the reader stays up in history
//   3. jumping to an old message via a permalink opens a history window (the
//      #history-banner shows), and scrolling down catches up to the live tail
//      and hides the banner again
import { test, expect } from "@playwright/test";
import { ADMIN, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

const PAGE = 50;       // must match app.js's page size
// SEED is comfortably > PAGE + the around-window so that jumping near the start
// (test 3) leaves a genuine history window after the one forward probe: the server
// around-window is 25 each side, jumpToMessage probes one PAGE forward, so the
// anchor must sit > 25 + PAGE messages from the tail (anchor index 5 ⇒ need > 80).
const SEED = 120;
const ANCHOR_IDX = 5;
const TS = Date.now();

let ctx, page, channelId, ids;

async function uiLogin(p, username) {
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

// seedMessages posts `count` messages in order (server-side ids strictly
// increase) and returns their ids oldest-first. Done in one evaluate so the seed
// is a single round-trip burst, before the channel is opened — so they arrive via
// the normal newest-page fetch, not live appends.
function seedMessages(p, channelId, count, tag) {
  return p.evaluate(async ({ channelId, count, tag }) => {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const msg = await fetch(`/api/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ content: `${tag} #${i}`, reply_to_id: null }),
      }).then((r) => r.json());
      ids.push(msg.id);
    }
    return ids;
  }, { channelId, count, tag });
}

async function openChannel(p, channelId) {
  await p.click(`#channel-list li[data-ch-id="${channelId}"]`);
  await expect(p.locator(`#channel-list li[data-ch-id="${channelId}"]`)).toHaveClass(/active/);
}

const row = (p, id) => p.locator(`#message-list [data-msg-id="${id}"]`);

// listGeom reads the message-list scroll geometry for at-bottom / at-top checks.
const listGeom = (p) => p.evaluate(() => {
  const el = document.getElementById("message-list");
  return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
});

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.goto("/");
  await uiLogin(page, ADMIN);
  channelId = await makeChannel(page, `history-${TS}`);
  ids = await seedMessages(page, channelId, SEED, `hist ${TS}`);
  expect(ids.length).toBe(SEED);
});

test.afterAll(async () => { await ctx?.close(); });

test("opens a long channel pinned to the newest message, oldest not yet loaded", async () => {
  await openChannel(page, channelId);

  // Newest message is loaded and the view is pinned to it.
  await expect(row(page, ids[SEED - 1])).toBeVisible();
  await expect(row(page, ids[SEED - 1])).toBeInViewport();

  // Only the newest page is loaded — the oldest messages aren't in the DOM yet.
  await expect(row(page, ids[0])).toHaveCount(0);

  // Sanity: we really are at the bottom (within the near-bottom threshold).
  const g = await listGeom(page);
  expect(g.height - g.top - g.client).toBeLessThan(80);
});

test("scrolling to the top pages in older messages without snapping to the bottom", async () => {
  // Scroll to the very top — the top sentinel should fault in the older page.
  await page.locator("#message-list").evaluate((el) => { el.scrollTop = 0; });

  // A message from before the initial newest-page window faults in. The first load
  // holds ids[SEED-PAGE..SEED-1]; ids[SEED-PAGE-1] and older live only in an older
  // page, so its appearance proves the top sentinel paged backwards.
  await expect(row(page, ids[SEED - PAGE - 1])).toBeVisible({ timeout: 5000 });

  // The view stayed up in history — it did NOT snap back to the live tail.
  const g = await listGeom(page);
  expect(g.height - g.top - g.client).toBeGreaterThan(80);
  await expect(row(page, ids[SEED - 1])).not.toBeInViewport();
});

test("jumping to an old message opens a history window, catching up hides the banner", async () => {
  // Land directly on an early message via its permalink. A fresh page in the same
  // context is already authenticated, so the load goes straight into the app and
  // enterApp parses the hash, routing to jumpToMessage, which opens a history window.
  const early = ids[ANCHOR_IDX];
  const p2 = await ctx.newPage();
  await p2.goto(`/#c${channelId}/m${early}`);
  await expect(p2.locator("#me-name")).toBeVisible();

  // The jump centers the anchor and flags a history window → banner visible.
  await expect(p2.locator(`#message-list [data-msg-id="${early}"]`)).toBeVisible({ timeout: 5000 });
  await expect(p2.locator("#history-banner")).toBeVisible();

  // Scroll to the bottom repeatedly: the bottom sentinel pages forward until we
  // reach the live tail, at which point the history flag clears and the banner hides.
  await expect(async () => {
    await p2.locator("#message-list").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(p2.locator("#history-banner")).toBeHidden({ timeout: 1000 });
  }).toPass({ timeout: 15000 });

  // Caught up: the newest message is now loaded.
  await expect(p2.locator(`#message-list [data-msg-id="${ids[SEED - 1]}"]`)).toHaveCount(1);
  await p2.close();
});
