// secret.test.js — unit tests for the pure helpers and async crypto in secret.js.
//
// The pure functions (formatSafetyNumber, buildAAD, replayOk, canonicalPubKeyOrder)
// are tested without any WebCrypto dependency. The async ratchet/encrypt/decrypt
// tests use Node's crypto.webcrypto (available in Node 18+).

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

// Make WebCrypto available as the global `crypto` that secret.js expects.
if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = webcrypto;
}

// IndexedDB is not available in Node — stub it before importing secret.js so
// that ensureIdentityKey() paths are not exercised in these pure-helper tests.
globalThis.indexedDB = {
  open: () => {
    const req = {};
    setTimeout(() => req.onerror && req.onerror({ target: { error: new Error("no idb in node") } }), 0);
    return req;
  },
};

import {
  formatSafetyNumber,
  buildAAD,
  replayOk,
  canonicalPubKeyOrder,
  ratchetStep,
  encryptMessage,
  decryptMessage,
} from "../static/secret.js";

// ---------------------------------------------------------------------------
// formatSafetyNumber
// ---------------------------------------------------------------------------

test("formatSafetyNumber produces 12 groups of 5 digits", () => {
  const hash = new Uint8Array(32).fill(0);
  const sn = formatSafetyNumber(hash);
  const groups = sn.split(" ");
  assert.equal(groups.length, 12);
  for (const g of groups) {
    assert.match(g, /^\d{5}$/, `group "${g}" is not 5 digits`);
  }
});

test("formatSafetyNumber is deterministic", () => {
  const hash = new Uint8Array(32);
  crypto.getRandomValues(hash);
  assert.equal(formatSafetyNumber(hash), formatSafetyNumber(hash));
});

test("formatSafetyNumber differs for different inputs", () => {
  const a = new Uint8Array(32).fill(0);
  const b = new Uint8Array(32).fill(255);
  assert.notEqual(formatSafetyNumber(a), formatSafetyNumber(b));
});

test("formatSafetyNumber of all-zero hash is all-zero groups", () => {
  const sn = formatSafetyNumber(new Uint8Array(32));
  assert.equal(sn, "00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000");
});

test("formatSafetyNumber of all-0xFF hash is non-zero", () => {
  const sn = formatSafetyNumber(new Uint8Array(32).fill(0xff));
  assert.notEqual(sn, "00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000");
});

// ---------------------------------------------------------------------------
// buildAAD
// ---------------------------------------------------------------------------

test("buildAAD returns 52 bytes", () => {
  const nonce = new Uint8Array(32).fill(1);
  const aad = buildAAD(1, 0, 42, nonce);
  assert.equal(aad.byteLength, 52);
});

test("buildAAD encodes sender in first 8 bytes big-endian", () => {
  const nonce = new Uint8Array(32);
  const aad = buildAAD(255, 0, 0, nonce);
  const view = new DataView(aad.buffer);
  assert.equal(view.getBigInt64(0, false), 255n);
});

test("buildAAD encodes counter in bytes 8-11 big-endian", () => {
  const nonce = new Uint8Array(32);
  const aad = buildAAD(1, 7, 0, nonce);
  const view = new DataView(aad.buffer);
  assert.equal(view.getUint32(8, false), 7);
});

test("buildAAD encodes channelID in bytes 12-19 big-endian", () => {
  const nonce = new Uint8Array(32);
  const aad = buildAAD(0, 0, 99, nonce);
  const view = new DataView(aad.buffer);
  assert.equal(view.getBigInt64(12, false), 99n);
});

test("buildAAD copies session nonce into bytes 20-51", () => {
  const nonce = new Uint8Array(32);
  for (let i = 0; i < 32; i++) nonce[i] = i;
  const aad = buildAAD(0, 0, 0, nonce);
  for (let i = 0; i < 32; i++) {
    assert.equal(aad[20 + i], i, `nonce byte ${i} mismatch`);
  }
});

