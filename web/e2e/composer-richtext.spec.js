// e2e/composer-richtext.spec.js — live markdown decoration in the composer
// (composer-richtext.js), against a real browser engine.
//
// The decorate() string transform is unit-tested under Node. What only a real
// engine reproduces — and so is pinned here — is the DOM behavior:
//
//   - a completed **bold** / *italic* / `code` pair lights up live, the markers
//     stay in the text as dimmed .md-mk spans (markers are NOT hidden);
//   - the value (what gets sent) round-trips byte-identical to the markdown
//     source, through the contenteditable + facade;
//   - the caret does NOT jump on the innerHTML rewrite — text typed after a
//     decorated run lands after it, in order;
//   - Ctrl-B / Ctrl-I wrap the selection in **/* and the browser's native
//     bold/italic execCommand is suppressed (no <b>/<i> smuggled into value).
import { test, expect } from "@playwright/test";
import { ADMIN, USER2, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

let ctx, page;

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.goto("/");
  await page.fill("#login-username", ADMIN);
  await page.fill("#login-password", PASSWORD);
  await page.press("#login-password", "Enter");
  await expect(page.locator("#me-name")).toBeVisible();
  // A DM gives the composer an active channel without channel-admin UI.
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

test.afterAll(async () => { await ctx.close(); });

const input = () => page.locator("#composer-input");
const valueOf = () => page.evaluate(() => document.querySelector("#composer-input").value);

async function clearComposer() {
  await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    el.focus();
    el.value = "";
  });
}

test.beforeEach(clearComposer);

test("typing a completed **bold** pair decorates the run and keeps the markers", async () => {
  await input().click();
  await page.keyboard.type("a **bold** b");
  // The run is bold; both ** markers survive as dimmed marker spans.
  const strong = input().locator(".md-strong");
  await expect(strong).toHaveCount(1);
  await expect(strong).toContainText("bold");
  await expect(input().locator(".md-mk")).toHaveCount(2);
  // The value sent over the wire is byte-identical to the markdown source.
  expect(await valueOf()).toBe("a **bold** b");
});

test("italic and inline code each decorate; markers preserved", async () => {
  await input().click();
  await page.keyboard.type("*it* and `code`");
  await expect(input().locator(".md-em")).toHaveCount(1);
  await expect(input().locator(".md-code")).toHaveCount(1);
  expect(await valueOf()).toBe("*it* and `code`");
});

test("caret does not jump on the rewrite — text typed after a bold run lands after it", async () => {
  await input().click();
  await page.keyboard.type("**a**");      // completes a bold pair (triggers a rewrite)
  await page.keyboard.type("tail");        // must append, not jump to start
  expect(await valueOf()).toBe("**a**tail");
});

test("Ctrl-B wraps the selection in ** and shows it bold (no native <b> injected)", async () => {
  await input().click();
  await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    el.value = "make bold";
    el.setSelectionRange(5, 9); // "bold"
  });
  await page.keyboard.press("ControlOrMeta+b");
  expect(await valueOf()).toBe("make **bold**");
  await expect(input().locator(".md-strong")).toContainText("bold");
  // value is pure markdown — the native execCommand bold (which would inject a
  // <b>/<strong> element the facade would read back into .value) was suppressed.
  expect(await valueOf()).not.toContain("<");
});

test("Ctrl-I on a collapsed caret inserts the * markers and parks the caret between them", async () => {
  await input().click();
  await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    el.value = "";
    el.setSelectionRange(0, 0);
  });
  await page.keyboard.press("ControlOrMeta+i");
  await page.keyboard.type("x");           // typed between the inserted * *
  expect(await valueOf()).toBe("*x*");
  await expect(input().locator(".md-em")).toContainText("x");
});

test("Ctrl-B again on the same selection unwraps (toggle)", async () => {
  await input().click();
  await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    el.value = "**bold**";
    el.setSelectionRange(2, 6); // the inner "bold", markers just outside
  });
  await page.keyboard.press("ControlOrMeta+b");
  expect(await valueOf()).toBe("bold");
});

test("the preferences toggle disables decoration (strips spans) and re-enables it", async () => {
  await input().click();
  await page.keyboard.type("**bold**");
  await expect(input().locator(".md-strong")).toHaveCount(1);

  // Open the profile modal and uncheck "Live markdown formatting".
  await page.click("#me-name");
  await expect(page.locator("#richtext-enable")).toBeVisible();
  await expect(page.locator("#richtext-enable")).toBeChecked(); // defaults on
  await page.uncheck("#richtext-enable"); // onchange strips decoration immediately
  await page.keyboard.press("Escape");    // close the profile modal

  // Decoration is gone but the text (markers and all) is intact.
  await expect(input().locator(".md-strong")).toHaveCount(0);
  expect(await valueOf()).toBe("**bold**");

  // Ctrl-B STILL edits the markdown source while decoration is off — the toggle
  // is orthogonal to the shortcut — it just doesn't render styled.
  await input().click();
  await page.evaluate(() => { const el = document.querySelector("#composer-input"); el.value = "x"; el.setSelectionRange(0, 1); });
  await page.keyboard.press("ControlOrMeta+b");
  expect(await valueOf()).toBe("**x**");
  await expect(input().locator(".md-strong")).toHaveCount(0); // off → no decoration

  // Re-enable → the existing content decorates again.
  await page.click("#me-name");
  await page.check("#richtext-enable");
  await page.keyboard.press("Escape");
  await expect(input().locator(".md-strong")).toHaveCount(1);
  expect(await valueOf()).toBe("**x**");

  // Leave the setting on for any later run (localStorage persists in the context).
});

