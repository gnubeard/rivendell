// e2e/non-admin.spec.js — the member's-eye view.
//
// Nearly every other spec authenticates as the bootstrap ADMIN, so the role-gated
// UI is only ever exercised from the privileged side. That blind spot is exactly
// how a member-only bug hid before (the mobile long-press `activeCh` ReferenceError
// only non-mod members hit). This spec logs in as a plain member (USER2) and pins
// the non-privileged contract:
//   1. a member sees no admin/moderator controls and no channel-management
//      affordances (delete buttons, drag-reorder)
//   2. in a private channel they belong to, a member sees Leave but not Invite
//   3. being removed from a channel drops it from the member's sidebar LIVE
//      (the realtime member.remove path: state.applyEvent drops it, the handler
//      repaints — no reload)
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page, ctx2, page2; // page = ADMIN, page2 = USER2 (member)
let user2Id;
const TS = Date.now();

async function uiLogin(p, username) {
  await p.goto("/");
  await p.fill("#login-username", username);
  await p.fill("#login-password", PASSWORD);
  await p.press("#login-password", "Enter");
  await expect(p.locator("#me-name")).toBeVisible();
}

// makeChannel / addMember / removeMember go through the same public API the UI
// uses, from the ADMIN page's session.
function makeChannel(p, name, isPrivate = false) {
  return p.evaluate(async ({ name, isPrivate }) => {
    const ch = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name, topic: "", is_private: isPrivate }),
    }).then((r) => r.json());
    return ch.id;
  }, { name, isPrivate });
}

function addMember(p, channelId, userId) {
  return p.evaluate(({ channelId, userId }) =>
    fetch(`/api/channels/${channelId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ user_id: userId }),
    }).then((r) => r.ok), { channelId, userId });
}

function removeMember(p, channelId, userId) {
  return p.evaluate(({ channelId, userId }) =>
    fetch(`/api/channels/${channelId}/members/${userId}`, {
      method: "DELETE",
      credentials: "same-origin",
    }).then((r) => r.ok), { channelId, userId });
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await uiLogin(page, ADMIN);

  ctx2 = await browser.newContext();
  page2 = await ctx2.newPage();
  await uiLogin(page2, USER2);

  user2Id = await page.evaluate(async (name) => {
    const us = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    return (us.find((u) => u.username === name) || {}).id;
  }, USER2);
  expect(user2Id, "resolved USER2's id from the roster").toBeTruthy();
});

test.afterAll(async () => {
  await ctx?.close();
  await ctx2?.close();
});

test("a plain member sees no admin/moderator controls or channel management", async () => {
  // The gear (admin panel) and the new-channel button are admin/mod only.
  await expect(page2.locator("#admin-btn")).toBeHidden();
  await expect(page2.locator("#new-channel-btn")).toBeHidden();
  // The sidebar isn't drag-reorderable and exposes no delete affordance (the
  // plain .ch-ctl mute toggle is everyone's; .ch-ctl.danger delete is mod only).
  await expect(page2.locator("#channel-list")).not.toHaveClass(/reorderable/);
  await expect(page2.locator("#channel-list .ch-ctl.danger")).toHaveCount(0);
});

test("a member of a private channel sees Leave but not Invite", async () => {
  const priv = await makeChannel(page, `naleave${TS}`, true);
  expect(await addMember(page, priv, user2Id)).toBeTruthy();

  // Reload so the just-added private channel is in USER2's sidebar, then open it.
  await page2.reload();
  await expect(page2.locator("#me-name")).toBeVisible();
  await page2.click(`#channel-list li[data-ch-id="${priv}"]`);
  await expect(page2.locator(`#channel-list li[data-ch-id="${priv}"]`)).toHaveClass(/active/);

  // A member can leave, but cannot invite (moderator+).
  await expect(page2.locator("#leave-btn")).toBeVisible();
  await expect(page2.locator("#invite-btn")).toBeHidden();
  // Sanity: the admin viewing the same channel DOES get the invite button.
  await page.click(`#channel-list li[data-ch-id="${priv}"]`);
  await expect(page.locator("#invite-btn")).toBeVisible();
});

test("being removed from a channel drops it from the member's sidebar live", async () => {
  const priv = await makeChannel(page, `naremove${TS}`, true);
  expect(await addMember(page, priv, user2Id)).toBeTruthy();

  await page2.reload();
  await expect(page2.locator("#me-name")).toBeVisible();
  const row = page2.locator(`#channel-list li[data-ch-id="${priv}"]`);
  await expect(row).toBeVisible();

  // Admin removes USER2; the row must vanish on USER2's page with no reload —
  // the live member.remove path (applyEvent drops the channel, handler repaints).
  expect(await removeMember(page, priv, user2Id)).toBeTruthy();
  await expect(row).toHaveCount(0);
});
