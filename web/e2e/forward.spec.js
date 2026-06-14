// e2e/forward.spec.js — end-to-end message forwarding against a real server.
//
// This spec is written BEFORE the planned app.js → forward.js extraction (the
// search.js method): it must pass green against the un-extracted code first, so a
// later red means the extraction regressed — not that the spec was wrong. It pins
// the user-visible contract the forward module must keep:
//   1. forwarding a CHANNEL message sends a permalink, which lands in the target
//      as an inline .msg-embed card; clicking the card jumps to the original
//   2. forwarding a DM message sends a quoted "*Forwarded:*" copy instead — a DM
//      permalink only resolves for that DM's two members, so it must NOT embed
//   3. the filter box narrows the target list by channel/person name
//
// forwardBody (permalink-vs-quoted) and the canSee audience predicate are the pure
// core slated for node:test once extracted; this e2e nets the DOM-bound modal,
// send, and jump-to-where-it-landed behavior that a unit test can't reach.
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD, BASE } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page;
// Unique per run so a reused e2e database never collides with prior fixtures.
const TS = Date.now();

async function uiLogin(p, username) {
  await p.goto("/");
  await p.fill("#login-username", username);
  await p.fill("#login-password", PASSWORD);
  await p.press("#login-password", "Enter");
  await expect(p.locator("#me-name")).toBeVisible();
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

// makeDM opens (or reopens) the DM with otherUsername and returns its channel id.
function makeDM(p, otherUsername) {
  return p.evaluate(async (name) => {
    const users = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    const other = users.find((u) => u.username === name);
    if (!other) throw new Error("user not found: " + name);
    const dm = await fetch("/api/dms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ user_id: other.id }),
    }).then((r) => r.json());
    return dm.id;
  }, otherUsername);
}

// postMessage posts content into any channel (incl. a DM) and returns the new id.
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

// openChannel clicks a public channel in the sidebar and waits for it to activate.
async function openChannel(p, channelId) {
  await p.click(`#channel-list li[data-ch-id="${channelId}"]`);
  await expect(p.locator(`#channel-list li[data-ch-id="${channelId}"]`)).toHaveClass(/active/);
}

// openForward hovers a message row (the action bar is hover-revealed) and clicks
// its ↗ Forward button, then waits for the modal.
async function openForward(p, msgId) {
  const row = p.locator(`#message-list [data-msg-id="${msgId}"]`).first();
  await row.hover();
  await row.getByTitle("Forward to another channel").click();
  await expect(p.locator("#forward-modal")).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);
});

test.afterAll(async () => {
  await ctx?.close();
});

test("forwarding a channel message lands a permalink embed in the target and jumps there", async () => {
  const src = await makeChannel(page, `fwdsrc${TS}`);
  const dst = await makeChannel(page, `fwddst${TS}`);
  const srcMsgId = await postMessage(page, src, `forward me ${TS}`);

  await openChannel(page, src);
  await openForward(page, srcMsgId);

  // Pick the destination channel out of the list.
  await page.fill("#forward-filter", `fwddst${TS}`);
  await page.click(`#forward-list li:has-text("#fwddst${TS}")`);

  // Forward "follows the message" — we land in the destination channel...
  await expect(page.locator(`#channel-list li[data-ch-id="${dst}"]`)).toHaveClass(/active/);
  await expect(page.locator("#forward-modal")).toBeHidden();

  // ...where the permalink renders as an embed of the original message.
  const embed = page.locator("#message-list .msg-embed");
  await expect(embed).toBeVisible();
  await expect(embed.locator(".msg-embed-body")).toContainText(`forward me ${TS}`);

  // Clicking the embed jumps back to the original in the source channel.
  await embed.click();
  await expect(page.locator(`#channel-list li[data-ch-id="${src}"]`)).toHaveClass(/active/);
  await expect(page.locator(`#message-list :text("forward me ${TS}")`).first()).toBeVisible();
});

test("forwarding a DM message sends a quoted copy, not a (dead) permalink embed", async () => {
  const dm = await makeDM(page, USER2);
  const dst = await makeChannel(page, `fwddmdst${TS}`);
  const dmMsgId = await postMessage(page, dm, `dm secret ${TS}`);

  // Open the DM from the sidebar (DM rows select by name, no data-ch-id).
  await page.locator("#dm-list li", { hasText: USER2 }).first().click();
  await openForward(page, dmMsgId);

  await page.fill("#forward-filter", `fwddmdst${TS}`);
  await page.click(`#forward-list li:has-text("#fwddmdst${TS}")`);

  await expect(page.locator(`#channel-list li[data-ch-id="${dst}"]`)).toHaveClass(/active/);

  // The forwarded copy is a quoted "Forwarded:" text — NOT an embed card (a DM
  // permalink wouldn't resolve for anyone but the two DM members).
  const body = page.locator("#message-list .msg-body", { hasText: `dm secret ${TS}` });
  await expect(body).toBeVisible();
  await expect(body).toContainText("Forwarded:");
  await expect(page.locator("#message-list .msg-embed")).toHaveCount(0);
});

test("the forward filter narrows the target list by name", async () => {
  // Two distinctly-named channels; filtering to one must hide the other.
  const keep = await makeChannel(page, `fwdkeep${TS}`);
  const hide = await makeChannel(page, `fwdhide${TS}`);
  const homeMsgId = await postMessage(page, keep, `filter test ${TS}`);

  await openChannel(page, keep);
  await openForward(page, homeMsgId);

  // Unfiltered: both are present.
  await expect(page.locator(`#forward-list li:has-text("#fwdkeep${TS}")`)).toBeVisible();
  await expect(page.locator(`#forward-list li:has-text("#fwdhide${TS}")`)).toBeVisible();

  // Filtered to "keep": only the match survives.
  await page.fill("#forward-filter", `fwdkeep${TS}`);
  await expect(page.locator(`#forward-list li:has-text("#fwdkeep${TS}")`)).toBeVisible();
  await expect(page.locator(`#forward-list li:has-text("#fwdhide${TS}")`)).toHaveCount(0);

  await page.click("#forward-close");
  await expect(page.locator("#forward-modal")).toBeHidden();
  void hide;
});
