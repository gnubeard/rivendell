import { test } from "node:test";
import assert from "node:assert/strict";
import { previewOutcome, createPreviewCache, LOADING, PENDING, FAILED } from "../static/previews.js";

test("previewOutcome maps each cache state to a renderer action", () => {
  assert.equal(previewOutcome(undefined), "fetch"); // never requested
  assert.equal(previewOutcome(LOADING), "wait");
  assert.equal(previewOutcome(PENDING), "wait");
  assert.equal(previewOutcome(FAILED), "wait");
  assert.equal(previewOutcome({ title: "hi" }), "ready"); // resolved payload
});

test("begin claims an unrequested key once, then is a no-op", () => {
  const c = createPreviewCache();
  assert.equal(c.begin("u1"), true); // first claim wins
  assert.equal(c.outcome("u1"), "wait"); // now loading
  assert.equal(c.begin("u1"), false); // already in flight → idempotent
});

test("begin is a no-op once a key has resolved (no needless re-fetch)", () => {
  const c = createPreviewCache();
  c.begin("u1");
  c.resolve("u1", { title: "x" });
  assert.equal(c.begin("u1"), false);
  assert.equal(c.outcome("u1"), "ready");
});

test("resolve makes a key ready and returns the payload via get", () => {
  const c = createPreviewCache();
  c.begin("u1");
  const payload = { title: "Hello", site_name: "Example" };
  c.resolve("u1", payload);
  assert.equal(c.outcome("u1"), "ready");
  assert.equal(c.get("u1"), payload);
});

test("fail leaves the key in a wait (render-nothing) state", () => {
  const c = createPreviewCache();
  c.begin("u1");
  c.fail("u1");
  assert.equal(c.get("u1"), FAILED);
  assert.equal(c.outcome("u1"), "wait");
});

test("pending then forget re-opens the key for a retry fetch", () => {
  const c = createPreviewCache();
  c.begin("u1");
  c.pending("u1");
  assert.equal(c.outcome("u1"), "wait"); // retry in flight, render nothing
  c.forget("u1"); // the 2.5s retry timer drops it
  assert.equal(c.outcome("u1"), "fetch"); // back to unrequested → fetch again
});

test("an unrequested key reports fetch and holds no value", () => {
  const c = createPreviewCache();
  assert.equal(c.outcome("missing"), "fetch");
  assert.equal(c.get("missing"), undefined);
});

test("caches are independent instances", () => {
  const a = createPreviewCache();
  const b = createPreviewCache();
  a.begin("u1");
  assert.equal(b.outcome("u1"), "fetch"); // b never saw u1
});
