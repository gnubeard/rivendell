// secret.js — OTR-style ephemeral E2E encrypted secret sessions for DMs.
//
// Threat model summary: defends against passive server/DB compromise and
// authenticated MITM (when safety number is verified). Does NOT hide metadata
// (who talks to whom), does NOT provide cryptographic deniability, does NOT
// work offline or across multiple devices.
//
// Primitives (all SubtleCrypto; we compose, not implement):
//   Ed25519  — long-term identity signing keypair (private: non-extractable)
//   X25519   — ephemeral ECDH keypair (forward secrecy)
//   HKDF-SHA-256 — key derivation from shared secret → root key → chain keys
//   AES-256-GCM  — per-message AEAD encryption
//   SHA-256      — fingerprint / safety-number basis
//
// Sessions are in JS memory only. Reloading the page ends the session.

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

// formatSafetyNumber converts a 32-byte SHA-256 hash into a 60-digit safety
// number displayed as 12 groups of 5. Treats the bytes as a big-endian
// unsigned integer and extracts digits from the low end.
export function formatSafetyNumber(hashBytes) {
  let n = 0n;
  for (const b of hashBytes) n = (n << 8n) | BigInt(b);
  const groups = [];
  for (let i = 0; i < 12; i++) {
    groups.push(String(n % 100000n).padStart(5, "0"));
    n /= 100000n;
  }
  return groups.reverse().join(" ");
}

// buildAAD constructs the 52-byte associated data for AES-GCM:
//   senderID (8 bytes BE) ‖ counter (4 bytes BE) ‖ channelID (8 bytes BE) ‖ sessionNonce (32 bytes)
export function buildAAD(senderID, counter, channelID, sessionNonce) {
  const buf = new ArrayBuffer(52);
  const v = new DataView(buf);
  v.setBigInt64(0, BigInt(senderID), false);
  v.setUint32(8, counter >>> 0, false);
  v.setBigInt64(12, BigInt(channelID), false);
  new Uint8Array(buf, 20, 32).set(sessionNonce);
  return new Uint8Array(buf);
}

// replayOk checks whether `counter` is the next expected value and returns
// the updated nextExpected. Requires strict monotonicity — no gaps, no reuse.
export function replayOk(nextExpected, counter) {
  if (counter !== nextExpected) return { ok: false, nextExpected };
  return { ok: true, nextExpected: counter + 1 };
}

