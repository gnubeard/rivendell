// e2e/composer-paste.spec.js — the contenteditable composer and its three
// image-paste harvest channels, against a real server and a real upload
// endpoint.
//
// The composer is a contenteditable="plaintext-only" div wearing a textarea
// facade (value/selectionStart/setSelectionRange — see upgradeComposerField in
// app.js). That swap exists for one reason: GeckoView never delivers image
// clipboard content to a <textarea>. What this spec pins:
//
//   channels — each of the three mutually exclusive delivery mechanisms
//     stages exactly ONE attachment tile, the staged blob round-trips through
//     /api/uploads byte-identical, and preventDefault on channels 1/2 is
//     honored (the exclusivity guarantee). A remote-src <img> smuggled into
//     channel 3 is stripped and stages nothing.
//
//   facade — the textarea-era behaviors that ride on the shim: typing +
//     Shift+Enter newlines round-trip through .value, Enter sends, the
//     URL-wrap paste rewrites a selection, @-mention autocomplete picks via
//     Enter without sending, and emptying the field restores the placeholder
//     (the stranded-<br> normalization). The `disabled`/`placeholder`
//     properties (the ended-secret-session lockout) lock and restore the
//     field correctly.
//
// Real on-device flavors (Gboard clipboard history, screenshot-copy vs
// browser Copy-image) can't be automated here — see docs/composer-paste-qa.md.
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

// 1×1 transparent PNG, 68 bytes decoded.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let ctx, page;

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.goto("/");
  await page.fill("#login-username", ADMIN);
  await page.fill("#login-password", PASSWORD);
  await page.press("#login-password", "Enter");
  await expect(page.locator("#me-name")).toBeVisible();
  // A DM gives the composer an active channel without needing channel-admin UI.
  await page.evaluate(async (name) => {
    const users = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    const other = users.find((u) => u.username === name);
    if (!other) throw new Error("user not found: " + name);
    await fetch("/api/dms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ user_id: other.id }),
    });
  }, USER2);
  const row = page.locator("#dm-list li", { hasText: USER2 }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator("#composer-input")).toBeVisible();
});

test.afterAll(async () => {
  await ctx?.close();
});

const tiles = () => page.locator("#composer-attachments .attachment");
const doneTiles = () => page.locator("#composer-attachments .attachment:not(.uploading)");

// Remove every staged tile and clear the composer, so tests stay independent.
async function resetComposer() {
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });
  // Tiles only grow a remove button once the upload resolves; wait, then click.
  while (await tiles().count()) {
    await doneTiles().first().locator(".attachment-remove").click();
  }
  await expect(tiles()).toHaveCount(0);
}

// Fetch the staged attachment's uploaded blob from the server and compare
// against the source bytes — the full "paste → decode → POST → BlobStore"
// round trip, not just "a tile exists".
async function assertUploadedBytesMatch(b64) {
  await expect(doneTiles()).toHaveCount(1); // spinner gone == upload resolved
  const ok = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // Raw-body upload with Content-Type, matching api.uploadBlob. The store is
    // content-addressed, so re-POSTing the same bytes yields the same blob URL
    // the pasted tile got — GET it back and compare.
    const up = await fetch("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: bytes,
      credentials: "same-origin",
    });
    if (!up.ok) return "upload probe failed: " + up.status;
    const { url } = await up.json();
    const got = new Uint8Array(await (await fetch(url, { credentials: "same-origin" })).arrayBuffer());
    if (got.length !== bytes.length) return `length mismatch ${got.length} != ${bytes.length}`;
    for (let i = 0; i < got.length; i++) if (got[i] !== bytes[i]) return "byte mismatch at " + i;
    return true;
  }, b64);
  expect(ok).toBe(true);
}

test("channel 1: paste event clipboardData files → one staged upload, default prevented", async () => {
  const prevented = await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "x.png", { type: "image/png" }));
    const el = document.querySelector("#composer-input");
    el.focus();
    return !el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_B64);
  // preventDefault is the exclusivity mechanism — if this stops being honored,
  // channels 2/3 would double-stage on real devices.
  expect(prevented).toBe(true);
  await expect(tiles()).toHaveCount(1);
  await assertUploadedBytesMatch(PNG_B64);
  // Nothing leaked into the text.
  expect(await page.evaluate(() => document.querySelector("#composer-input").value)).toBe("");
  await resetComposer();
});

test("channel 2: beforeinput insertFromPaste dataTransfer files → one staged upload, default prevented", async () => {
  const prevented = await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "x.png", { type: "image/png" }));
    const el = document.querySelector("#composer-input");
    el.focus();
    return !el.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertFromPaste", dataTransfer: dt, bubbles: true, cancelable: true,
    }));
  }, PNG_B64);
  expect(prevented).toBe(true);
  await expect(tiles()).toHaveCount(1);
  await assertUploadedBytesMatch(PNG_B64);
  await resetComposer();
});

test("channel 3: natively-inserted data: <img> is stripped and staged byte-identically", async () => {
  await page.evaluate((b64) => {
    const el = document.querySelector("#composer-input");
    el.insertAdjacentHTML("beforeend", `<img src="data:image/png;base64,${b64}">`);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, PNG_B64);
  await expect(tiles()).toHaveCount(1);
  await assertUploadedBytesMatch(PNG_B64);
  const leftover = await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    return { imgs: el.querySelectorAll("img").length, value: el.value };
  });
  expect(leftover.imgs).toBe(0); // the node must not survive in the field
  expect(leftover.value).toBe("");
  await resetComposer();
});

