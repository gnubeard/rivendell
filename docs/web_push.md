# Web Push — offline notifications design

Target: a rivendell tab that's been **closed** — laptop asleep, phone in a
pocket — still surfaces a DM or an @-mention as an OS notification, and tapping
it opens straight to the message. This is the "full circle" from the foreground
notifications we already ship (`notify.js`, which only fires while a tab is
alive).

Like every other crypto-touching feature in this repo (RFC 6455, PBKDF2, OTR),
the protocol is **composed from the standard library** — no `webpush-go`, no
JWT library. Go 1.26 gives us `crypto/ecdh` and `crypto/hkdf`, which is exactly
the toolbox Web Push needs. **Zero new Go or JS dependencies**, consistent with
the prime directive.

---

## What this is, and what it is not

| | Foreground notifications (shipped) | Web Push (this doc) |
|---|---|---|
| When | A tab is open (focused or backgrounded) | App fully closed |
| Who decides to show it | The client (`firePing`) | The **server**, then the service worker |
| Transport | The existing WebSocket | The browser's push service (FCM/Mozilla/Apple) |
| Requires | `Notification` permission | Permission + a **service worker** + a push subscription |
| Server work | None (client-driven) | Encrypt + sign + POST per recipient |

The two are complementary and we route between them by **connectivity**: if a
ping recipient has a live WebSocket, the foreground path already covers them and
we send no push; if they're disconnected, the server sends a push. No double
notification.

This is **not** the OMEMO-class backlog item. Push payloads carry the same
plaintext the server already stores for normal messages. Secret-chat (OTR)
messages are never persisted and never travel through `handleCreateMessage`, so
they generate **no** push — there is nothing to leak.

---

## Threat model / honesty

- Push payloads are encrypted end-to-end **to the browser's push subscription**
  (RFC 8291): the push service (Google/Mozilla/Apple) relays ciphertext it can't
  read. But the *rivendell server* composes the plaintext, exactly as it already
  does to store and broadcast the message. Push adds no new server-side exposure
  beyond what message storage already implies.
- VAPID (RFC 8292) authenticates *us* to the push service and lets the service
  rate-limit/contact the operator. It is not a secret-bearing channel.
- A stolen push subscription (endpoint + keys) lets an attacker send that
  browser notifications. Subscriptions are per-device, scoped to the user, and
  pruned aggressively on `404`/`410`. They are no more sensitive than a session.

---

## Primitives — stdlib only, compose don't invent

| Purpose | Primitive | Go package |
|---|---|---|
| Application-server identity (VAPID) | ECDSA P-256 + ES256 JWT | `crypto/ecdsa`, `crypto/sha256` |
| Per-message key agreement | ECDH P-256 | `crypto/ecdh` |
| Key derivation | HKDF-SHA-256 | `crypto/hkdf` |
| Payload AEAD | AES-128-GCM | `crypto/aes`, `crypto/cipher` |
| Content coding framing | `aes128gcm` (RFC 8188) | hand-assembled bytes |

Two **distinct** EC keys are in play and must not be conflated:

1. **VAPID key** — long-lived, identifies this server. ECDSA P-256. Its public
   point is the browser's `applicationServerKey` and the `k=` of the
   `Authorization` header. Used only to **sign** the VAPID JWT. Persisted in the
   DB so it survives restarts (changing it invalidates every live subscription).
2. **Message ephemeral key** — fresh ECDH P-256 keypair **per push**. Its public
   point is the `keyid` in the `aes128gcm` header. Used only for ECDH against the
   subscription's `p256dh`. Never stored.

---

## Encryption — RFC 8291 over RFC 8188 (`aes128gcm`)

Per push, given the subscription's `p256dh` (UA public point, 65 bytes) and
`auth` (16-byte secret):

```
as          = fresh ECDH P-256 keypair          # as.public is 65 bytes uncompressed
ecdh_secret = ECDH(as.private, ua_public)        # 32 bytes (X coord)
salt        = 16 random bytes

# RFC 8291 §3.4 — fold the auth secret and both public keys into the IKM
key_info    = "WebPush: info" || 0x00 || ua_public || as.public
PRK_combine = HKDF-Extract(salt = auth_secret, IKM = ecdh_secret)
IKM         = HKDF-Expand(PRK_combine, key_info, 32)

# RFC 8188 §2.2 — derive CEK + nonce from the message salt
PRK   = HKDF-Extract(salt = salt, IKM = IKM)
CEK   = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)
NONCE = HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12)

# RFC 8188 §2 — one record, last-record delimiter 0x02, no extra padding
ciphertext = AES128GCM(key = CEK, nonce = NONCE, plaintext = payload || 0x02)

# RFC 8188 §2.1 — content-coding header, keyid = as.public
header = salt(16) || rs(uint32 be = 4096) || idlen(uint8 = 65) || as.public(65)
body   = header || ciphertext
```

`body` is the request entity, sent with `Content-Encoding: aes128gcm`. The
derivation is implemented in `encryptPayload`, which takes the salt and ephemeral
key as **parameters** so it is fully deterministic and unit-testable against an
RFC 8291 round-trip (encrypt here, decrypt with the UA private key in the test).

---

## VAPID — RFC 8292

Each request carries `Authorization: vapid t=<JWT>, k=<base64url(vapid_public)>`.

The JWT is ES256:

```
header  = {"typ":"JWT","alg":"ES256"}
claims  = {"aud": <scheme://host of endpoint>, "exp": <now + ≤24h>, "sub": <RIVENDELL_VAPID_SUBJECT>}
signing input = base64url(header) || "." || base64url(claims)
signature     = ECDSA-P256-SHA256(signing input)  →  raw r||s (64 bytes), base64url
JWT     = signing input || "." || base64url(signature)
```