// canonicalPubKeyOrder returns [lowKey, highKey] sorted by numeric user id.
// Both sides compute the same order for fingerprint/safety-number input.
export function canonicalPubKeyOrder(userIdA, keyA, userIdB, keyB) {
  return userIdA < userIdB ? [keyA, keyB] : [keyB, keyA];
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function b64enc(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64dec(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// IndexedDB — stores identity keypair and per-peer trust records
// ---------------------------------------------------------------------------

const DB_NAME = "rivendell-secret";
const DB_VERSION = 1;
const KEYS_STORE = "keys";
const TRUST_STORE = "trust";

let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(KEYS_STORE)) {
        db.createObjectStore(KEYS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(TRUST_STORE)) {
        db.createObjectStore(TRUST_STORE, { keyPath: "userId" });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Identity key management
// ---------------------------------------------------------------------------

let _idKeypair = null;  // CryptoKeyPair (Ed25519); private is non-extractable
let _myPubKeyB64 = null; // SPKI base64 of our identity public key

async function ensureIdentityKey() {
  if (_idKeypair) return _idKeypair;
  const stored = await dbGet(KEYS_STORE, "identity");
  if (stored) {
    _idKeypair = stored.keypair;
    _myPubKeyB64 = stored.pubKeyB64;
    return _idKeypair;
  }
  // Generate a new Ed25519 keypair. The private key is non-extractable so even
  // an XSS bug cannot exfiltrate it — it can only be used to sign while the
  // page is live. The public key is always extractable regardless of this flag.
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const pubBytes = await crypto.subtle.exportKey("spki", kp.publicKey);
  const pubB64 = b64enc(pubBytes);
  await dbPut(KEYS_STORE, { id: "identity", keypair: kp, pubKeyB64: pubB64 });
  _idKeypair = kp;
  _myPubKeyB64 = pubB64;
  return kp;
}

// getMyPubKeyB64 returns the base64 SPKI-encoded identity public key, ensuring
// it has been generated. Callers must call this before publishing to the server.
export async function getMyPubKeyB64() {
  await ensureIdentityKey();
  return _myPubKeyB64;
}

// getTrustRecord returns the stored trust record for a peer, or null.
async function getTrustRecord(userId) {
  return dbGet(TRUST_STORE, userId);
}

// setTrustRecord stores that we have verified the peer's identity key.
export async function markVerified(userId, keyB64) {
  await dbPut(TRUST_STORE, { userId, keyB64, verifiedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

let _supported = null;

export async function isSecretSupported() {
  if (_supported !== null) return _supported;
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveKey"]);
    _supported = true;
  } catch {
    _supported = false;
  }
  return _supported;
}

// ---------------------------------------------------------------------------
// HKDF key derivation helpers
// ---------------------------------------------------------------------------

// importHKDF imports raw bytes as an HKDF source key.
async function importHKDF(bytes) {
  return crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits"]);
}

// hkdfBits derives `bits` bits from an HKDF key using HKDF-SHA-256.
async function hkdfBits(hkdfKey, salt, info, bits) {
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) },
    hkdfKey,
    bits,
  );
}

// ---------------------------------------------------------------------------
// Handshake helpers
// ---------------------------------------------------------------------------

// buildSignData constructs the data signed during offer/accept:
//   myEphPub (32 bytes raw) ‖ myId (8 bytes BE) ‖ peerId (8 bytes BE) ‖ sessionNonce (32 bytes)
function buildSignData(ephPubRaw, myUserId, peerUserId, sessionNonce) {
  const buf = new ArrayBuffer(32 + 8 + 8 + 32);
  const v = new DataView(buf);
  new Uint8Array(buf, 0, 32).set(ephPubRaw);
  v.setBigInt64(32, BigInt(myUserId), false);
  v.setBigInt64(40, BigInt(peerUserId), false);
  new Uint8Array(buf, 48, 32).set(sessionNonce);
  return new Uint8Array(buf);
}

// deriveSessionKeys takes the shared X25519 secret (32 bytes) and the
// session nonce and returns { sendChainKey, recvChainKey } based on user_id
// ordering: the lower user_id's chain key is the first 32 bytes of the
// HKDF output. Both sides compute the same split.
async function deriveSessionKeys(sharedSecret, sessionNonce, myUserId, peerUserId) {
  const hk = await importHKDF(sharedSecret);
  const rootBits = await hkdfBits(hk, sessionNonce, "rivendell-otr-v1", 512);
  const root = new Uint8Array(rootBits);
  const lowKey = root.slice(0, 32);   // used by the lower-user-id sender
  const highKey = root.slice(32, 64); // used by the higher-user-id sender
  return myUserId < peerUserId
    ? { sendChainKey: lowKey, recvChainKey: highKey }
    : { sendChainKey: highKey, recvChainKey: lowKey };
}

// ---------------------------------------------------------------------------
// Message ratchet (symmetric hash chain, HKDF-based)
// ---------------------------------------------------------------------------

// ratchetStep derives a per-message encryption key and advances the chain key.
// Both outputs are 32 bytes. This is the pure per-step operation; callers
// are responsible for persisting nextChain into the session.
//
// msgKey  = HKDF(chainKey, info = "msg" ‖ counter_be32)   — unique per message
// nextChain = HKDF(chainKey, info = "chain")              — steps the ratchet
export async function ratchetStep(chainKey, counter) {
  const hk = await importHKDF(chainKey);
  const counterBuf = new Uint8Array(4);
  new DataView(counterBuf.buffer).setUint32(0, counter >>> 0, false);
  const msgInfo = new Uint8Array([...enc.encode("msg"), ...counterBuf]);

  // Derive both keys from the same HKDF source; HKDF allows multiple derivations.
  const [msgBits, nextChainBits] = await Promise.all([
    crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: msgInfo },
      hk,
      256,
    ),
    crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("chain") },
      hk,
      256,
    ),
  ]);
  return { msgKey: new Uint8Array(msgBits), nextChain: new Uint8Array(nextChainBits) };
}