test("undo/redo: a typing run undoes as one step; Ctrl-B is its own step (Cmd-Z on macOS too)", async () => {
  // Send once to get a clean undo baseline — a send calls resetHistory, exactly
  // as it does in the app (and wipes any history carried over from prior tests).
  await input().click();
  await page.keyboard.type("baseline");
  await page.keyboard.press("Enter");
  await expect.poll(valueOf).toBe("");

  await page.keyboard.type("hello world"); // a multi-word burst, spaces included
  expect(await valueOf()).toBe("hello world");

  await page.keyboard.press("ControlOrMeta+z"); // ControlOrMeta = Cmd on macOS, Ctrl elsewhere
  expect(await valueOf()).toBe(""); // the whole burst undoes at once, not word-by-word
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect(await valueOf()).toBe("hello world"); // redo

  // Ctrl/Cmd-B wraps as a discrete undo step — undo removes the bold, keeps text.
  await page.evaluate(() => document.querySelector("#composer-input").setSelectionRange(0, 11));
  await page.keyboard.press("ControlOrMeta+b");
  expect(await valueOf()).toBe("**hello world**");
  await expect(input().locator(".md-strong")).toContainText("hello world");
  await page.keyboard.press("ControlOrMeta+z");
  expect(await valueOf()).toBe("hello world");
  await expect(input().locator(".md-strong")).toHaveCount(0);

  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; }); // clean up for later tests
});

test("backspacing one backtick keeps the caret in place (does not jump to the start)", async () => {
  await input().click();
  await page.keyboard.type("`x`");           // renders as inline code
  await expect(input().locator(".md-code")).toHaveCount(1);
  await page.keyboard.press("Backspace");    // delete the closing backtick
  expect(await valueOf()).toBe("`x");        // unbalanced → decoration drops
  await page.keyboard.type("Y");             // must land where the caret was (the end)
  expect(await valueOf()).toBe("`xY");       // not "Y`x" — the caret didn't jump to the start
});

test("forward Delete removes the char to the RIGHT and the caret holds (does not drag left)", async () => {
  // Regression: onInput applied the length delta unconditionally, so a forward
  // delete (which removes AFTER the caret) dragged the caret one char left per
  // press. Type "abcd", move the caret between b and c, Delete → "abd" with the
  // caret still before d, so the next typed char lands there.
  await input().click();
  await page.keyboard.type("abcd");
  await page.evaluate(() => document.querySelector("#composer-input").setSelectionRange(2, 2)); // caret: ab|cd
  await page.keyboard.press("Delete");        // removes "c" (to the right)
  expect(await valueOf()).toBe("abd");
  await page.keyboard.type("X");              // caret held at ab|d → "abXd"
  expect(await valueOf()).toBe("abXd");       // not "aXbd" — the caret didn't drag left
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });
});

test("word-forward delete (Ctrl/Alt-Delete) holds the caret too", async () => {
  // The same bug, worse: a word-delete-forward shrank by several chars, dragging
  // the caret that many positions left. Delete the trailing word forward from the
  // start; the caret must hold at offset 0.
  await input().click();
  await page.keyboard.type("foo bar");
  await page.evaluate(() => document.querySelector("#composer-input").setSelectionRange(0, 0)); // |foo bar
  // Word-delete-forward: Ctrl+Delete on Win/Linux, Alt+Delete on macOS.
  await page.keyboard.press(process.platform === "darwin" ? "Alt+Delete" : "Control+Delete");
  await page.keyboard.type("X");              // lands at the held caret (offset 0)
  expect(await valueOf()).toMatch(/^X/);      // X is at the FRONT, caret never dragged left
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });
});

test("known @mention and #channel are tinted live; an unknown one stays plain", async () => {
  await input().click();
  // USER2 is a real account, so @USER2 is a known mention; #zzznope is not a channel.
  await page.keyboard.type(`hi @${USER2} `);
  await expect(input().locator(".md-mention")).toContainText(`@${USER2}`);
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });

  await page.keyboard.type("see #zzznope ");
  await expect(input().locator(".md-channel")).toHaveCount(0); // no such channel → plain
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });
});