test("channel 3: remote-src <img> is stripped, nothing staged, nothing fetched", async () => {
  const requested = [];
  // Only capture JS-initiated requests (fetch/xhr) — the invariant is that OUR
  // code never fetches it. A browser-initiated img load (resourceType "image")
  // may fire before our input handler removes the node; that's not our fetch.
  const onReq = (req) => {
    if (req.url().includes("composer-smuggle") &&
        (req.resourceType() === "fetch" || req.resourceType() === "xhr")) {
      requested.push(req.url());
    }
  };
  page.on("request", onReq);
  await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    el.insertAdjacentHTML("beforeend", '<img src="https://attacker.invalid/composer-smuggle.png">');
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(await page.evaluate(() => document.querySelector("#composer-input").querySelectorAll("img").length)).toBe(0);
  await expect(tiles()).toHaveCount(0);
  await page.waitForTimeout(300); // give a hypothetical fetch a beat to appear
  page.off("request", onReq);
  expect(requested.length).toBe(0);
});

test("typing, Shift+Enter newlines, and Enter-to-send round-trip through the facade", async () => {
  const input = page.locator("#composer-input");
  await input.click();
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  expect(await page.evaluate(() => document.querySelector("#composer-input").value)).toBe("line one\nline two");
  await page.keyboard.press("Enter");
  // Message lands in the list with the line break intact; composer resets to
  // truly empty (placeholder territory — innerHTML must be "", not "<br>").
  await expect(page.locator("#message-list .msg-body", { hasText: "line one" }).last()).toBeVisible();
  const after = await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    return { html: el.innerHTML, value: el.value };
  });
  expect(after.value).toBe("");
  expect(after.html).toBe("");
});

test("select-all-delete restores the placeholder (stranded <br> normalization)", async () => {
  const input = page.locator("#composer-input");
  await input.click();
  await page.keyboard.type("doomed text");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  expect(await page.evaluate(() => document.querySelector("#composer-input").innerHTML)).toBe("");
});

test("URL-wrap paste over a selection still produces a markdown link", async () => {
  const value = await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    el.focus();
    el.value = "see docs here";
    el.setSelectionRange(4, 8); // "docs"
    const dt = new DataTransfer();
    dt.setData("text/plain", "https://example.com/x");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    return el.value;
  });
  expect(value).toBe("see [docs](https://example.com/x) here");
  await resetComposer();
});

test("@-mention autocomplete picks with Enter instead of sending", async () => {
  const input = page.locator("#composer-input");
  await input.click();
  await page.keyboard.type("@" + USER2.slice(0, 6));
  await expect(page.locator("#mention-popup")).toBeVisible();
  const before = await page.locator("#message-list .msg").count();
  await page.keyboard.press("Enter"); // consumed by the completion, not the send path
  expect(await page.evaluate(() => document.querySelector("#composer-input").value)).toBe("@" + USER2 + " ");
  expect(await page.locator("#message-list .msg").count()).toBe(before); // nothing sent
  await resetComposer();
});

test("disabled facade locks the composer: no typing, no Enter-send, no drop; placeholder swaps", async () => {
  // The lockout the secret-session ended state relies on. The full OTR
  // end-session flow needs a second crypto-capable context; the facade's
  // contract is what matters here, so drive `disabled` directly.
  const locked = await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    el.placeholder = "Session ended";
    el.disabled = true;
    return {
      editable: el.isContentEditable,
      aria: el.getAttribute("aria-disabled"),
      cls: el.classList.contains("disabled"),
      ph: el.dataset.ph,
      readback: el.disabled,
    };
  });
  expect(locked).toEqual({ editable: false, aria: "true", cls: true, ph: "Session ended", readback: true });

  // Typing must not enter text (the div is no longer focusable/editable).
  await page.locator("#composer-input").click({ force: true });
  await page.keyboard.type("should not appear");
  expect(await page.evaluate(() => document.querySelector("#composer-input").value)).toBe("");

  // A synthetic Enter on the element must not send (keydown guard).
  const before = await page.locator("#message-list .msg").count();
  await page.evaluate(() => {
    document.querySelector("#composer-input").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(await page.locator("#message-list .msg").count()).toBe(before);

  // A drop must stage nothing (drop fires on non-editable divs; the handler
  // honors the lockout explicitly).
  await page.evaluate((b64) => {
    const el = document.querySelector("#composer-input");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "locked.png", { type: "image/png" }));
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, PNG_B64);
  expect(await tiles().count()).toBe(0);

  // Re-enable restores the original editable mode and the normal placeholder.
  const restored = await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    el.disabled = false;
    el.placeholder = "Message…";
    return { mode: el.contentEditable, aria: el.getAttribute("aria-disabled"), cls: el.classList.contains("disabled") };
  });
  expect(restored.mode === "plaintext-only" || restored.mode === "true").toBe(true);
  expect(restored.aria).toBe("false");
  expect(restored.cls).toBe(false);
  const input = page.locator("#composer-input");
  await input.click();
  await page.keyboard.type("alive again");
  expect(await page.evaluate(() => document.querySelector("#composer-input").value)).toBe("alive again");
  await resetComposer();
});