// encryptMessage encrypts `text` with the current send chain key and returns
// a wire payload { ct, nonce, counter } (all base64) plus the next chain key.
export async function encryptMessage(text, senderID, counter, channelID, sessionNonce, chainKey) {
  const { msgKey, nextChain } = await ratchetStep(chainKey, counter);
  const aesKey = await crypto.subtle.importKey("raw", msgKey, "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = buildAAD(senderID, counter, channelID, sessionNonce);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    aesKey,
    enc.encode(text),
  );
  return { wire: { ct: b64enc(ct), nonce: b64enc(nonce), counter }, nextChain };
}

// decryptMessage decrypts a wire payload and returns { text, nextChain }.
// Throws if authentication fails (wrong key, tampered ciphertext, wrong AAD).
export async function decryptMessage(wire, senderID, channelID, sessionNonce, chainKey) {
  const { ct, nonce, counter } = wire;
  const { msgKey, nextChain } = await ratchetStep(chainKey, counter);
  const aesKey = await crypto.subtle.importKey("raw", msgKey, "AES-GCM", false, ["decrypt"]);
  const aad = buildAAD(senderID, counter, channelID, sessionNonce);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64dec(nonce), additionalData: aad },
    aesKey,
    b64dec(ct),
  );
  return { text: new TextDecoder().decode(plain), nextChain };
}

// ---------------------------------------------------------------------------
// Safety number
// ---------------------------------------------------------------------------