The signature is **JOSE raw `r||s`**, *not* ASN.1 DER — `ecdsa.Sign` gives the
big.Ints, we left-pad each to 32 bytes and concatenate. `aud` is recomputed per
endpoint (push services reject a mismatched audience).

---

## Storage (migration `0016_push.sql`)

```sql
CREATE TABLE push_subscriptions (
    id           BIGSERIAL   PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint     TEXT        NOT NULL UNIQUE,   -- the push service URL
    p256dh       TEXT        NOT NULL,          -- UA public key, base64url (65-byte point)
    auth         TEXT        NOT NULL,          -- UA auth secret, base64url (16 bytes)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

CREATE TABLE push_vapid (              -- single row; the server's VAPID identity
    id          INT         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    private_key TEXT        NOT NULL,  -- PKCS#8, base64 (server secret)
    public_key  TEXT        NOT NULL,  -- uncompressed point, base64url (applicationServerKey)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`endpoint` is `UNIQUE` so a re-subscribe upserts (refreshing keys) instead of
duplicating. VAPID keys are generated once on first boot and persisted, so a
restart keeps existing subscriptions valid; no operator key management required.

---

## Server send path

The hook is `recordPings` / `handleCreateMessage`: the recipient set is already
computed there (DM members or @-mentioned members, minus the author). For push:

```
recipients = pingRecipients(...)            # already exists
for r in recipients:
    if hub.IsConnected(r):   continue       # foreground path covers them
    if store.IsChannelMuted(r, channel): continue
    for sub in store.ListPushSubscriptions(r):
        go sender.Send(sub, payload)        # async; 404/410 → delete sub
```

- **Gated on connectivity.** A disconnected recipient is the whole point; a
  connected one is handled by `firePing` over the WS.
- **Respects mutes.** A muted channel pushes nothing (mute is a full silence).
- **Async + best-effort.** Sends run in a goroutine off the request path with
  their own timeout. A push service being slow never slows a message POST.
- **Self-pruning.** A `404`/`410` from the push service means the subscription is
  dead; we delete it. Anything else is logged and dropped.

Payload JSON (read by the service worker): `{title, body, channelId, url, tag}`.
`url` is `/#c<channelId>/m<messageId>` (the existing permalink format, so the SW
deep-link reuses `parsePermalink`). `tag` is `rivendell-ch-<channelId>` so repeat
pings for one channel collapse, matching the foreground `tag`.

---

## Client

- **`web/sw.js`** — a standalone service worker. `push` → parse JSON →
  `registration.showNotification`. `notificationclick` → focus an existing tab
  (and `postMessage` it the target) or `clients.openWindow(url)`. The
  `openWindow`/`focus` must run inside `event.waitUntil` per the spec.
- **Subscription flow** lives behind the existing **Desktop notifications**
  toggle — enabling it now also (a) registers the SW, (b)
  `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` using
  the key from `GET /api/push/key`, and (c) POSTs the subscription to
  `POST /api/push/subscribe`. Disabling unsubscribes and `POST
  /api/push/unsubscribe`. Foreground notifications keep working independently; if
  push setup fails (older browser, blocked SW) the foreground path is unaffected.
- **Foreground prefers the SW too:** once registered, `showNotification` routes
  through `registration.showNotification` (works on Android, where
  `new Notification()` throws), falling back to the constructor.
- **`web/manifest.json`** + `<link rel="manifest">` and an apple-touch-icon so
  the app is installable — **iOS only delivers Web Push to an installed PWA**
  (16.4+). Desktop Chrome/Firefox/Edge and Android work without install.

Pure, unit-tested helpers in `notify.js`: `urlBase64ToUint8Array` (VAPID key
decode for `applicationServerKey`) and `pushSubscriptionPayload` (PushSubscription
→ the `{endpoint, keys}` body we POST).

---

## Footguns — the review checklist

- **VAPID JWT signature is raw `r||s`, never DER.** `ecdsa.SignASN1` is wrong
  here; pad-and-concat the big.Ints.
- **`aud` is per-endpoint** (scheme+host only). A cached/global `aud` gets
  rejected by Mozilla/Apple.
- **Two different keys.** VAPID = ECDSA, signs the JWT. Ephemeral = ECDH, per
  message, is the `keyid`. Reusing one for the other is a silent break.
- **`key_info` order is `ua_public || as_public`** (receiver first). Reversing it
  yields a CEK the browser can't derive — decrypts to garbage, no error here.
- **Single-record delimiter is `0x02`** (last record), appended before GCM. Not
  `0x00`, not omitted.
- **Don't push to connected users** — double notification. Gate on
  `hub.IsConnected`.
- **Don't push muted channels.**
- **`userVisibleOnly: true`** is mandatory in Chrome or `subscribe` rejects.
- **Prune on 404/410.** Dead subscriptions otherwise accumulate forever and waste
  a POST per message.

---

## Build order

1. `internal/push`: VAPID keygen/encode, JWT, `encryptPayload`, `Send`. Unit
   tests (RFC 8291 round-trip, JWT verify, header framing) need no DB.
2. Migration `0016` + store queries.
3. Config (`RIVENDELL_VAPID_SUBJECT`), boot wiring (load/gen keys → `push.Sender`),
   endpoints, send hook, `hub.IsConnected`.
4. `sw.js`, `manifest.json`, `notify.js` helpers, `app.js` wiring.
5. Tests green (Go + web), version bump, docs.

## Non-goals

- Pushing secret-chat (OTR) content — by construction it never reaches the server.
- A separate push opt-in distinct from the notification toggle — one switch.
- Per-device subscription management UI — subscriptions self-prune.
- Operator VAPID key rotation tooling — keys are DB-persisted and stable.
