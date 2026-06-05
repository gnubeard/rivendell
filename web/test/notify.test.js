import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldNotify } from "../static/notify.js";

// shouldNotify is the pure gate for raising an OS notification: only when the
// user opted in, the OS granted permission, AND they aren't already looking here.
test("shouldNotify requires opt-in, granted permission, and an unfocused tab", () => {
  assert.equal(shouldNotify({ permission: "granted", enabled: true, focused: false }), true);

  // Any one condition off -> no notification.
  assert.equal(shouldNotify({ permission: "granted", enabled: true, focused: true }), false);
  assert.equal(shouldNotify({ permission: "granted", enabled: false, focused: false }), false);
  assert.equal(shouldNotify({ permission: "denied", enabled: true, focused: false }), false);
  assert.equal(shouldNotify({ permission: "default", enabled: true, focused: false }), false);
});

test("shouldNotify is strict about types (no truthy coercion surprises)", () => {
  // enabled must be exactly true; focused must be exactly false.
  assert.equal(shouldNotify({ permission: "granted", enabled: 1, focused: false }), false);
  assert.equal(shouldNotify({ permission: "granted", enabled: true, focused: 0 }), false);
});
