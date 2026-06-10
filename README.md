# rivendell

A self-hosted chat server for a small group of friends — a minimal, private
alternative to Discord and Slack. Ships as a single Go binary backed by Postgres
with a vanilla-JS web client and no frontend dependencies.

- **Backend:** Go 1.26, stdlib only + `github.com/lib/pq` (one dependency, zero transitive)
- **Frontend:** Vanilla JS, no framework, no bundler, no npm packages
- **Database:** PostgreSQL, embedded migrations, no migration tool dependency

---

## Features

- Public and private channels (with topics), direct messages
- Roles: admin / moderator / member
- Realtime messaging over WebSocket (hand-rolled RFC 6455)
- Edit and soft-delete messages, pinned messages, scrollback with keyset pagination
- Emoji reactions, with instance-wide custom `:shortcode:` emoji
- Full-text message search, scoped to your accessible channels
- @-mentions with inline autocomplete, and live typing indicators
- Presence and status (online / away / do not disturb / invisible, with auto-idle)
- Unread indicators with DM chime, per-channel/DM mute, and opt-in desktop notifications
- Message permalinks — every timestamp links to that point in history
- Voice channels and 1:1 voice calls — P2P WebRTC mesh, no media server (STUN/TURN configurable)
- Image and file uploads — content-addressed blob store, paste/drop/attach, inline rendering
- Inline markdown links and image embeds, with link previews for select hosts
- Avatars (PNG, JPEG, WebP, GIF) and per-user UI themes
- Bot accounts with permanent Bearer tokens for scripting against the API
- Magic-link onboarding — no email server required; admins mint single-use links
- Soft-delete channels with admin restore or hard purge
- Private-channel invites
- Admin panel with instance stats (users, channels, messages, live connections)

---

## Requirements

- **Go 1.26+** (only needed to build from source)
- **PostgreSQL 14+**
- **Node.js** (only for running the frontend tests)

---

## Quick start

### Docker / Podman

```sh
# build
podman build -t rivendell:latest .

# postgres (skip if you already have one)
podman run -d --name rivendell-pg \
  -e POSTGRES_USER=chat \
  -e POSTGRES_PASSWORD=changeme \
  -e POSTGRES_DB=chat \
  -p 5432:5432 \
  postgres:16-alpine

# run
podman run --rm --network host \
  -e RIVENDELL_DATABASE_URL="postgres://chat:changeme@localhost:5432/chat?sslmode=disable" \
  -e RIVENDELL_PUBLIC_URL="http://localhost:8080" \
  rivendell:latest
```

On first boot the server creates the `admin` user (configurable via
`RIVENDELL_BOOTSTRAP_ADMIN`) and logs a one-time set-password link. Copy it into
your browser to finish setup.

### From source

```sh
git clone https://github.com/gnubeard/rivendell.git
cd rivendell
make build    # → ./bin/rivendell
make run      # build + run against the dev DB
```

The dev database defaults to
`postgres://chat:chat_dev_pw@localhost:5432/chat?sslmode=disable`.
Override with `RIVENDELL_DATABASE_URL`.

---

## Configuration

All configuration is via environment variables. All are optional except
`RIVENDELL_DATABASE_URL` in production. Copy `.env.example` to `.env` and adjust.

