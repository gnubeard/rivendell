// e2e/non-admin.spec.js — the non-privileged (member and moderator) views.
//
// Nearly every other spec authenticates as the bootstrap ADMIN, so role-gated UI
// is only ever exercised from the privileged side. That blind spot is exactly how
// a member-only bug hid before (the mobile long-press `activeCh` ReferenceError
// only non-mod members hit). This spec drives the gating from below.
//
// USER2 plays both roles: the member block runs first (USER2 is a plain member),
// then the moderator block promotes USER2 (PUT role) and reloads, asserting the
// member-vs-moderator-vs-admin boundary; afterAll demotes USER2 back to member so
// later specs (workers:1, serial) still see a plain member. Contracts pinned:
//   member    1. no admin/mod controls, no channel-management affordances
//             2. in a private channel they belong to: Leave but not Invite
//             3. being removed from a channel drops it from the sidebar LIVE
//             4. can leave a private channel themselves (confirm → row gone)
//   moderator 5. gets channel management (new-channel, reorder, delete) but NOT
//                the admin panel
//             6. can invite to a private channel they belong to
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page, ctx2, page2; // page = ADMIN, page2 = USER2
let user2Id;
const TS = Date.now();

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

// makeChannel / addMember / removeMember / setRole go through the same public API
// the UI uses, from the ADMIN page's session.
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

function setRole(p, userId, role) {
  return p.evaluate(({ userId, role }) =>
    fetch(`/api/admin/users/${userId}/role`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ role }),
    }).then((r) => r.ok), { userId, role });
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

test.describe("a plain member", () => {
  test("sees no admin/moderator controls or channel management", async () => {
    // The gear (admin panel) and the new-channel button are admin/mod only.
    await expect(page2.locator("#admin-btn")).toBeHidden();
    await expect(page2.locator("#new-channel-btn")).toBeHidden();
    // The sidebar isn't drag-reorderable and exposes no delete affordance (the
    // plain .ch-ctl mute toggle is everyone's; .ch-ctl.danger delete is mod only).
    await expect(page2.locator("#channel-list")).not.toHaveClass(/reorderable/);
    await expect(page2.locator("#channel-list .ch-ctl.danger")).toHaveCount(0);
  });

  test("in a private channel they belong to, sees Leave but not Invite", async () => {
    const priv = await makeChannel(page, `naleave${TS}`, true);
    expect(await addMember(page, priv, user2Id)).toBeTruthy();

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

  test("being removed from a channel drops it from the sidebar live", async () => {
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

  test("can leave a private channel themselves (confirm → row gone)", async () => {
    const priv = await makeChannel(page, `naselfleave${TS}`, true);
    expect(await addMember(page, priv, user2Id)).toBeTruthy();

    await page2.reload();
    await expect(page2.locator("#me-name")).toBeVisible();
    const row = page2.locator(`#channel-list li[data-ch-id="${priv}"]`);
    await expect(row).toBeVisible();
    await row.click();

    // leaveActiveChannel asks a non-admin to confirm; accept it, then the channel
    // disappears from their own sidebar (local removeChannel + re-point).
    page2.once("dialog", (d) => d.accept());
    await page2.click("#leave-btn");
    await expect(row).toHaveCount(0);
  });
});

test.describe("a moderator", () => {
  test.beforeAll(async () => {
    expect(await setRole(page, user2Id, "moderator")).toBeTruthy();
    await page2.reload(); // pick up the new role
    await expect(page2.locator("#me-name")).toBeVisible();
  });

  test.afterAll(async () => {
    await setRole(page, user2Id, "member"); // restore for later specs
  });

  test("gets channel management but not the admin panel", async () => {
    // new-channel is moderator+, the admin gear is admin-only — this is the
    // moderator-vs-admin boundary.
    await expect(page2.locator("#new-channel-btn")).toBeVisible();
    await expect(page2.locator("#admin-btn")).toBeHidden();
    // Moderators can reorder, and get a delete affordance on channels (rendered
    // for mods, count 0 for members above; it's hover-revealed, so assert it
    // exists rather than is visible).
    await expect(page2.locator("#channel-list")).toHaveClass(/reorderable/);
    expect(await page2.locator("#channel-list .ch-ctl.danger").count()).toBeGreaterThan(0);
  });

  test("can invite to a private channel they belong to", async () => {
    const priv = await makeChannel(page, `namod${TS}`, true);
    expect(await addMember(page, priv, user2Id)).toBeTruthy(); // mods aren't auto-members of private channels

    await page2.reload();
    await expect(page2.locator("#me-name")).toBeVisible();
    await page2.click(`#channel-list li[data-ch-id="${priv}"]`);
    await expect(page2.locator(`#channel-list li[data-ch-id="${priv}"]`)).toHaveClass(/active/);

    // Invite is moderator+, so it's now visible to USER2 (hidden when they were a member).
    await expect(page2.locator("#invite-btn")).toBeVisible();
  });
});