// computeSafetyNumber returns the formatted 60-digit safety number for a pair.
// Both sides compute it identically: SHA-256(low-id-pub ‖ high-id-pub).
export async function computeSafetyNumber(myUserId, myPubB64, peerUserId, peerPubB64) {
  const [lowPub, highPub] = canonicalPubKeyOrder(myUserId, b64dec(myPubB64), peerUserId, b64dec(peerPubB64));
  const combined = new Uint8Array(lowPub.length + highPub.length);
  combined.set(lowPub);
  combined.set(highPub, lowPub.length);
  const hash = await crypto.subtle.digest("SHA-256", combined);
  return formatSafetyNumber(new Uint8Array(hash));
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _myUserId = null;
let _sendFn = null;    // (obj) -> void — WS send wrapper
let _onEvent = null;   // callback(event) -> void — reports to app.js

// sessions: dmChannelId -> SessionState
const sessions = new Map();

function makeSession(dmChannelId, peerUserId) {
  return {
    dmChannelId,
    peerUserId,
    phase: "idle",           // idle | offered | active
    sessionNonce: null,      // Uint8Array(32)
    ephKeypair: null,        // X25519 CryptoKeyPair (pending handshake)
    peerEphPub: null,        // CryptoKey (peer's ephemeral public key)
    peerIdPub: null,         // CryptoKey (peer's identity public key, for verification)
    peerIdKeyB64: null,      // string (peer's identity key as stored on server)
    sendChainKey: null,      // Uint8Array(32)
    recvChainKey: null,      // Uint8Array(32)
    sendCounter: 0,
    recvNextExpected: 0,
    messages: [],            // [{id, fromUserId, text, ts}] — in-memory only
    verified: false,         // has safety number been verified OOB?
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// initSecret must be called once with the current user's id and a WS send fn.
// onEventCb receives events: { type, ...fields }
//   secret-request   — peer wants to start a session: { dmChannelId, fromUserId }
//   session-active   — session established: { dmChannelId, verified }
//   session-ended    — session torn down: { dmChannelId }
//   message-received — decrypted message: { dmChannelId, fromUserId, text, id, ts }
//   dismiss          — another tab accepted/declined: { dmChannelId }
export function initSecret(myUserId, sendFn, onEventCb) {
  _myUserId = myUserId;
  _sendFn = sendFn;
  _onEvent = onEventCb;
}

function emit(event) {
  if (_onEvent) _onEvent(event);
}

// getSession returns the live session for a DM channel, or null.
export function getSession(dmChannelId) {
  return sessions.get(dmChannelId) || null;
}

// initiateSecret starts a secret session offer to the peer in a DM. The peer's
// identity key must be present in the user object (peerIdKeyB64). Throws if
// the crypto is unavailable or the peer has no published identity key.
export async function initiateSecret(dmChannelId, peerUserId, peerIdKeyB64) {
  if (!peerIdKeyB64) throw new Error("Peer has no identity key published.");

  // Ensure we have our own identity key generated and published.
  const idKp = await ensureIdentityKey();

  // Import the peer's Ed25519 identity public key.
  const peerIdPub = await crypto.subtle.importKey(
    "spki", b64dec(peerIdKeyB64), { name: "Ed25519" }, true, ["verify"],
  );

  // Generate a fresh X25519 ephemeral keypair.
  const ephKp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveKey", "deriveBits"]);
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephKp.publicKey));

  // Generate a fresh session nonce (used as HKDF salt and in AAD).
  const sessionNonce = crypto.getRandomValues(new Uint8Array(32));

  // Sign: ephPub ‖ myId ‖ peerId ‖ nonce
  const signData = buildSignData(ephPubRaw, _myUserId, peerUserId, sessionNonce);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", idKp.privateKey, signData));

  const sess = makeSession(dmChannelId, peerUserId);
  sess.phase = "offered";
  sess.sessionNonce = sessionNonce;
  sess.ephKeypair = ephKp;
  sess.peerIdPub = peerIdPub;
  sess.peerIdKeyB64 = peerIdKeyB64;
  sessions.set(dmChannelId, sess);

  _sendFn({
    type: "secret.offer",
    dm_channel_id: dmChannelId,
    eph: b64enc(ephPubRaw),
    sig: b64enc(sig),
    session_nonce: b64enc(sessionNonce),
  });
}

// acceptSecret completes the handshake for an incoming offer. Called when the
// user clicks Accept on the request banner.
export async function acceptSecret(dmChannelId, fromUserId, offer) {
  const { eph: peerEphB64, sig: sigB64, session_nonce: nonceB64, peerIdKeyB64 } = offer;

  const idKp = await ensureIdentityKey();

  // Import peer's Ed25519 identity public key.
  const peerIdPub = await crypto.subtle.importKey(
    "spki", b64dec(peerIdKeyB64), { name: "Ed25519" }, true, ["verify"],
  );

  // Verify the offer signature: ephPub ‖ peerId ‖ myId ‖ nonce
  const sessionNonce = b64dec(nonceB64);
  const peerEphRaw = b64dec(peerEphB64);
  const signData = buildSignData(peerEphRaw, fromUserId, _myUserId, sessionNonce);
  const valid = await crypto.subtle.verify("Ed25519", peerIdPub, b64dec(sigB64), signData);
  if (!valid) throw new Error("Offer signature verification failed.");

  // Import peer's X25519 ephemeral public key.
  const peerEphPub = await crypto.subtle.importKey(
    "raw", peerEphRaw, { name: "X25519" }, true, [],
  );

  // Generate our ephemeral keypair and derive the shared secret.
  const myEphKp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveKey", "deriveBits"]);
  const myEphPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", myEphKp.publicKey));

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: peerEphPub },
    myEphKp.privateKey,
    256,
  );

  const { sendChainKey, recvChainKey } = await deriveSessionKeys(
    new Uint8Array(sharedBits), sessionNonce, _myUserId, fromUserId,
  );

  // Sign our accept: myEphPub ‖ myId ‖ peerId ‖ nonce
  const acceptSignData = buildSignData(myEphPubRaw, _myUserId, fromUserId, sessionNonce);
  const acceptSig = new Uint8Array(await crypto.subtle.sign("Ed25519", idKp.privateKey, acceptSignData));

  // Check if the peer's key is already trusted.
  const trust = await getTrustRecord(fromUserId);
  const verified = !!(trust && trust.keyB64 === peerIdKeyB64);

  const sess = makeSession(dmChannelId, fromUserId);
  sess.phase = "active";
  sess.sessionNonce = sessionNonce;
  sess.peerIdPub = peerIdPub;
  sess.peerIdKeyB64 = peerIdKeyB64;
  sess.sendChainKey = sendChainKey;
  sess.recvChainKey = recvChainKey;
  sess.verified = verified;
  sessions.set(dmChannelId, sess);

  _sendFn({
    type: "secret.accept",
    dm_channel_id: dmChannelId,
    eph: b64enc(myEphPubRaw),
    sig: b64enc(acceptSig),
  });

  emit({ type: "session-active", dmChannelId, verified });
}

