import { test } from "node:test";
import assert from "node:assert/strict";
import { composeMessageBody } from "../static/attachments.js";

const up = (markdown, spoiler = false) => ({ markdown, spoiler, status: "done" });

test("text only → the text verbatim", () => {
  assert.equal(composeMessageBody("hello world", []), "hello world");
});

test("attachments only → markdown lines, no leading blank", () => {
  const body = composeMessageBody("", [up("![image](/a)"), up("![image](/b)")]);
  assert.equal(body, "![image](/a)\n![image](/b)");
});

test("text + attachments → text first, then one markdown per line", () => {
  const body = composeMessageBody("look:", [up("![image](/a)")]);
  assert.equal(body, "look:\n![image](/a)");
});

test("spoiler-marked attachments are wrapped in ||..||", () => {
  const body = composeMessageBody("", [up("![image](/a)", true)]);
  assert.equal(body, "||![image](/a)||");
});

test("mixed spoiler and normal attachments wrap only the marked ones", () => {
  const body = composeMessageBody("hi", [up("![image](/a)"), up("![image](/b)", true)]);
  assert.equal(body, "hi\n![image](/a)\n||![image](/b)||");
});

test("whitespace-only text is dropped so the body starts at the first attachment", () => {
  assert.equal(composeMessageBody("   \n ", [up("![image](/a)")]), "![image](/a)");
});

test("the typed text is preserved verbatim (internal whitespace, not trimmed)", () => {
  // The trim is only the keep/drop test — non-blank text is emitted as typed.
  assert.equal(composeMessageBody("  spaced  ", []), "  spaced  ");
});

test("nothing to send → empty string", () => {
  assert.equal(composeMessageBody("", []), "");
  assert.equal(composeMessageBody("   ", []), "");
});