| Variable | Default | Description |
|---|---|---|
| `RIVENDELL_DATABASE_URL` | `postgres://chat:chat_dev_pw@localhost:5432/chat?sslmode=disable` | **Required in production.** Postgres connection string. |
| `RIVENDELL_ADDR` | `:8080` | Listen address. |
| `RIVENDELL_PUBLIC_URL` | `http://localhost:8080` | Base URL used to build magic links. No trailing slash. |
| `RIVENDELL_WEB_DIR` | `web` | Path to the static web client. |
| `RIVENDELL_COOKIE_SECURE` | `false` | Set the `Secure` flag on session cookies. Enable when behind TLS. |
| `RIVENDELL_SESSION_TTL` | `720h` | Session lifetime (Go duration syntax: `720h`, `30m`, etc.). |
| `RIVENDELL_MAGIC_LINK_TTL` | `72h` | Set-password link lifetime. |
| `RIVENDELL_MAX_MESSAGE_BYTES` | `8000` | Reject messages larger than this. |
| `RIVENDELL_MAX_AVATAR_BYTES` | `524288` | Reject avatar uploads larger than this (bytes; 512 KiB). |
| `RIVENDELL_MAX_IMAGE_BYTES` | `5242880` | Reject image/file uploads larger than this (bytes; 5 MiB). |
| `RIVENDELL_BLOBS_DIR` | `blobs` | Directory for content-addressed uploaded blobs. |
| `RIVENDELL_INSTANCE_NAME` | `rivendell` | Display name for this instance — shown as the page title and brand. |
| `RIVENDELL_BOOTSTRAP_ADMIN` | `admin` | Username auto-created on first boot when no admins exist. |
| `RIVENDELL_STUN_URL` | `stun:stun.l.google.com:19302` | STUN server for WebRTC voice. |
| `RIVENDELL_TURN_URL` | _(none)_ | Comma-separated TURN endpoints (e.g. `turn:turn.example.com:3478`). Omit for STUN-only. |
| `RIVENDELL_TURN_SECRET` | _(none)_ | Shared HMAC secret for time-limited coturn (TURN) credentials. |

---

## Development

```sh
make test       # Go tests + frontend tests
make test-go    # Go tests only
make test-web   # Frontend tests only (Node built-in runner)
make fmt        # gofmt
make vet        # go vet
```

Go integration tests hit a real database and are gated on `TEST_DATABASE_URL`.
Spin up a throwaway instance:

```sh
podman run -d --name rivendell-test-pg \
  -e POSTGRES_USER=chat \
  -e POSTGRES_PASSWORD=chat_dev_pw \
  -e POSTGRES_DB=chat_test \
  -p 55432:5432 \
  postgres:16-alpine

export TEST_DATABASE_URL='postgres://chat:chat_dev_pw@localhost:55432/chat_test?sslmode=disable'
make test-go
```

---

## Nginx deployment