test("buildAAD differs for different senders", () => {
  const nonce = new Uint8Array(32);
  const a = buildAAD(1, 0, 0, nonce);
  const b = buildAAD(2, 0, 0, nonce);
  assert.notDeepEqual(a, b);
});

test("buildAAD differs for different counters", () => {
  const nonce = new Uint8Array(32);
  const a = buildAAD(1, 0, 0, nonce);
  const b = buildAAD(1, 1, 0, nonce);
  assert.notDeepEqual(a, b);
});

// ---------------------------------------------------------------------------
// replayOk
// ---------------------------------------------------------------------------

test("replayOk accepts the expected counter and advances nextExpected", () => {
  const result = replayOk(0, 0);
  assert.equal(result.ok, true);
  assert.equal(result.nextExpected, 1);
});

test("replayOk advances counter monotonically", () => {
  let next = 0;
  for (let i = 0; i < 10; i++) {
    const r = replayOk(next, i);
    assert.equal(r.ok, true);
    next = r.nextExpected;
  }
  assert.equal(next, 10);
});

test("replayOk rejects a duplicate (counter < nextExpected)", () => {
  assert.equal(replayOk(5, 4).ok, false);
  assert.equal(replayOk(5, 4).nextExpected, 5);
});

test("replayOk rejects a replay of the same counter", () => {
  const r1 = replayOk(3, 3);
  assert.equal(r1.ok, true);
  const r2 = replayOk(r1.nextExpected, 3); // counter 3 again
  assert.equal(r2.ok, false);
});

test("replayOk rejects a gap (counter > nextExpected)", () => {
  assert.equal(replayOk(2, 5).ok, false);
});

// ---------------------------------------------------------------------------
// canonicalPubKeyOrder
// ---------------------------------------------------------------------------

test("canonicalPubKeyOrder puts lower user id first", () => {
  const [low, high] = canonicalPubKeyOrder(1, "keyA", 2, "keyB");
  assert.equal(low, "keyA");
  assert.equal(high, "keyB");
});

test("canonicalPubKeyOrder swaps when first id is higher", () => {
  const [low, high] = canonicalPubKeyOrder(10, "keyA", 5, "keyB");
  assert.equal(low, "keyB");
  assert.equal(high, "keyA");
});

// ---------------------------------------------------------------------------
// ratchetStep — uses real WebCrypto (HKDF)
// ---------------------------------------------------------------------------

test("ratchetStep produces 32-byte msgKey and nextChain", async () => {
  const chainKey = new Uint8Array(32).fill(0xab);
  const { msgKey, nextChain } = await ratchetStep(chainKey, 0);
  assert.equal(msgKey.byteLength, 32);
  assert.equal(nextChain.byteLength, 32);
});

test("ratchetStep is deterministic for same inputs", async () => {
  const chainKey = new Uint8Array(32).fill(0x42);
  const r1 = await ratchetStep(chainKey, 0);
  const r2 = await ratchetStep(chainKey, 0);
  assert.deepEqual(r1.msgKey, r2.msgKey);
  assert.deepEqual(r1.nextChain, r2.nextChain);
});

test("ratchetStep msgKey differs across counters", async () => {
  const chainKey = new Uint8Array(32).fill(0x99);
  const r0 = await ratchetStep(chainKey, 0);
  const r1 = await ratchetStep(chainKey, 1);
  assert.notDeepEqual(r0.msgKey, r1.msgKey);
});

test("ratchetStep msgKey differs from nextChain", async () => {
  const chainKey = new Uint8Array(32).fill(0x55);
  const { msgKey, nextChain } = await ratchetStep(chainKey, 0);
  assert.notDeepEqual(msgKey, nextChain);
});

