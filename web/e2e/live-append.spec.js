// e2e/live-append.spec.js — the incremental message-pane paths in app.js.
//
// renderMessages() rebuilds the whole pane (wipes #message-list and re-runs
// formatMessage on every loaded row). app.js avoids that for the common live
// events by patching the ONE row an event touched: message.new appends a single
// row at the tail (appendMessageRow), reaction.update / message.update swap a row
// in place (patchMessageRow). The user-visible PROPERTY that proves it's not a full
// rebuild is that an active text selection in the pane SURVIVES an incoming event —
// a full innerHTML wipe would clear it. This spec pins:
//   1. a message from another user appears live at the tail
//   2. a text selection survives that incoming message (append, not rebuild)
//   3. a text selection survives a reaction landing on a visible message (patch)
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

const TS = Date.now();
let ctxA, ctxB, pageA, pageB, channelId, firstId;

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

function react(p, messageId, emoji) {
  return p.evaluate(async ({ messageId, emoji }) => {
    await fetch(`/api/messages/${messageId}/reactions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ emoji }),
    });
  }, { messageId, emoji });
}

async function openChannel(p, channelId) {
  await p.click(`#channel-list li[data-ch-id="${channelId}"]`);
  await expect(p.locator(`#channel-list li[data-ch-id="${channelId}"]`)).toHaveClass(/active/);
}

const row = (p, id) => p.locator(`#message-list [data-msg-id="${id}"]`);

// selectRowText puts the browser selection over a rendered row's body text and
// returns what got selected, so a later read can confirm it survived a repaint.
function selectRowText(p, id) {
  return p.evaluate((id) => {
    const body = document.querySelector(`#message-list [data-msg-id="${id}"] .msg-body`);
    const range = document.createRange();
    range.selectNodeContents(body);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString();
  }, id);
}

const currentSelection = (p) => p.evaluate(() => window.getSelection().toString());

test.beforeAll(async ({ browser }) => {
  ctxA = await browser.newContext();
  pageA = await ctxA.newPage();
  await uiLogin(pageA, ADMIN);

  ctxB = await browser.newContext();
  pageB = await ctxB.newPage();
  await uiLogin(pageB, USER2);

  // Create AFTER both are connected so each gets the channel.new live, then seed one
  // message so there's body text to select. Both open the channel at the live tail.
  channelId = await makeChannel(pageA, `live-${TS}`);
  firstId = await postMessage(pageA, channelId, `anchor message ${TS}`);
  await openChannel(pageA, channelId);
  await openChannel(pageB, channelId);
  await expect(row(pageA, firstId)).toBeVisible();
  await expect(row(pageB, firstId)).toBeVisible();
});

test.afterAll(async () => {
  await ctxA?.close();
  await ctxB?.close();
});

test("a message from another user appends live at the tail", async () => {
  const id = await postMessage(pageB, channelId, `live one ${TS}`);
  await expect(row(pageA, id)).toBeVisible();
  await expect(row(pageA, id)).toContainText(`live one ${TS}`);
});

test("an active text selection survives an incoming message (append, not full rebuild)", async () => {
  const picked = await selectRowText(pageA, firstId);
  expect(picked).toContain(`anchor message ${TS}`);

  const id = await postMessage(pageB, channelId, `live two ${TS}`);
  await expect(row(pageA, id)).toBeVisible(); // the append landed

  // A full renderMessages() would have wiped #message-list and the selection with it.
  expect(await currentSelection(pageA)).toContain(`anchor message ${TS}`);
});

test("an active text selection survives a reaction on a visible message (patch, not full rebuild)", async () => {
  const picked = await selectRowText(pageA, firstId);
  expect(picked).toContain(`anchor message ${TS}`);

  // USER2 reacts to a DIFFERENT message than the one selected, so the patch swaps a
  // sibling row while the selection's row is untouched.
  const target = await postMessage(pageA, channelId, `reactable ${TS}`);
  await expect(row(pageA, target)).toBeVisible();
  await selectRowText(pageA, firstId); // re-select (the append above ran)
  await react(pageB, target, "👍");

  await expect(row(pageA, target).locator(".reaction")).toContainText("1");
  expect(await currentSelection(pageA)).toContain(`anchor message ${TS}`);
});