Two things are required for WebSocket support:

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
    }

    # WebSocket — must be a separate location block.
    location /api/ws {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

If you set a `Content-Security-Policy` header, add the `wss://` origin explicitly
to `connect-src`. Firefox does not expand `'self'` to cover `ws/wss`.

When behind TLS, also set:

```sh
RIVENDELL_COOKIE_SECURE=true
RIVENDELL_PUBLIC_URL=https://chat.example.com
```

---

## Architecture

```
cmd/server/main.go            entrypoint; flags; first-boot bootstrap
internal/config/config.go     env-var config (all RIVENDELL_* vars)
internal/auth/                password.go (PBKDF2), token.go (random+hash)
internal/store/               store.go (open/migrate + domain structs),
                              queries.go (all SQL), migrations/0001_init.sql
internal/ws/                  websocket.go (RFC 6455), hub.go (fan-out + presence)
internal/httpapi/             server.go (routes/middleware/realtime),
                              handlers.go (handler bodies)
internal/push/                push.go (Web Push: VAPID + RFC 8291/8188, stdlib only)
web/index.html                single-page shell (login / set-password / app views)
web/static/                   app.js, api.js, ws.js, format.js, state.js,
                              voice.js, secret.js, notify.js, syntax.js, style.css
web/sw.js                     service worker (Web Push display + click routing)
web/manifest.json             PWA manifest (installability; iOS push needs install)
web/test/                     format.test.js, state.test.js, voice.test.js,
                              secret.test.js, notify.test.js, reactions.test.js,
                              ws.test.js (node:test)
docs/                         otr.md, voice.md, video.md, web_push.md — design docs
```

Module path `rivendell`; Go 1.26. Imports are `rivendell/internal/...`.

---

## Developer conventions

### Core rules

- **List endpoints must return `[]`, never `null`.** A `var out []T` that's never appended to marshals as JSON `null`, and the client's `for...of` throws on it. Initialize as `out := []T{}`. `TestEmptyListsReturnArraysNotNull` enforces this.
- **Auth:** session cookie `rivendell_session` (HttpOnly, SameSite=Lax, Secure from config). Tokens are random 256-bit, stored only as SHA-256 hashes. New accounts use the invitation flow; password set/reset uses single-use magic links.
- **Passwords:** `internal/auth/password.go`, format `pbkdf2-sha256$<iter>$<b64salt>$<b64key>`, 600k iterations, constant-time compare.
- **Roles:** admin > moderator > member (`roleRank` in handlers). Guard against removing the last admin (`CountAdmins`).
- **Realtime:** the hub broadcasts `{type, payload}` events. Private-channel events are scoped to an audience set (`audienceForChannel`, fail-closed). That set must mirror `canAccessChannel`: for a non-DM private channel it includes all moderators/admins so an admin posting in a channel they aren't a member of still gets their own broadcast echo. DMs are strictly members-only. `/api/ws` is deliberately not logged by `logMW` (preserves the Hijacker) — its absence from logs is expected.
- **Presence vs. status:** `users.status` is the user's durable chosen presence (online/away/dnd/offline), written **only** by `handleSetStatus`. `onPresenceChange` must never write it back to the column — doing so was a bug that reset away/dnd on reconnect. `TestStatusDurableAcrossReconnect` guards it. Effective `online` = connected AND status != "offline". Bots derive online from `users.status` directly (they never hold a WebSocket).
- **Presence is debounced client-side (~1s).** `schedulePresenceUpdate` holds updates per user for `PRESENCE_DEBOUNCE_MS`. Own user is exempt (applied immediately). Pending flips are flushed in `resync()`. Don't simplify to immediate apply.
- **Frontend:** keep `format.js` and `state.js` pure and unit-tested. `format.js` is XSS-safe — escape first, then a fixed markdown-lite pass on the escaped string. Never invert this ordering. The CSS relies on `[hidden] { display: none !important; }`. Wire controls before `startRealtime()`. App layout: `grid-template-rows: 100%` + `overflow: hidden` on the root grid; `min-height: 0` on `.sidebar`, `.main`, `.members`, `.message-list`.

---

## Feature design notes

### Signup invitations (migration `0017`)

New accounts are self-service via admin-issued, single-use invitation links.

- `invitations` stores the token's SHA-256 hash, `created_by`, `expires_at`, `used_at`/`used_by`. TTL reuses `RIVENDELL_MAGIC_LINK_TTL`. **This table is distinct from `magic_links`** (which set/reset existing users' passwords) — don't merge them.
- Admin endpoints: `POST /api/admin/invitations` (mint; raw token shown once), `GET /api/admin/invitations` (list; no token), `DELETE /api/admin/invitations/{id}` (revoke).
- Public endpoints: `GET /api/auth/invitation/{token}` (peek validity), `POST /api/auth/signup` `{token,username,password}` (creates account, auto-logs in). New user always starts as member; display name defaults to username.
- Account creation + invitation consumption are one transaction (`store.RedeemInvitation`): duplicate username aborts before the invitation is touched (→ 409); invalid/used/expired token rolls back the new account (→ 404).
- Tests: `TestInvitationSignupFlow`, `TestInvitationRevoke`, `TestInvitationSignupValidation`.

### DMs (migration `0002`)

A DM is a private channel with `is_dm = TRUE` and exactly two members.

- Canonical name `dm-<minUserId>-<maxUserId>` maps a pair to exactly one channel; `UNIQUE(name)` makes create-or-find race-safe (`store.GetOrCreateDM`, `POST /api/dms`).
- Members-only — moderators/admins cannot see another pair's DM. `handleListChannels` and `canAccessChannel` special-case `is_dm`.
- The client derives the "other" participant from the channel name (`dmParticipants`/`otherDMParticipant` in state.js, unit-tested).

### Private-channel invites

`GET`/`POST /api/channels/{id}/members`. Moderators+ only; real private channels only — public returns 400, DMs 403. Adding a member re-broadcasts `channel.new` to the larger audience.

### Pinned messages (migration `0004`)

`pinned_at`/`pinned_by` on `messages`. Pin/unpin is moderator+ (`PUT`/`DELETE /api/messages/{id}/pin`). Broadcasts `message.update` — no new event type. The pins modal fetches its own list (pinned message may predate the loaded window).

### Deleted-channel restore/purge

Channel delete is soft (`archived_at`); `UNIQUE(name)` reserves the name. Admin-only: `GET /api/admin/channels/archived`, `POST …/{id}/restore`, `DELETE …/{id}` (hard delete — cascades; refuses live channels).

### Scrollback / history

Keyset pagination: `GET …/messages?before=<id>&limit=<n>`. Client loads 50 on open; fetches older on scroll-near-top (`loadOlderMessages`). Short page = `historyComplete`. `renderMessages` preserves scroll position; auto-scrolls to bottom only if already there.

