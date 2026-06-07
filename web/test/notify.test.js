import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldNotify, urlBase64ToUint8Array, pushSubscriptionPayload } from "../static/notify.js";

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

// urlBase64ToUint8Array decodes a base64url VAPID key into the byte array
// pushManager.subscribe wants. It must handle the URL-safe alphabet and the
// missing padding that browsers/servers emit.
test("urlBase64ToUint8Array decodes base64url (URL-safe alphabet, no padding)", () => {
  // Round-trip a known byte sequence through unpadded base64url.
  const bytes = [0x04, 0xfe, 0x33, 0xf4, 0xab, 0x00, 0xff, 0x7e, 0x91];
  const b64url = Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const out = urlBase64ToUint8Array(b64url);
  assert.ok(out instanceof Uint8Array);
  assert.deepEqual(Array.from(out), bytes);
});

test("urlBase64ToUint8Array yields a 65-byte point for a real VAPID-length key", () => {
  // 65 bytes (uncompressed P-256 point) -> 87-char unpadded base64url.
  const raw = new Uint8Array(65).fill(7);
  raw[0] = 0x04;
  const b64url = Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(b64url.length, 87);
  assert.equal(urlBase64ToUint8Array(b64url).length, 65);
});

// pushSubscriptionPayload trims a PushSubscription to exactly {endpoint, keys}
// — the server's decoder rejects unknown fields (e.g. expirationTime).
test("pushSubscriptionPayload extracts only endpoint + p256dh + auth", () => {
  const sub = {
    toJSON: () => ({
      endpoint: "https://push.example/abc",
      expirationTime: null, // must be dropped
      keys: { p256dh: "PUB", auth: "AUTH", extra: "nope" },
    }),
  };
  assert.deepEqual(pushSubscriptionPayload(sub), {
    endpoint: "https://push.example/abc",
    keys: { p256dh: "PUB", auth: "AUTH" },
  });
});

test("pushSubscriptionPayload also accepts a plain object (no toJSON)", () => {
  const plain = { endpoint: "https://push.example/xyz", keys: { p256dh: "P", auth: "A" } };
  assert.deepEqual(pushSubscriptionPayload(plain), {
    endpoint: "https://push.example/xyz",
    keys: { p256dh: "P", auth: "A" },
  });
});
