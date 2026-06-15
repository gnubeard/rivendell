// e2e/emoji-picker.spec.js — the shared emoji popup, end to end.
//
// The picker is interactive DOM with real layout math (placement and the
// geometric keyboard navigation read getBoundingClientRect, which has no meaning
// under node/jsdom; on desktop it floats above the control that opened it, on a
// phone it pins to a full-width top panel). It serves two targets through one
// popup: inserting a token into a text field (composer or inline-edit box) and
// reacting to a message. This spec pins that contract across the app.js →
// emoji.js extraction:
//   1. the composer button opens the palette and a pick inserts into the composer
//      (and closes — composer inserts always close, even on Shift-click, because
//      insertIntoInput hides the popup; Shift-to-keep-open applies to reactions)
//   2. moderators+ get the "Manage emojis" footer
//   3. the message reaction button opens the popup in react mode, where Shift-click
//      keeps it open for multiple picks and a plain pick adds a reaction + closes
//   4. the search field filters the grid by shortcode (quick palette + custom)
//   5. keyboard: the search box keeps focus while arrows move the highlight (Left/
//      Right by reading order, Up/Down to the option geometrically above/below) and
//      Enter picks the active option
//   6. a used emoji surfaces under a "Recent" section on the next open
//   7. on a narrow (phone) viewport both the composer and reaction pickers pin to a
//      fixed top panel with a keyboard-fitted grid, instead of floating by the anchor
// Picks target options by their :shortcode: title rather than grid position, since
// the Recent section (seeded by prior picks) shifts positional indices around.
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page, dmId;
const FIRST_UNICODE = "👍"; // first entry in COMMON_EMOJI

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.goto("/");
  await page.fill("#login-username", ADMIN);
  await page.fill("#login-password", PASSWORD);
  await page.press("#login-password", "Enter");
  await expect(page.locator("#me-name")).toBeVisible();
  // A DM gives the composer an active channel without channel-admin UI; capture
  // its id so we can seed a message to react to.
  dmId = await page.evaluate(async (name) => {
    const users = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    const other = users.find((u) => u.username === name);
    const ch = await fetch("/api/dms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ user_id: other.id }),
    }).then((r) => r.json());
    return ch.id;
  }, USER2);
  const row = page.locator("#dm-list li", { hasText: USER2 }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator("#composer-input")).toBeVisible();
  // Recently-used emoji are browser-local (localStorage) and can survive across
  // runs in a reused profile; clear them so the suite starts with no Recent
  // section and the quick-palette order is the deterministic default.
  await page.evaluate(() => localStorage.removeItem("rivendell.recentEmoji"));
});

test.afterAll(async () => {
  await ctx?.close();
});

async function clearComposer() {
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });
}

test("composer button opens the palette and a pick inserts into the composer", async () => {
  await clearComposer();
  await page.click("#emoji-btn");
  await expect(page.locator("#emoji-wrap")).toBeVisible();
  await expect(page.locator("#emoji-picker .emoji-choice").first()).toBeVisible();
  await page.locator("#emoji-picker .emoji-choice").first().click();
  await expect(page.locator("#emoji-wrap")).toBeHidden();
  expect(await page.evaluate(() => document.querySelector("#composer-input").value)).toContain(FIRST_UNICODE);
});

test("moderators+ get the Manage emojis footer", async () => {
  await page.click("#emoji-btn");
  await expect(page.locator("#emoji-wrap")).toBeVisible();
  await expect(page.locator(".emoji-manage-btn")).toBeVisible(); // ADMIN is mod+
  await page.keyboard.press("Escape"); // close without managing
});

