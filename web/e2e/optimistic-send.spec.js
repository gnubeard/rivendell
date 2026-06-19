// e2e/optimistic-send.spec.js — optimistic local echo for sending a message.
//
// On Enter, app.js paints the message at the live tail immediately as a dimmed
// `.msg.pending` row (showOptimisticSend), BEFORE the server round-trips. The send
// handler reconciles the dimmed row into the real one from the POST RESPONSE
// (reconcileOptimistic) — exactly one copy, no jump — so the broadcast message.new
// echo is only an idempotent backstop. A failed POST rolls the optimistic row back and
// restores the composer text for a retry. This spec pins:
//   1. a sent message ends up as a single, non-pending row (reconciled, not doubled)
//   2. a failed send shows the pending row, then rolls it back + restores the composer
//   3. another user's message arriving DURING a pending send isn't mis-attributed to
//      you — it slots ABOVE your pending row, grouped under its own author, not below
//      yours (the optimistic-row-desyncs-grouping bug)
//   4. a send still reconciles even when its own message.new echo is dropped — proving
//      reconcile is driven by the POST response, not the echo (the echo-lost fix)
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

const TS = Date.now();
const SENDS = /\/api\/channels\/\d+\/messages$/;
let ctx, page, channelId;
let ctxB, pageB; // a second user, to post cross-user messages mid-send

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

async function openChannel(p, channelId) {
  await p.click(`#channel-list li[data-ch-id="${channelId}"]`);
  await expect(p.locator(`#channel-list li[data-ch-id="${channelId}"]`)).toHaveClass(/active/);
}

// postMessage sends as another user via fetch (no optimistic UI), returning the id.
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

// rowOrder returns the rendered rows top-to-bottom (pending rows carry a negative
// data-msg-id, so .msg[data-msg-id] captures them too), enough to assert ordering,
// grouping, and which author a row visually attributes to.
function rowOrder(p) {
  return p.evaluate(() =>
    [...document.querySelectorAll("#message-list .msg[data-msg-id]")].map((el) => ({
      pending: el.classList.contains("pending"),
      grouped: el.classList.contains("grouped"),
      text: el.querySelector(".msg-body")?.textContent || "",
    })));
}

// typeAndSend focuses the contenteditable composer, types, and presses Enter —
// matching composer-paste.spec.js's keyboard-driven convention.
async function typeAndSend(p, text) {
  await p.locator("#composer-input").click();
  await p.keyboard.type(text);
  await p.keyboard.press("Enter");
}

const msg = (p, text) => p.locator("#message-list .msg", { hasText: text });

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);

  ctxB = await browser.newContext();
  pageB = await ctxB.newPage();
  await uiLogin(pageB, USER2);

  channelId = await makeChannel(page, `optimistic-${TS}`);
  await openChannel(page, channelId);
  await openChannel(pageB, channelId);
});

test.afterAll(async () => { await ctx?.close(); await ctxB?.close(); });

test("a sent message reconciles to a single, non-pending row", async () => {
  const txt = `optimistic happy ${TS}`;
  await typeAndSend(page, txt);

  // Shows up (optimistically and/or via the echo), and the echo reconciles it: the
  // pending class clears and there is exactly ONE copy (no optimistic + echo dupe).
  await expect(msg(page, txt)).toHaveCount(1);
  await expect(page.locator("#message-list .msg.pending", { hasText: txt })).toHaveCount(0);
  await expect(msg(page, txt)).toHaveCount(1);
});

test("a send with trailing whitespace still reconciles to a single row", async () => {
  // The server TrimRight()s trailing space/newlines before storing+echoing, while
  // the optimistic row is painted from the raw composer text. If the send path
  // doesn't mirror that trim, reconcileOptimistic's exact-content match misses and
  // the echo gets appended alongside a stuck pending row (a duplicate). Type a
  // trailing space to pin that the two agree.
  const txt = `optimistic trailing ${TS}`;
  await page.locator("#composer-input").click();
  await page.keyboard.type(txt + " ");
  await page.keyboard.press("Enter");

  await expect(msg(page, txt)).toHaveCount(1);
  await expect(page.locator("#message-list .msg.pending", { hasText: txt })).toHaveCount(0);
});

