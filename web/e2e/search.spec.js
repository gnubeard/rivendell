// e2e/search.spec.js — end-to-end message search against a real server.
//
// Search is DOM-bound and racy (debounced input, generation-token last-writer-
// wins, keyset "load more" paging), so it can't be unit-tested without a real
// browser + server. This spec pins the user-visible contract that the search
// module must keep across the app.js → search.js extraction:
//   1. typing a query renders matching hits (the debounced input path)
//   2. clicking a hit closes the modal and jumps to that message in its channel
//   3. a query with no matches shows the "No messages found." notice
//   4. clearing the box clears the results
//   5. "Load more" pages older hits when a full page came back
import { test, expect } from "@playwright/test";
import { ADMIN, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page;
// Unique per run so a reused e2e database never collides with prior fixtures.
const TS = Date.now();
const TOKEN = `zqx${TS}`; // a needle that appears in no other message
const CHAN = `searchspec${TS}`;

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

// seedMessages creates a fresh public channel and posts `bodies` into it through
// the public API (the page's session cookie rides along). Returns the channel id.
async function seedMessages(p, name, bodies) {
  return p.evaluate(async ({ name, bodies }) => {
    const ch = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name, topic: "", is_private: false }),
    }).then((r) => r.json());
    for (const content of bodies) {
      await fetch(`/api/channels/${ch.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ content, reply_to_id: null }),
      });
    }
    return ch.id;
  }, { name, bodies });
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);
});

test.afterAll(async () => {
  await ctx?.close();
});

test("typing a query renders matching hits", async () => {
  await seedMessages(page, CHAN, [`first ${TOKEN} hit`, `second ${TOKEN} hit`]);

  await page.click("#search-btn");
  await expect(page.locator("#search-modal")).toBeVisible();
  // fill() fires the input event → the 250ms-debounced runSearch path.
  await page.fill("#search-input", TOKEN);

  const rows = page.locator("#search-results .search-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator(".msg-body")).toContainText(TOKEN);
  await expect(rows.first().locator(".search-channel")).toContainText(CHAN);
});

test("clicking a hit closes the modal and jumps to the message", async () => {
  // (continues from the open modal + results of the previous test)
  await page.locator("#search-results .search-row").first().click();
  await expect(page.locator("#search-modal")).toBeHidden();
  // jumpToMessage selected the seeded channel and rendered its messages.
  await expect(page.locator(`#message-list :text("${TOKEN}")`).first()).toBeVisible();
});

test("a query with no matches shows the empty notice", async () => {
  await page.click("#search-btn");
  await expect(page.locator("#search-modal")).toBeVisible();
  await page.fill("#search-input", `nomatch${TS}xyzzy`);
  await expect(page.locator("#search-results li.notice")).toHaveText("No messages found.");
});

test("clearing the box clears the results", async () => {
  await page.fill("#search-input", TOKEN);
  await expect(page.locator("#search-results .search-row")).toHaveCount(2);
  await page.fill("#search-input", "");
  await expect(page.locator("#search-results .search-row")).toHaveCount(0);
  await expect(page.locator("#search-more")).toBeHidden();
});

test("Load more pages older hits past the first page", async () => {
  // Seed one full page + 2 (SEARCH_PAGE is 25) so the pager appears and the
  // second fetch returns the remainder.
  const many = Array.from({ length: 27 }, (_, i) => `page ${TOKEN}page ${i}`);
  await seedMessages(page, `${CHAN}b`, many);

  await page.fill("#search-input", `${TOKEN}page`);
  const rows = page.locator("#search-results .search-row");
  await expect(rows).toHaveCount(25); // first page
  await expect(page.locator("#search-more")).toBeVisible();
  await page.click("#search-more");
  await expect(rows).toHaveCount(27); // appended the remainder
});