test("react mode: Shift-click keeps the popup open; a plain pick adds a pill and closes", async () => {
  // Seed a fresh, uniquely-worded message (the e2e database is reused across runs;
  // a unique needle guarantees a row with no pre-existing reactions to toggle off).
  const needle = `react-${Date.now()}`;
  await page.evaluate(async ({ id, needle }) => {
    await fetch(`/api/channels/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ content: needle, reply_to_id: null }),
    });
  }, { id: dmId, needle });

  const row = page.locator("#message-list [data-msg-id]", { hasText: needle }).first();
  await expect(row).toBeVisible();
  await row.hover(); // reveal the action row so the button has real layout
  // The hover-revealed actions overlay the .msg-head, which intercepts a real
  // pointer click; dispatch the click straight to the button so its handler runs
  // (e.currentTarget stays the button, which the picker floats next to).
  await row.locator('button.msg-act[title="Add reaction"]').dispatchEvent("click");
  // Popup is now floated in react mode. Shift-click keeps it open... (target by
  // :shortcode: so the two picks are guaranteed-distinct emoji regardless of any
  // Recent-section duplicates of the same glyph.)
  await expect(page.locator("#emoji-wrap")).toBeVisible();
  await page.locator('#emoji-picker .emoji-choice[title=":+1:"]').first().click({ modifiers: ["Shift"] });
  await expect(page.locator("#emoji-wrap")).toBeVisible();
  await expect(row.locator(".reaction").first()).toBeVisible();
  // ...and a plain pick (a different emoji) adds another and closes the popup.
  await page.locator('#emoji-picker .emoji-choice[title=":thumbsdown:"]').first().click();
  await expect(page.locator("#emoji-wrap")).toBeHidden();
  await expect(row.locator(".reaction")).toHaveCount(2);
});

test("search filters the grid by shortcode", async () => {
  await clearComposer();
  await page.click("#emoji-btn");
  await expect(page.locator("#emoji-wrap")).toBeVisible();
  await page.fill("#emoji-search", "fire");
  // The builtin :fire: 🔥 survives the filter; an unrelated builtin does not.
  await expect(page.locator('#emoji-picker .emoji-choice[title=":fire:"]')).toBeVisible();
  await expect(page.locator('#emoji-picker .emoji-choice[title=":thumbsdown:"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#emoji-wrap")).toBeHidden();
});

test("keyboard: search keeps focus, arrows move the highlight, Enter picks", async () => {
  await clearComposer();
  // Clear recents so the first grid row is the quick palette in its fixed order.
  await page.evaluate(() => localStorage.removeItem("rivendell.recentEmoji"));
  await page.click("#emoji-btn");
  await expect(page.locator("#emoji-search")).toBeFocused();
  // First option (👍) is active on open; ArrowRight advances to the second (👎),
  // and Enter inserts it into the composer and closes the popup.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.locator("#emoji-wrap")).toBeHidden();
  expect(await page.evaluate(() => document.querySelector("#composer-input").value)).toContain("👎");
});

test("keyboard: ArrowDown moves to the emoji below, not the next in reading order", async () => {
  await clearComposer();
  await page.evaluate(() => localStorage.removeItem("rivendell.recentEmoji"));
  await page.click("#emoji-btn");
  await expect(page.locator("#emoji-search")).toBeFocused();
  const activeRect = () => page.$eval('#emoji-picker .emoji-choice[aria-selected="true"]', (n) => {
    const r = n.getBoundingClientRect();
    return { top: r.top, mid: r.left + r.width / 2 };
  });
  const before = await activeRect(); // first option (👍), top-left of the palette
  await page.keyboard.press("ArrowDown");
  const after = await activeRect();
  expect(after.top).toBeGreaterThan(before.top); // dropped a row...
  expect(Math.abs(after.mid - before.mid)).toBeLessThan(20); // ...staying in the same column
  await page.keyboard.press("Escape");
  await expect(page.locator("#emoji-wrap")).toBeHidden();
});

test("a used emoji surfaces under a Recent section on reopen", async () => {
  await clearComposer();
  await page.evaluate(() => localStorage.removeItem("rivendell.recentEmoji"));
  await page.click("#emoji-btn");
  await page.locator('#emoji-picker .emoji-choice[title=":tada:"]').first().click(); // inserts 🎉 + records it
  await expect(page.locator("#emoji-wrap")).toBeHidden();
  await page.click("#emoji-btn"); // reopen — Recent section now leads the grid
  await expect(page.locator("#emoji-picker .emoji-section", { hasText: "Recent" })).toBeVisible();
  await expect(page.locator('#emoji-picker .emoji-choice[title=":tada:"]').first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#emoji-wrap")).toBeHidden();
});

test("mobile viewport: the composer picker pins to a fixed top panel with a capped grid", async () => {
  // On a phone the composer-anchored popup lands behind the on-screen keyboard, so
  // placeForMobile() re-pins it to the top of the screen and caps the grid to the
  // visible area. The keyboard itself can't be raised headless, but the pinning and
  // sizing it depends on are verified here. (Runs last; it resizes the viewport.)
  await page.setViewportSize({ width: 390, height: 680 });
  await clearComposer();
  await page.click("#emoji-btn");
  await expect(page.locator("#emoji-wrap")).toBeVisible();
  const shape = await page.evaluate(() => {
    const w = getComputedStyle(document.querySelector("#emoji-wrap"));
    const p = getComputedStyle(document.querySelector("#emoji-picker"));
    return { position: w.position, top: w.top, pickerMaxHeight: p.maxHeight };
  });
  expect(shape.position).toBe("fixed");
  expect(shape.top).toBe("8px");
  expect(shape.pickerMaxHeight).not.toBe("none"); // grid capped to fit above the keyboard
  await page.keyboard.press("Escape");
  await expect(page.locator("#emoji-wrap")).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("mobile viewport: the reaction picker also pins to the fixed top panel", async () => {
  // The reaction picker floats next to the message's reaction button (a different
  // path from the composer toggle), which lands behind the keyboard on a phone the
  // same way — so it gets the same top-panel pinning. The action row is display:none
  // on mobile, but dispatching the click still runs its handler.
  await page.setViewportSize({ width: 390, height: 680 });
  const needle = `mreact-${Date.now()}`;
  await page.evaluate(async ({ id, needle }) => {
    await fetch(`/api/channels/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ content: needle, reply_to_id: null }),
    });
  }, { id: dmId, needle });
  const row = page.locator("#message-list [data-msg-id]", { hasText: needle }).first();
  await expect(row).toBeVisible();
  await row.locator('button.msg-act[title="Add reaction"]').dispatchEvent("click");
  await expect(page.locator("#emoji-wrap")).toBeVisible();
  const shape = await page.evaluate(() => {
    const w = getComputedStyle(document.querySelector("#emoji-wrap"));
    return { position: w.position, top: w.top };
  });
  expect(shape.position).toBe("fixed"); // pinned to the top panel, not floated by the anchor
  expect(shape.top).toBe("8px");
  await page.keyboard.press("Escape");
  await expect(page.locator("#emoji-wrap")).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
});