test("a send reconciles from its POST response even when the message.new echo is dropped", async () => {
  // Reconcile is driven by the POST response, not the broadcast echo (see
  // showOptimisticSend's header). Prove it by routing a sender's socket to DROP its own
  // message.new echo entirely, then asserting the dimmed row still reconciles to one
  // real row. The earlier echo-dependent design would strand the pending row forever.
  // Own context so the routeWebSocket proxy doesn't touch the shared `page` tests; same
  // user is fine (the app allows multiple connections per user).
  const marker = `echo-lost ${TS}`;
  let dropMyEcho = true;
  const ctxC = await ctx.browser().newContext();
  const pageC = await ctxC.newPage();
  await pageC.routeWebSocket("**/api/ws", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m)); // page → server, verbatim
    server.onMessage((m) => {            // server → page, optionally drop my own echo
      if (dropMyEcho && typeof m === "string") {
        try {
          const e = JSON.parse(m);
          if (e.type === "message.new" && e.payload && e.payload.content === marker) return;
        } catch { /* not a frame we filter */ }
      }
      ws.send(m);
    });
  });
  await uiLogin(pageC, ADMIN);
  await openChannel(pageC, channelId);

  await typeAndSend(pageC, marker);

  // No message.new echo will reach pageC for this send; reconcile-from-POST must still
  // clear the dimmed state and leave exactly one real row (not a stuck pending dupe).
  await expect(pageC.locator("#message-list .msg", { hasText: marker })).toHaveCount(1);
  await expect(pageC.locator("#message-list .msg.pending", { hasText: marker })).toHaveCount(0);
  // And it really was sent: the other admin session (normal echo) shows it once.
  await expect(msg(page, marker)).toHaveCount(1);

  dropMyEcho = false;
  await ctxC.close();
});

test("another user's message during a pending send is not mis-attributed to you", async () => {
  // B needs a prior message at the tail so their NEXT message would group under it —
  // the precondition for the bug (a grouped row renders avatarless/headerless).
  const bPrev = `crossuser B-prev ${TS}`;
  await postMessage(pageB, channelId, bPrev);
  await expect(msg(page, bPrev)).toHaveCount(1); // A sees B's prior message live

  // Hold A's POST so the dimmed optimistic row stays on screen for the whole window.
  // (Continue, not abort — it eventually commits and reconciles.)
  await page.route(SENDS, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise((r) => setTimeout(r, 1500));
    return route.continue();
  });

  const aText = `crossuser A-pending ${TS}`;
  await typeAndSend(page, aText);
  await expect(page.locator("#message-list .msg.pending", { hasText: aText })).toBeVisible();

  // While A's send is in flight, B posts a message that would group under B-prev.
  const bNew = `crossuser B-new ${TS}`;
  await postMessage(pageB, channelId, bNew);
  await expect(msg(page, bNew)).toHaveCount(1); // landed on A's pane

  // The bug: B-new appended at the DOM tail (BELOW A's pending row) and grouped
  // avatarless under it — looking like A sent it. The fix slots B-new ABOVE the
  // pending row, directly under B-prev, so it attributes to its real author.
  const order = await rowOrder(page);
  const iPrev = order.findIndex((r) => r.text.includes(bPrev));
  const iNew = order.findIndex((r) => r.text.includes(bNew));
  const iPending = order.findIndex((r) => r.pending && r.text.includes(aText));
  expect(iPrev).toBeGreaterThanOrEqual(0);
  expect(iPending).toBeGreaterThanOrEqual(0);
  expect(iNew).toBe(iPrev + 1);        // B-new sits directly under B-prev …
  expect(iNew).toBeLessThan(iPending); // … and ABOVE A's pending row, never below it

  // Let A's held POST through; it reconciles to a single real row that stays BELOW
  // B-new (B-new committed first → lower id → array-sorted above A), not scrambled.
  await expect(page.locator("#message-list .msg.pending", { hasText: aText })).toHaveCount(0);
  await expect(msg(page, aText)).toHaveCount(1);
  const after = await rowOrder(page);
  const jNew = after.findIndex((r) => r.text.includes(bNew));
  const jA = after.findIndex((r) => r.text.includes(aText));
  expect(jNew).toBeLessThan(jA);

  await page.unroute(SENDS);
});

test("a failed send shows the pending row, then rolls it back and restores the composer", async () => {
  const txt = `optimistic fail ${TS}`;

  // Hold the POST briefly, then abort it: the server never processes the send (no
  // WS echo), so the optimistic row stays pending and observable until the abort
  // rejects api.sendMessage and the catch rolls it back.
  await page.route(SENDS, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise((r) => setTimeout(r, 700));
    return route.abort();
  });
  page.once("dialog", (d) => d.accept()); // the failure path alert()s

  await typeAndSend(page, txt);

  // Optimistic row is visible and dimmed while the (doomed) request is in flight.
  await expect(page.locator("#message-list .msg.pending", { hasText: txt })).toBeVisible();

  // After the abort: the row is rolled back and the composer text is restored.
  await expect(msg(page, txt)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.querySelector("#composer-input").value)).toBe(txt);

  await page.unroute(SENDS);
});