### Unread indicators

`state.unread` (channelId→count). `message.new` on a non-active channel that isn't your own bumps it. Soft DM chime (Web Audio) for DMs.

### Reactions (migration `0009`)

`message_reactions` PK `(message_id, user_id, emoji)`. Add is idempotent (`ON CONFLICT DO NOTHING`). `PUT`/`DELETE /api/messages/{id}/reactions`. Deleted messages return 409. Validation: known shortcode or `validUnicodeEmoji`. One realtime event `reaction.update` carries re-aggregated groups. **A `message.update` that omits `reactions` must preserve existing ones** (`addMessage` guards this, unit-tested). `toggleReaction` takes the pill's known `mine` — don't regress to a `findMessage` lookup.

### Channel topics

Editable inline by moderator+ (`PATCH /api/channels/{id}`, broadcasts `channel.update`). `renderChannelHeader()` is the single paint point. `channel.update` for the active channel repaints the header but skips it while an edit input is open.

### Inline message editing

`renderMessages` is the source of truth — a message whose id == `editingMessageId` draws the inline editor. Before each `innerHTML` reset it captures the live draft + caret + focus and restores them. Don't "simplify" to preserving a DOM node. Enter saves / Shift+Enter newline / Esc cancels; empty draft on own most-recent message deletes it silently.

### Markdown links + inline images

`format.js` extracts links from each escaped run *before* the markdown pass — `inlineMarkup` runs only on the gaps between links. A URL never feeds through the italic rule. Don't refactor to a single regex sweep that linkifies last. `formatMessage(..., {embedImages:false})` for search rows only.

### Voice / WebRTC (phases 1–4 complete)

P2P mesh over WebRTC, signaled through the existing WS hub. No media server; no new Go deps.

- **Offerer = lower user_id; Perfect Negotiation on top.** `onVoiceState` uses `myUserId < remoteUserId` for the initial offer. Everything after uses Perfect Negotiation with the same role mapping (lower = impolite).
- **Initial offer belongs to `onVoiceState` alone.** `sendOffer` (the `negotiationneeded` path) returns early while `!pc.remoteDescription`. Letting both offer at setup causes glare + ICE stall.
- **Glare re-offer is ONE-SHOT** (`renegotiatePending` flag in `onOffer`). Do NOT wire to `signalingstatechange` — both peers re-offer in lockstep and oscillate, breaking both video directions.
- **DM calls end for both parties.** `endDMVoiceCall`/`cleanupVoiceForUser` removes both participants. `TestDMCallEndsForBothParties` / `TestVoiceChannelLeaveKeepsOthers` guard both sides.
- **TURN credentials are HMAC-SHA1, not SHA256.** coturn validates with SHA1. `TestRTCCredentials` asserts the 20-byte digest.
- **Both `onconnectionstatechange` AND `oniceconnectionstatechange`** feed `effectiveConnectionState`. Firefox reports ICE failure before (sometimes instead of) connection state.
- ICE disconnect grace is 5 s on purpose — don't shorten.
- Video bitrate cap (800 kbps, `applyVideoBitrateCaps`) is a stability cap, NOT a freeze fix.
- Per-user volume uses `audio.volume`, not a Web Audio GainNode (Chromium no-output bug with WebRTC+WebAudio).
- Teardown is synchronous (`finishTeardown` → `closeAllPeers` before farewell-tone await). `callGen` guards rapid re-join from colliding with stale teardown.
- Pure helpers all unit-tested in `voice.test.js`. E2E: `make test-e2e` (Playwright, not part of `make test`).
- REST: `GET /api/voice/state`, `GET /api/channels/{id}/voice`, `GET /api/rtc/credentials`.

### Theme (migration `0012`)

`users.theme` persisted via `PATCH /api/me`. Defaults to `"default"`. Validated against a known list. Returned on all user objects.

### User profiles (migration `0018`)

`users.pronouns` (≤32 chars) + `users.bio` (≤1000 chars). Edited via `PATCH /api/me`. Ride on every user object — no separate profile endpoint. Bio rendered through `formatMessage(..., {embedImages:false})`.

### Bot tokens / is_bot flag (migration `0013`)