test("ratchetStep nextChain is the same regardless of counter (chain advances uniformly)", async () => {
  // The chain key derivation uses info="chain" only, not the counter.
  // So calling ratchetStep with counter=0 or counter=99 on the same chainKey
  // produces the same nextChain (only msgKey varies by counter).
  const chainKey = new Uint8Array(32).fill(0x11);
  const r0 = await ratchetStep(chainKey, 0);
  const r99 = await ratchetStep(chainKey, 99);
  assert.deepEqual(r0.nextChain, r99.nextChain);
});

// ---------------------------------------------------------------------------
// encryptMessage / decryptMessage round-trip
// ---------------------------------------------------------------------------

test("encrypt→decrypt round-trip recovers plaintext", async () => {
  const chainKey = new Uint8Array(32);
  crypto.getRandomValues(chainKey);
  const sessionNonce = new Uint8Array(32);
  crypto.getRandomValues(sessionNonce);

  const { wire, nextChain } = await encryptMessage("hello secret", 1, 0, 42, sessionNonce, chainKey);
  const { text } = await decryptMessage(wire, 1, 42, sessionNonce, chainKey);
  assert.equal(text, "hello secret");
});

test("decrypt fails with wrong sender AAD", async () => {
  const chainKey = new Uint8Array(32).fill(0x77);
  const sessionNonce = new Uint8Array(32).fill(0x33);
  const { wire } = await encryptMessage("tamper", 1, 0, 42, sessionNonce, chainKey);
  // Attempt decrypt with senderID=2 (wrong AAD) — must throw
  await assert.rejects(
    () => decryptMessage(wire, 2, 42, sessionNonce, chainKey),
    "decrypt with wrong sender should fail",
  );
});

test("decrypt fails with wrong channel AAD", async () => {
  const chainKey = new Uint8Array(32).fill(0x88);
  const sessionNonce = new Uint8Array(32).fill(0x44);
  const { wire } = await encryptMessage("tamper", 1, 0, 42, sessionNonce, chainKey);
  await assert.rejects(
    () => decryptMessage(wire, 1, 99, sessionNonce, chainKey),
    "decrypt with wrong channel should fail",
  );
});

test("decrypt fails with wrong session nonce", async () => {
  const chainKey = new Uint8Array(32).fill(0xcc);
  const sessionNonce = new Uint8Array(32).fill(0x11);
  const wrongNonce = new Uint8Array(32).fill(0x22);
  const { wire } = await encryptMessage("tamper", 1, 0, 42, sessionNonce, chainKey);
  await assert.rejects(
    () => decryptMessage(wire, 1, 42, wrongNonce, chainKey),
    "decrypt with wrong nonce should fail",
  );
});

test("decrypt fails with wrong chain key", async () => {
  const chainKey = new Uint8Array(32).fill(0xaa);
  const wrongKey = new Uint8Array(32).fill(0xbb);
  const sessionNonce = new Uint8Array(32).fill(0x55);
  const { wire } = await encryptMessage("tamper", 1, 0, 42, sessionNonce, chainKey);
  await assert.rejects(
    () => decryptMessage(wire, 1, 42, sessionNonce, wrongKey),
    "decrypt with wrong key should fail",
  );
});

test("ratcheted chain keys produce correct sequential messages", async () => {
  const initChain = new Uint8Array(32);
  crypto.getRandomValues(initChain);
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);

  // Sender side: encrypt 3 messages, advancing the chain each time.
  let senderChain = initChain;
  const wires = [];
  for (let i = 0; i < 3; i++) {
    const { wire, nextChain } = await encryptMessage(`msg ${i}`, 1, i, 42, nonce, senderChain);
    wires.push(wire);
    senderChain = nextChain;
  }

  // Receiver side: decrypt 3 messages with the SAME initial chain key.
  let recvChain = initChain;
  for (let i = 0; i < 3; i++) {
    const { text, nextChain } = await decryptMessage(wires[i], 1, 42, nonce, recvChain);
    assert.equal(text, `msg ${i}`);
    recvChain = nextChain;
  }
});
