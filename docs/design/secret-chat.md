# Secret chat — OTR-style end-to-end encryption

**Status: shipped (migration `0015`).** A 🔒 you click on a DM that establishes a
live, end-to-end encrypted session with the other person. Encrypted in the browser,
the server sees only ciphertext, verified out-of-band by a safety number. No media
server analog — all the crypto is `SubtleCrypto` (WebCrypto), so **zero new
dependencies** on either side, consistent with the prime directive.

This is deliberately **not** the OMEMO-class feature in the backlog. The line
between "feasible polish feature" and "different product" is exactly the line
between the two, so the first job of this doc is to draw it.

---

## What this is, and what it is emphatically not

The backlog item ("Signal/OMEMO class — server stores only ciphertext,
multi-device, key+trust management") is XL because it tries to make E2E the
**durable, asynchronous, all-messages** model. That drags in ciphertext-at-rest
schema, multi-device key synchronisation, offline message queuing, history that
survives reload, and a search index that can't see content. That is a different
product and it is not what we are building.

What we are building is the original OTR use case: a **live, ephemeral,
session-to-session** encrypted conversation between two people who are both
online right now.

| | This feature | OMEMO-class (backlog, deferred) |
|---|---|---|
| When | Both parties online, live | Anytime, async |
| Lifetime | Ephemeral — gone on reload | Durable, full history |
| Storage | **Nothing** server-side | Ciphertext at rest |
| Devices | One browser tab per session | Multi-device key sync |
| Scrollback / search | None (by design) | Encrypted, complex |
| Server changes | One relay handler + one column | Schema, queues, key servers |
| Scope | A contained feature | A different product |

Accepting "ephemeral, live-only, one tab" is what keeps this small. Every place
that hurts (no history, no search, no multi-device) is a direct consequence of
that choice, and each is the thing that would otherwise explode the scope.

---

## Threat model — state it or the lock is theater

Be honest in the UI and the docs about what the 🔒 does and doesn't buy. This is
a self-hosted server for ~20 friends; the owner runs the box. The realistic
threats, in order:

**Defended:**

1. **Passive compromise of the server / database / backups.** With no plaintext
   and no keys ever touching the server, a stolen DB or disk image yields
   nothing for secret conversations. This is the main prize and we get it cheaply.
2. **A passive network observer** (already covered by TLS, but now also at the
   app layer — content is opaque even to a logged-in admin reading the DB).
3. **An active man-in-the-middle, *if and only if* the safety number is
   verified out-of-band.** Signed ephemeral keys + a verified identity key make
   undetected MITM impossible.

**Explicitly NOT defended (say so):**

1. **Metadata.** The server still sees *who* talks to *whom*, *when*, and rough
   message *sizes/timing*. E2E hides content, not the social graph. Hiding
   metadata is a different, much harder project.
2. **A malicious server against *unverified* peers.** If you never compare the
   safety number, a hostile server can substitute its own identity key for your
   peer and sit in the middle. Out-of-band verification is the *only* thing that
   closes this, which is why the verified/unverified distinction must be loud in
   the UI (green vs. yellow lock). An unverified lock means "encrypted, but you
   haven't checked who's on the other end."
3. **A compromised endpoint** (the friend's actual browser/machine). Nothing
   server-side helps here.
4. **Strong deniability.** Real OTR goes out of its way to be repudiable
   (malleable MACs, published keys). Our signed handshake gives the opposite —
   the signature is evidence you took part. For friends this is fine; we should
   not *claim* OTR-grade deniability. (See "Deniability" under non-goals.)

If the owner's threat model is "I trust my own box not to *actively* attack me;
I want protection against a breach, a stolen backup, or a future compromise,"
then even the unverified path delivers most of the value, and verification is
the upgrade for the paranoid pair.

---

## Primitives — WebCrypto only, compose don't invent

Everything is `crypto.subtle`. We never implement a cipher, a hash, or a curve;
we only compose them. This is the same posture as the Go side hand-rolling
PBKDF2 *on top of* `crypto/sha256` rather than inventing a hash.

| Job | Primitive | Why |
|---|---|---|
| Identity (long-term) | **Ed25519** signing keypair | Deterministic-nonce EdDSA; transparent (non-NIST) curve provenance |
| Key agreement (per session) | **X25519** ephemeral keypair | Twist-secure, misuse-resistant ECDH; cleanest public-key validation story |
| Key derivation | **HKDF-SHA-256** | Stretch the X25519 secret into directional message keys |
| Message encryption | **AES-256-GCM** | AEAD: confidentiality + integrity in one, binds associated data |
| Fingerprint | **SHA-256** of the raw public key | Safety-number basis |

**Curve choice — decided: X25519 + Ed25519, modern browsers only.** The
Curve25519 family has the cleaner pedigree (DJB-generated transparent constants
vs. NIST/NSA's unexplained P-256 seeds — no demonstrated break in P-256, but a
trust/optics call a privacy-minded host can fairly make) and better in-principle
misuse-resistance. The cost is browser support: `"X25519"` and `"Ed25519"` only
became universal across evergreen browsers in 2024–2025 (Safari ~17, Firefox
~129, Chrome ~133–137), so this is **explicitly a current-browser-only feature.**

We do **not** dual-stack with P-256 — a negotiated suite is extra code and a
downgrade-attack surface. Single suite, no negotiation. Instead, **feature-detect
at load**: probe `crypto.subtle` for Ed25519/X25519 support once; if absent,
the 🔒 button is disabled with a tooltip ("secret chat needs a current browser").
This degrades gracefully without ever falling back to a weaker primitive. The
curve still sits behind the key-helper functions, so a future change isn't a
one-way door (cost of switching = identity keys/fingerprints change → re-verify).

---

## Identity keys

Each user has a long-term **Ed25519 identity keypair**, generated on first use
of secret chat.

- **Private key:** generated `extractable: false` and stored in **IndexedDB**
  (CryptoKeys are structured-cloneable). Non-extractable means even an XSS bug
  can't exfiltrate it — it can only *use* it while the page is live. This is
  strictly better than localStorage, for free. (`format.js` is XSS-safe by
  construction already, but defense in depth costs nothing here.)
- **Public key:** exported as SPKI, base64'd, and **published to the server** so
  peers can fetch it before a chat. This is the *one* schema change:
  `users.identity_key` (text, nullable) + `identity_key_updated_at`. A public key
  is not a secret; the server storing it is fine. The risk is the server *lying*
  about it — caught by out-of-band verification.
- **Fingerprint / safety number:** `SHA-256(raw public key)`. For a pair, both
  sides compute the *same* number by hashing the two public keys in a canonical
  order (sorted by user id, concatenated). Render as Signal-style digit groups
  (e.g. 60 digits in 12 groups of 5) so friends can read it aloud or paste it
  over another channel.

**Clearing browser storage = a new identity** (new fingerprint; peers must
re-verify). Acceptable, but the UI should warn before anything destructive and
should surface a peer's key *change* as a revoked-verification warning, never
silently.

In-band TOFU (exchange identity keys during the handshake instead of via the
server) is possible and would save the column, but pre-distribution lets you
verify *before* you start talking, and the column is genuinely tiny. Recommend
the column.

---

## The handshake (authenticated ephemeral ECDH)

A minimal SIGMA-style exchange: ephemeral ECDH for forward secrecy, signed by the
long-term identity key so it can't be MITM'd by a verified peer.

```
Initiator (I)                         Responder (R)
  has: idKey_I (Ed25519), knows idPub_R
  generate ephemeral X25519 eI
  ─ secret.offer ──────────────────▶
     { eph: ePub_I,
       sig: Ed25519_idKey_I(ePub_I ‖ I ‖ R ‖ session_nonce) }
                                       verify sig against idPub_I
                                       generate ephemeral X25519 eR
  ◀──────────────── secret.accept ─
     { eph: ePub_R,
       sig: Ed25519_idKey_R(ePub_R ‖ R ‖ I ‖ session_nonce) }
  verify sig against idPub_R
  both: Z = X25519(eX_priv, ePub_peer)
  both: rootKey = HKDF(Z, salt=session_nonce, info="rivendell-otr-v1")
```

- The **signature binds the ephemeral key to a verified identity**, the session
  participants, and a fresh nonce. That is what stops a server-mounted MITM
  against a verified peer: the server can't forge `Sign_idKey_R(...)` without R's
  private identity key.
- **Identity key compromise does not reveal past content** — the identity key
  only *signs*, it never encrypts. Its compromise allows future impersonation,
  not retroactive decryption. Past sessions stay safe (forward secrecy from the
  discarded ephemerals).
- **Glare:** if both click 🔒 at once, reuse voice's deterministic rule — the
  **lower `user_id` is the initiator** (`voice.js` already does `myUserId <
  remoteUserId`). The higher id's offer is dropped.

---

## Message encryption + the ratchet

From `rootKey`, derive **two directional chain keys** via HKDF (one per sender),
so the two directions never share key material.

Per message, in the sending direction:

```
msgKey  = HKDF(chainKey, info = "msg" ‖ counter)        // unique per message
chainKey' = HKDF(chainKey, info = "chain")              // step the ratchet forward
ct = AES-GCM-Seal(msgKey, nonce = random96,
                  plaintext = text,
                  aad = sender_id ‖ counter ‖ dm_channel_id ‖ session_nonce)
wire = { ct, nonce, counter }                            // base64, opaque to server
```

- **Symmetric hash ratchet** (step `chainKey` each message): gives *within-session*
  forward secrecy — capturing the current chain key doesn't decrypt already-sent
  messages. Cheap, pure, unit-testable.
- We deliberately do **not** do a DH ratchet (no break-in recovery mid-session).
  That's the Double Ratchet, and it's the OMEMO rabbit hole. For a short live
  session it's overkill; note it as a conscious omission.
- **AEAD associated data** binds sender, counter, channel, and session so a
  ciphertext can't be replayed into another context or reordered undetectably.
  Receiver tracks the highest counter seen per session and rejects
  duplicates/rollbacks.
- **Never reuse a (key, nonce) pair** — per-message keys from the ratchet plus a
  random 96-bit nonce makes reuse astronomically unlikely; the unique key is the
  real guarantee.

Plaintext is the message text (and possibly the same markdown-lite we already
render — but render it through the existing XSS-safe `format.js` path; encryption
doesn't change escaping).

---

## Transport — the hub is a dumb relay (voice is the template)

This is the part that's already built. Voice signaling relays opaque SDP/ICE
blobs between the two DM members through the hub via `relayToUser` (which injects
`from_user_id` and `SendToUser`s the frame). The server does not understand
WebRTC payloads. Secret chat is structurally identical: relay opaque crypto blobs
between the two members. **The server never sees plaintext or keys.**

New relay events, handled exactly like `voice.*` in `handleVoiceWSMessage`
(`internal/httpapi/server.go`) — same DM-membership validation as `voice.ring`
(two members, sender is one of them, fail closed):

| Event | Direction | Payload (opaque to server) |
|---|---|---|
| `secret.offer` | initiator → peer | `{ eph, sig, session_nonce }` |
| `secret.accept` | peer → initiator | `{ eph, sig }` |
| `secret.msg` | either → other | `{ ct, nonce, counter }` |
| `secret.end` | either → other | `{}` |
| `secret.dismiss` | server → own siblings | `{ dm_channel_id }` |

- Validation reuses the `voice.ring` block almost verbatim: `GetChannel`,
  `IsDM`, `ListChannelMemberIDs == 2`, sender ∈ members, derive `otherID`,
  `relayToUser(otherID)`.
- **Zero DB writes** for messages. The only persistence anywhere is the public
  identity-key column. A DM with a secret conversation simply has no message rows
  for it.
- **No `logMW` content risk** — we never log payloads anyway, and these are
  ciphertext regardless.

---

## The multi-tab / multi-device question

A secret session is between two **connections**, not two **users** — and we lean
into that rather than fighting it.

- The identity *private key* lives in IndexedDB, shared across same-origin tabs.
  But the *session state* (ephemeral keys, chain keys) lives in JS memory, per
  tab. So **the secret session is bound to the one tab that established it.**
- Other tabs of the same user show the DM as "🔒 secret session active in another
  window" and do not participate. Plaintext never crosses tabs.
- This is honest to the OTR model (this conversation, here, now) and it
  **sidesteps multi-device key sync entirely** — the single biggest source of
  OMEMO complexity.

Settling the handshake on exactly one connection pair reuses the ring machinery
we just built:

1. `secret.offer` fans out to all the peer's connections (`SendToUser`).
2. Every peer tab shows an incoming-secret-request banner (like a ring).
3. Peer accepts in **one** tab → that tab sends `secret.accept`.
4. The accept fans back to all the initiator's tabs; only the tab holding the
   matching pending ephemeral completes the ECDH — the others have no pending
   handshake and ignore it.
5. The server sends `secret.dismiss` to the peer's *other* connections so their
   request banners clear — **identical to the `voice.ring_dismissed` fix from
   v1.2.32.** Same pattern, same reasoning (don't make a second tab join).

---

## What it costs the user (put this in the UI, not just the doc)

These are inherent to ephemeral E2E and should be visible, not surprising:

- **No history.** Reload the page and the secret conversation is gone — both the
  keys and the messages. Render a persistent "🔒 These messages are end-to-end
  encrypted and are not saved" notice in the secret view.
- **No search, no scrollback, no permalinks** for secret messages.
- **No mobile / future native client** until that client implements the same
  protocol. Web-only for now.
- **A current browser is required** (X25519/Ed25519 WebCrypto). On older
  browsers the 🔒 is disabled with an explanatory tooltip — never a silent
  fallback to a weaker scheme.
- **One device at a time** per session.
- **Both must be online.** If the peer is offline, the 🔒 can't establish; offer
  it only when they're connected.

---

## Footguns — the review checklist

Crypto fails silently, so these are non-negotiable review gates:

- [ ] **Unauthenticated DH = MITM.** Ephemeral keys MUST be signed by the
      identity key and verified. No "encrypt first, authenticate later."
- [ ] **Identity-key substitution is the core threat.** Verified vs. unverified
      MUST be unmistakable in the UI. A key *change* revokes verification loudly.
- [ ] **(key, nonce) reuse in AES-GCM is catastrophic.** Per-message keys +
      random nonce; never reuse.
- [ ] **AAD binds context** (sender, counter, channel, session) — else replay /
      reflection across contexts.
- [ ] **Counter monotonicity** enforced on receive; reject rollback/dupes.
- [ ] **Non-extractable identity private key** in IndexedDB.
- [ ] **All primitives are SubtleCrypto.** We compose; we do not implement.
- [ ] **Be honest about metadata and deniability** in copy and docs.

---

## Non-goals (the scope fence)

- Persistence / message history / ciphertext at rest.
- Asynchronous (offline) delivery.
- Multi-device, key sync, sealed sender.
- Double Ratchet (DH ratchet / break-in recovery).
- Strong cryptographic deniability. (If we ever want it: encrypt-then-MAC with a
  shared MAC key and publish spent MAC keys — more machinery, separate pass.)
- Group / channel E2E. This is 1:1 DM only.

Each of these is where "feasible polish feature" turns back into "different
product." Holding this fence is what keeps the feature shippable; everything under
it is punted to the separate OMEMO design pass. The key decisions behind the shape
above — unverified-allowed with an upgrade-to-verified path, the X25519 + Ed25519
single suite, the `users.identity_key` server column, and the within-session
symmetric ratchet — are each explained where they apply (Threat model, Primitives,
Identity keys, Message encryption).