Bots are users with `is_bot = true`. `PUT /api/admin/users/{id}/bot`. Bot tokens are permanent Bearer credentials managed at `GET/POST/DELETE /api/admin/bot-tokens`. Bots never hold a WebSocket connection — their online status comes from `users.status`, not hub presence.

### Link preview proxy — removed

The server-side OpenGraph scraper was deleted (SSRF surface, half-dead from deploy IP). **No arbitrary-URL server-side fetch remains.** Client-side YouTube embeds and same-origin message-permalink embeds were deliberately kept.

### File / image uploads (migration `0014`)

Content-addressed blobs at `blobs/<2-hex-prefix>/<sha256>`. `POST /api/uploads`: `MaxBytesReader` before reading; content type sniffed with `http.DetectContentType` (never trusts header); allowlists png/jpeg/webp/gif. `GET /api/blobs/{hash}` is session-gated; hash validated as 64-char lowercase hex (path-traversal immunity); `Cache-Control: private, max-age=31536000, immutable`. Writes are atomic (tmp + rename). Same bytes → same hash → one file (idempotent). Composer: uploads surface as preview tiles in `#composer-attachments`; send is blocked while any upload is in flight.

### Secret chat / OTR-style E2E encryption (migration `0015`)

Ephemeral, session-scoped E2E encryption for DMs. See `docs/otr.md` for the full design.

- All crypto is SubtleCrypto: Ed25519 (identity), X25519 (ephemeral ECDH), HKDF-SHA-256, AES-256-GCM.
- Identity private key is non-extractable in IndexedDB. `users.identity_key` holds the SPKI-encoded public key.
- Offerer = lower user_id (same glare rule as voice).
- Handshake: authenticated ephemeral ECDH (SIGMA-lite). Each party signs their X25519 pubkey with their Ed25519 identity key.
- Message crypto: symmetric hash ratchet (HKDF chain). Per-message nonce. AAD binds sender, counter, channel, session nonce.
- Sessions are JS-memory-only — reloading ends the session. Server relays `secret.*` frames opaque.
- No fallback to weaker primitives — ever.
- Verified (green) vs. unverified (yellow). Peer key change revokes verification loudly.
- Multi-tab sibling dismiss via `secret.dismiss` (same pattern as `voice.ring_dismissed`).
- Pure helpers unit-tested in `secret.test.js`.

### Notifications + Web Push (migration `0016`)

Foreground notifications (`notify.js`) while alive; Web Push for DMs/@-mentions when closed. See `docs/web_push.md`.

- All push crypto is stdlib (`internal/push`): VAPID = ECDSA P-256 ES256 JWT (RFC 8292); payload = RFC 8291 `aes128gcm` (RFC 8188).
- Two distinct keys: VAPID key (long-lived, persisted in `push_vapid`) and message ephemeral key (fresh per push).
- **JWT signature is JOSE raw `r||s` (64 bytes), never DER.** `aud` recomputed per endpoint (scheme://host).
- Pushes only to disconnected users. Runs in goroutine — never slows message send. 404/410 prunes subscription.
- Secret chat is never pushed.
- iOS needs installed PWA (16.4+). `firePing` prefers `registration.showNotification`.
- `web/sw.js` is notifications-only — no fetch caching.

### WebRTC debug telemetry

Diagnostic path for video calls. Gated by `RIVENDELL_DEBUG_TELEMETRY` (default off → endpoint returns 404).

- Per-client activation via `?rtcdebug=1` / localStorage, or operator-forced via `debug_telemetry:true` in `GET /api/instance`.
- `self_user_id` is never sent — server stamps it from the session. No candidate IP ever logged.
- Telemetry capture runs off the media path on a 3 s timer. `voice.js` accesses it only via `dbg`/`dbgEvent` indirection (null in prod/tests) — never import `rtcdebug.js` from `voice.js`.
- Server logs via `slog` TextHandler (logfmt): `msg=rtc-telem.snap`/`rtc-telem.evt`.

---

## Backlog

- **[XL] OMEMO-class E2E (not OTR).** Ciphertext at rest, async delivery, multi-device key sync, encrypted scrollback/search. Separate design pass — see `docs/otr.md` "Non-goals for v1.3".
- **EXIF stripping on uploaded images.** Must happen before hashing. No new deps.

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).