// declineSecret sends a session-end event to the peer and clears local state.
export function declineSecret(dmChannelId) {
  sessions.delete(dmChannelId);
  _sendFn({ type: "secret.end", dm_channel_id: dmChannelId });
}

// endSecret tears down an active session and notifies the peer.
export function endSecret(dmChannelId) {
  sessions.delete(dmChannelId);
  _sendFn({ type: "secret.end", dm_channel_id: dmChannelId });
  emit({ type: "session-ended", dmChannelId });
}

// sendSecretMessage encrypts `text` and sends it to the peer via secret.msg.
export async function sendSecretMessage(dmChannelId, text) {
  const sess = sessions.get(dmChannelId);
  if (!sess || sess.phase !== "active") throw new Error("No active secret session.");

  const { wire, nextChain } = await encryptMessage(
    text, _myUserId, sess.sendCounter, dmChannelId, sess.sessionNonce, sess.sendChainKey,
  );
  sess.sendChainKey = nextChain;
  sess.sendCounter++;

  const id = `s-${_myUserId}-${sess.sendCounter}`;
  sess.messages.push({ id, fromUserId: _myUserId, text, ts: Date.now() });

  _sendFn({ type: "secret.msg", dm_channel_id: dmChannelId, ...wire });

  return id;
}

// handleSecretEvent routes incoming secret.* WS events from the server.
export async function handleSecretEvent(evt, peerIdKeyResolver) {
  const p = evt.payload || {};
  const dmChannelId = p.dm_channel_id;

  if (evt.type === "secret.dismiss") {
    // Another of our own tabs accepted or declined the request; clear it here.
    const sess = sessions.get(dmChannelId);
    if (sess && sess.phase === "offered") {
      sessions.delete(dmChannelId);
    }
    emit({ type: "dismiss", dmChannelId });
    return;
  }

  if (evt.type === "secret.end") {
    const had = sessions.has(dmChannelId);
    sessions.delete(dmChannelId);
    if (had) emit({ type: "session-ended", dmChannelId });
    return;
  }

  if (evt.type === "secret.offer") {
    const fromUserId = p.from_user_id;
    // Glare resolution: if we have a pending outgoing offer and the other side
    // also sent one, the lower user_id's offer wins.
    const existing = sessions.get(dmChannelId);
    if (existing && existing.phase === "offered") {
      if (_myUserId < fromUserId) {
        // I have lower id: my offer stands, ignore theirs.
        return;
      }
      // Their id is lower: cancel my pending offer, treat theirs as the active one.
      sessions.delete(dmChannelId);
    }

    // Resolve the peer's identity key from app state (passed in by caller).
    const peerIdKeyB64 = peerIdKeyResolver ? peerIdKeyResolver(fromUserId) : null;

    // Store the offer details so acceptSecret can use them.
    const offer = {
      eph: p.eph,
      sig: p.sig,
      session_nonce: p.session_nonce,
      peerIdKeyB64,
    };

    // Register a pending incoming session.
    const sess = makeSession(dmChannelId, fromUserId);
    sess.phase = "incoming"; // distinguished from "offered" (outgoing)
    sess._pendingOffer = offer;
    sessions.set(dmChannelId, sess);

    emit({ type: "secret-request", dmChannelId, fromUserId, hasPeerKey: !!peerIdKeyB64 });
    return;
  }

  if (evt.type === "secret.accept") {
    const fromUserId = p.from_user_id;
    const sess = sessions.get(dmChannelId);
    if (!sess || sess.phase !== "offered" || sess.peerUserId !== fromUserId) return;

    // Resolve the peer's identity key from app state.
    const peerIdKeyB64 = peerIdKeyResolver ? peerIdKeyResolver(fromUserId) : null;
    if (!peerIdKeyB64) {
      sessions.delete(dmChannelId);
      emit({ type: "session-ended", dmChannelId });
      return;
    }

    try {
      // Import peer's Ed25519 identity public key.
      const peerIdPub = await crypto.subtle.importKey(
        "spki", b64dec(peerIdKeyB64), { name: "Ed25519" }, true, ["verify"],
      );

      // Verify accept signature: peerEphPub ‖ peerId ‖ myId ‖ sessionNonce
      const peerEphRaw = b64dec(p.eph);
      const signData = buildSignData(peerEphRaw, fromUserId, _myUserId, sess.sessionNonce);
      const valid = await crypto.subtle.verify("Ed25519", peerIdPub, b64dec(p.sig), signData);
      if (!valid) throw new Error("Accept signature verification failed.");

      // Import peer's X25519 ephemeral public key and perform ECDH.
      const peerEphPub = await crypto.subtle.importKey(
        "raw", peerEphRaw, { name: "X25519" }, true, [],
      );
      const sharedBits = await crypto.subtle.deriveBits(
        { name: "X25519", public: peerEphPub },
        sess.ephKeypair.privateKey,
        256,
      );

      const { sendChainKey, recvChainKey } = await deriveSessionKeys(
        new Uint8Array(sharedBits), sess.sessionNonce, _myUserId, fromUserId,
      );

      const trust = await getTrustRecord(fromUserId);
      const verified = !!(trust && trust.keyB64 === peerIdKeyB64);

      sess.phase = "active";
      sess.peerIdPub = peerIdPub;
      sess.peerIdKeyB64 = peerIdKeyB64;
      sess.sendChainKey = sendChainKey;
      sess.recvChainKey = recvChainKey;
      sess.verified = verified;
      sess.ephKeypair = null; // discard ephemeral private key — no longer needed

      emit({ type: "session-active", dmChannelId, verified });
    } catch (e) {
      sessions.delete(dmChannelId);
      emit({ type: "session-ended", dmChannelId });
    }
    return;
  }

  if (evt.type === "secret.msg") {
    const fromUserId = p.from_user_id;
    const sess = sessions.get(dmChannelId);
    if (!sess || sess.phase !== "active" || sess.peerUserId !== fromUserId) return;

    const wire = { ct: p.ct, nonce: p.nonce, counter: p.counter };

    // Replay protection: counter must be next expected.
    const { ok, nextExpected } = replayOk(sess.recvNextExpected, wire.counter);
    if (!ok) return; // duplicate or out-of-order — drop silently

    try {
      const { text, nextChain } = await decryptMessage(
        wire, fromUserId, dmChannelId, sess.sessionNonce, sess.recvChainKey,
      );
      sess.recvChainKey = nextChain;
      sess.recvNextExpected = nextExpected;

      const id = `s-${fromUserId}-${wire.counter}`;
      sess.messages.push({ id, fromUserId, text, ts: Date.now() });
      emit({ type: "message-received", dmChannelId, fromUserId, text, id, ts: Date.now() });
    } catch {
      // Decryption failure — drop, keep session alive (could be tampered frame).
    }
    return;
  }
}

// getPendingOffer returns the pending offer payload for an incoming request.
// Used by the accept flow in app.js to pass the offer to acceptSecret.
export function getPendingOffer(dmChannelId) {
  const sess = sessions.get(dmChannelId);
  return sess && sess.phase === "incoming" ? sess._pendingOffer : null;
}
