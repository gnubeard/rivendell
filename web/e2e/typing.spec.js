// e2e/typing.spec.js — the typing indicator's client-side TTL (the phantom-typer fix).
//
// The server clears a typer with a 2s AfterFunc that broadcasts active:false. But that
// frame is droppable: ws.js discards frames while the socket is closed, and reconnect
// re-syncs rosters/channels/messages but NOT typing state. So a receiver that misses
// active:false (socket drop / backgrounded tab) would show a phantom typer forever.
//
// The fix is delivery-independent: each typing entry stores a refresh timestamp and the
// renderer treats anything older than TYPING_TTL_MS (4000ms) as cleared, re-armed by a
// one-shot timer so it clears with no further events. Plus two latency paths: message.new
// clears the sender instantly, and a peer going offline is swept across all channels.
//
// To pin the TTL we reproduce the missed-frame condition directly: routeWebSocket on the
// RECEIVER proxies its socket to the real server but can DROP the typing active:false
// frame — so the only thing that can clear its indicator is the client TTL (B) / the
// message.new clear (C), never the server's stop frame.
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

const TS = Date.now();
let ctxA, ctxB, pageA, pageB, channelId;

// Flip true to make the receiver (pageA) drop the server's typing active:false frame,
// simulating the missed-frame condition. The routeWebSocket handler reads it per message.
let dropTypingStop = false;

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
    await fetch(`/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ content, reply_to_id: null }),
    });
  }, { channelId, content });
}

async function openChannel(p, channelId) {
  await p.click(`#channel-list li[data-ch-id="${channelId}"]`);
  await expect(p.locator(`#channel-list li[data-ch-id="${channelId}"]`)).toHaveClass(/active/);
}

// startTyping makes pageB emit a single real typing frame for the active channel — a
// keystroke in the composer is the production emit path (sendWS over the input handler).
async function startTyping(p) {
  await p.locator("#composer-input").click();
  await p.keyboard.type("x"); // one keystroke ⇒ one active:true (then the typer stops)
}

const indicator = (p) => p.locator("#typing-indicator");

test.beforeAll(async ({ browser }) => {
  // Receiver: install the WS proxy BEFORE the page connects so it can drop active:false.
  ctxA = await browser.newContext();
  pageA = await ctxA.newPage();
  await pageA.routeWebSocket("**/api/ws", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m)); // page → server, verbatim
    server.onMessage((m) => {            // server → page, optionally drop the stop frame
      if (dropTypingStop && typeof m === "string") {
        try {
          const e = JSON.parse(m);
          if (e.type === "typing.update" && e.payload && e.payload.active === false) return;
        } catch { /* not a frame we filter */ }
      }
      ws.send(m);
    });
  });
  await uiLogin(pageA, ADMIN);

  // Typer.
  ctxB = await browser.newContext();
  pageB = await ctxB.newPage();
  await uiLogin(pageB, USER2);

  // Create AFTER both are connected so each gets channel.new live; both open it.
  channelId = await makeChannel(pageA, `typing-${TS}`);
  await openChannel(pageA, channelId);
  await openChannel(pageB, channelId);
});

test.afterEach(async () => {
  // Stop dropping and let the indicator settle to hidden before the next test (the
  // 6s budget covers either reset path: the server's 2s stop frame or the 4s TTL).
  dropTypingStop = false;
  if (pageA) await expect(indicator(pageA)).toBeHidden({ timeout: 6000 });
});

test.afterAll(async () => {
  await ctxA?.close();
  await ctxB?.close();
});

test("a peer typing shows the indicator on the receiver", async () => {
  await startTyping(pageB);
  await expect(indicator(pageA)).toBeVisible();
  await expect(indicator(pageA)).toContainText("is typing");
});

test("the indicator clears via the client TTL when the active:false frame is missed", async () => {
  dropTypingStop = true; // the receiver will never get the server's stop frame
  await startTyping(pageB);
  await expect(indicator(pageA)).toBeVisible();
  // Nothing else can clear it: the stop frame is dropped, no message lands, the typer
  // stays online. Only the client TTL (≈4s) ages the stale entry out — so this hiding
  // proves the fix. (Generous upper bound; the timer fires ~4s after the last frame.)
  await expect(indicator(pageA)).toBeHidden({ timeout: 6000 });
});

test("the indicator clears immediately when the typer's message lands", async () => {
  dropTypingStop = true; // so the fast clear can only be message.new, never the stop frame
  await startTyping(pageB);
  await expect(indicator(pageA)).toBeVisible();
  await postMessage(pageB, channelId, `sent ${TS}`);
  // Well under the 4s TTL ⇒ it was the message.new clear, not the timer.
  await expect(indicator(pageA)).toBeHidden({ timeout: 2500 });
});