test("pressing the shortcut again at the closing marker exits the formatted region", async () => {
  await input().click();
  await page.keyboard.press("ControlOrMeta+i"); // inserts the * * pair, caret between
  await page.keyboard.type("italic");            // → "*italic*", caret just before closing *
  expect(await valueOf()).toBe("*italic*");
  await page.keyboard.press("ControlOrMeta+i");  // exit: caret steps to the right of the closing *
  await page.keyboard.type("X");
  expect(await valueOf()).toBe("*italic*X");      // X landed AFTER the closing *, not before it
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });
});

test("Ctrl-A, Ctrl-I, Backspace clears everything (no orphan asterisks)", async () => {
  await input().click();
  await page.keyboard.type("hello");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+i");  // wraps all → "*hello*", inner selected
  expect(await valueOf()).toBe("*hello*");
  await page.keyboard.press("Backspace");         // deletes the inner AND the now-orphan markers
  expect(await valueOf()).toBe("");
});

test("Ctrl/Cmd-B works in the inline message editor (marker insert, no decoration)", async () => {
  // Send a message, open its editor, select a word, and bold it.
  await input().click();
  await page.keyboard.type("editme please");
  await page.keyboard.press("Enter");
  const msg = page.locator("#message-list .msg-body", { hasText: "editme please" }).last();
  await expect(msg).toBeVisible();
  await msg.hover();
  await page.locator("#message-list .msg").last().locator('button[title="Edit"]').dispatchEvent("click");
  const ta = page.locator(".msg-edit-input");
  await expect(ta).toBeVisible();
  await ta.focus();
  await ta.evaluate((el) => el.setSelectionRange(0, 6)); // "editme"
  await page.keyboard.press("ControlOrMeta+b");
  expect(await ta.inputValue()).toBe("**editme** please");
  await page.keyboard.press("Escape"); // cancel the edit
});

test("Shift+Enter on an EMPTY composer inserts a newline (not swallowed by the normalize)", async () => {
  await input().click();
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("after");
  // The newline survived — "after" sits below an empty first line. (Regressed in
  // Gecko, where Shift+Enter on empty makes a lone <br> the delete-normalize ate.)
  expect(await valueOf()).toMatch(/^\n+after$/);
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });
});

test("select-all then Ctrl-I toggles italic OFF instead of piling on asterisks", async () => {
  await input().click();
  await page.keyboard.press("ControlOrMeta+i"); // "**", caret between the markers
  await page.keyboard.type("hi");                // "*hi*"
  expect(await valueOf()).toBe("*hi*");
  await page.keyboard.press("ControlOrMeta+a");  // selects the whole thing, markers included
  await page.keyboard.press("ControlOrMeta+i");  // unwraps (toggles off), does not add more
  expect(await valueOf()).toBe("hi");
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });
});

test("a fenced ``` code block styles in the composer and round-trips byte-identically", async () => {
  await input().click();
  // Shift+Enter for newlines (plain Enter sends).
  await page.keyboard.type("```js");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("const x = 1;");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("```");
  await expect(input().locator(".md-cb-fence")).toHaveCount(2);     // both fences
  await expect(input().locator(".md-cb-lang")).toContainText("js"); // language hint
  await expect(input().locator(".md-codeblock", { hasText: "const x = 1;" })).toBeVisible();
  expect(await valueOf()).toBe("```js\nconst x = 1;\n```");          // exact source preserved
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });
});

test("undo does NOT bridge a channel switch (loadChannel must call resetHistory)", async () => {
  // Invariant: any out-of-band .value set (channel switch, send-clear, error-restore)
  // calls rich.resetHistory() so the undo stack can't reach across that boundary. Here:
  // type in the DM, switch channels, then no amount of undo may resurrect the DM text.
  await input().click();
  await page.keyboard.type("alpha");
  expect(await valueOf()).toBe("alpha");

  // Switch to a fresh public channel (the seed has none, so create one).
  const channelId = await page.evaluate(async () => {
    const ch = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name: "rt-undo-boundary", topic: "", is_private: false }),
    }).then((r) => r.json());
    return ch.id;
  });
  await page.click(`#channel-list li[data-ch-id="${channelId}"]`);
  await expect(page.locator(`#channel-list li[data-ch-id="${channelId}"]`)).toHaveClass(/active/);

  // Fresh channel → empty composer (this out-of-band set reset the history).
  await input().click();
  expect(await valueOf()).toBe("");
  await page.keyboard.type("beta");
  expect(await valueOf()).toBe("beta");

  // Undo the beta burst, then keep undoing: the stack must bottom out at "", never
  // bridge back into the DM's "alpha".
  await page.keyboard.press("ControlOrMeta+z");
  expect(await valueOf()).toBe("");
  await page.keyboard.press("ControlOrMeta+z");
  expect(await valueOf()).toBe(""); // not "alpha" — the boundary was reset

  // Restore the DM as the active channel for hygiene.
  await page.evaluate(() => { document.querySelector("#composer-input").value = ""; });
  await page.locator("#dm-list li", { hasText: USER2 }).first().click();
  await expect(page.locator("#composer-input")).toBeVisible();
});
