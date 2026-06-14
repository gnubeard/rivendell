import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraftStore } from "../static/drafts.js";

test("restoreText is empty for a channel with no draft", () => {
  const d = createDraftStore();
  assert.equal(d.restoreText("c1"), "");
});

test("saveText then restoreText round-trips verbatim", () => {
  const d = createDraftStore();
  d.saveText("c1", "hello world");
  assert.equal(d.restoreText("c1"), "hello world");
});

test("saveText preserves leading/trailing whitespace when content is non-blank", () => {
  const d = createDraftStore();
  d.saveText("c1", "  draft with spaces\n");
  assert.equal(d.restoreText("c1"), "  draft with spaces\n");
});

test("saveText drops a blank draft (whitespace-only)", () => {
  const d = createDraftStore();
  d.saveText("c1", "kept");
  d.saveText("c1", "   \n\t ");
  assert.equal(d.restoreText("c1"), "");
});

test("saveText drops an empty string and tolerates null/undefined", () => {
  const d = createDraftStore();
  d.saveText("c1", "kept");
  d.saveText("c1", "");
  assert.equal(d.restoreText("c1"), "");
  d.saveText("c2", null);
  d.saveText("c2", undefined);
  assert.equal(d.restoreText("c2"), "");
});

test("drafts are isolated per channel", () => {
  const d = createDraftStore();
  d.saveText("c1", "one");
  d.saveText("c2", "two");
  assert.equal(d.restoreText("c1"), "one");
  assert.equal(d.restoreText("c2"), "two");
});

test("restoreAttachments is an empty array when none saved", () => {
  const d = createDraftStore();
  assert.deepEqual(d.restoreAttachments("c1"), []);
});

test("saveAttachments then restoreAttachments returns the same list", () => {
  const d = createDraftStore();
  const uploads = [{ id: "u1" }, { id: "u2" }];
  d.saveAttachments("c1", uploads);
  assert.deepEqual(d.restoreAttachments("c1"), uploads);
});

test("saveAttachments with an empty list drops the entry", () => {
  const d = createDraftStore();
  d.saveAttachments("c1", [{ id: "u1" }]);
  d.saveAttachments("c1", []);
  assert.deepEqual(d.restoreAttachments("c1"), []);
});

test("saveAttachments tolerates null/undefined", () => {
  const d = createDraftStore();
  d.saveAttachments("c1", null);
  d.saveAttachments("c1", undefined);
  assert.deepEqual(d.restoreAttachments("c1"), []);
});

test("text and attachment stores are independent within a channel", () => {
  const d = createDraftStore();
  d.saveText("c1", "draft");
  d.saveAttachments("c1", [{ id: "u1" }]);
  // Clearing the text must not touch the attachments and vice versa.
  d.saveText("c1", "");
  assert.equal(d.restoreText("c1"), "");
  assert.deepEqual(d.restoreAttachments("c1"), [{ id: "u1" }]);
});

test("separate stores share no state", () => {
  const a = createDraftStore();
  const b = createDraftStore();
  a.saveText("c1", "a-draft");
  a.saveAttachments("c1", [{ id: "u1" }]);
  assert.equal(b.restoreText("c1"), "");
  assert.deepEqual(b.restoreAttachments("c1"), []);
});
