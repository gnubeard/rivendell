# Feature design notes

Implementation details and invariants for each major subsystem. Intended for contributors — a summary of why things are wired the way they are.

---

## Signup invitations (migration `0017`)

New accounts are self-service via admin-issued, single-use invitation links.

- `invitations` stores the token's SHA-256 hash, `created_by`, `expires_at`, `used_at`/`used_by`. TTL reuses `RIVENDELL_MAGIC_LINK_TTL`. **This table is distinct from `magic_links`** (which set/reset existing users' passwords) — don't merge them.
- Admin endpoints: `POST /api/admin/invitations` (mint; raw token shown once), `GET /api/admin/invitations` (list; no token), `DELETE /api/admin/invitations/{id}` (revoke).
- Public endpoints: `GET /api/auth/invitation/{token}` (peek validity), `POST /api/auth/signup` `{token,username,password}` (creates account, auto-logs in). New user always starts as member; display name defaults to username.
- Account creation + invitation consumption are one transaction (`store.RedeemInvitation`): duplicate username aborts before the invitation is touched (→ 409); invalid/used/expired token rolls back the new account (→ 404).
- Tests: `TestInvitationSignupFlow`, `TestInvitationRevoke`, `TestInvitationSignupValidation`.

## DMs (migration `0002`)

A DM is a private channel with `is_dm = TRUE` and exactly two members.

- Canonical name `dm-<minUserId>-<maxUserId>` maps a pair to exactly one channel; `UNIQUE(name)` makes create-or-find race-safe (`store.GetOrCreateDM`, `POST /api/dms`).
- Members-only — moderators/admins cannot see another pair's DM. `handleListChannels` and `canAccessChannel` special-case `is_dm`.
- The client derives the "other" participant from the channel name (`dmParticipants`/`otherDMParticipant` in state.js, unit-tested).

## Private-channel invites

`GET`/`POST /api/channels/{id}/members`. Moderators+ only; real private channels only — public returns 400, DMs 403. Adding a member re-broadcasts `channel.new` to the larger audience.

## Pinned messages (migration `0004`)

`pinned_at`/`pinned_by` on `messages`. Pin/unpin is moderator+ (`PUT`/`DELETE /api/messages/{id}/pin`). Broadcasts `message.update` — no new event type. The pins modal fetches its own list (pinned message may predate the loaded window).

## Deleted-channel restore/purge

Channel delete is soft (`archived_at`); `UNIQUE(name)` reserves the name. Admin-only: `GET /api/admin/channels/archived`, `POST …/{id}/restore`, `DELETE …/{id}` (hard delete — cascades; refuses live channels).

## Scrollback / history

Keyset pagination: `GET …/messages?before=<id>&limit=<n>`. Client loads 50 on open; fetches older on scroll-near-top (`loadOlderMessages`). Short page = `historyComplete`. `renderMessages` preserves scroll position; auto-scrolls to bottom only if already there.

## Unread indicators

`state.unread` (channelId→count). `message.new` on a non-active channel that isn't your own bumps it. Soft DM chime (Web Audio) for DMs.

## Reactions (migration `0009`)

`message_reactions` PK `(message_id, user_id, emoji)`. Add is idempotent (`ON CONFLICT DO NOTHING`). `PUT`/`DELETE /api/messages/{id}/reactions`. Deleted messages return 409. Validation: known shortcode or `validUnicodeEmoji`. One realtime event `reaction.update` carries re-aggregated groups. **A `message.update` that omits `reactions` must preserve existing ones** (`addMessage` guards this, unit-tested). `toggleReaction` takes the pill's known `mine` — don't regress to a `findMessage` lookup.

## Channel topics

Editable inline by moderator+ (`PATCH /api/channels/{id}`, broadcasts `channel.update`). `renderChannelHeader()` is the single paint point. `channel.update` for the active channel repaints the header but skips it while an edit input is open.

## Inline message editing

`renderMessages` is the source of truth — a message whose id == `editingMessageId` draws the inline editor. Before each `innerHTML` reset it captures the live draft + caret + focus and restores them. Don't "simplify" to preserving a DOM node. Enter saves / Shift+Enter newline / Esc cancels; empty draft on own most-recent message deletes it silently.

## Markdown links + inline images

`format.js` extracts links from each escaped run *before* the markdown pass — `inlineMarkup` runs only on the gaps between links. A URL never feeds through the italic rule. Don't refactor to a single regex sweep that linkifies last. `formatMessage(..., {embedImages:false})` for search rows only.

## Voice / WebRTC (phases 1–4 complete)

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

## Theme (migration `0012`)

`users.theme` persisted via `PATCH /api/me`. Defaults to `"default"`. Validated against a known list. Returned on all user objects.

## User profiles (migration `0018`)

`users.pronouns` (≤32 chars) + `users.bio` (≤1000 chars). Edited via `PATCH /api/me`. Ride on every user object — no separate profile endpoint. Bio rendered through `formatMessage(..., {embedImages:false})`.

## Bot tokens / is_bot flag (migration `0013`)

Bots are users with `is_bot = true`. `PUT /api/admin/users/{id}/bot`. Bot tokens are permanent Bearer credentials managed at `GET/POST/DELETE /api/admin/bot-tokens`. Bots never hold a WebSocket connection — their online status comes from `users.status`, not hub presence.

## Link preview proxy — removed

The server-side OpenGraph scraper was deleted (SSRF surface, half-dead from deploy IP). **No arbitrary-URL server-side fetch remains.** Client-side YouTube embeds and same-origin message-permalink embeds were deliberately kept.

## File / image uploads (migration `0014`)

Content-addressed blobs at `blobs/<2-hex-prefix>/<sha256>`. `POST /api/uploads`: `MaxBytesReader` before reading; content type sniffed with `http.DetectContentType` (never trusts header); allowlists png/jpeg/webp/gif. `GET /api/blobs/{hash}` is session-gated; hash validated as 64-char lowercase hex (path-traversal immunity); `Cache-Control: private, max-age=31536000, immutable`. Writes are atomic (tmp + rename). Same bytes → same hash → one file (idempotent). Composer: uploads surface as preview tiles in `#composer-attachments`; send is blocked while any upload is in flight.

## Secret chat / OTR-style E2E encryption (migration `0015`)

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

## Notifications + Web Push (migration `0016`)

Foreground notifications (`notify.js`) while alive; Web Push for DMs/@-mentions when closed. See `docs/web_push.md`.

- All push crypto is stdlib (`internal/push`): VAPID = ECDSA P-256 ES256 JWT (RFC 8292); payload = RFC 8291 `aes128gcm` (RFC 8188).
- Two distinct keys: VAPID key (long-lived, persisted in `push_vapid`) and message ephemeral key (fresh per push).
- **JWT signature is JOSE raw `r||s` (64 bytes), never DER.** `aud` recomputed per endpoint (scheme://host).
- Pushes only to disconnected users. Runs in goroutine — never slows message send. 404/410 prunes subscription.
- Secret chat is never pushed.
- iOS needs installed PWA (16.4+). `firePing` prefers `registration.showNotification`.
- `web/sw.js` is notifications-only — no fetch caching.

## WebRTC debug telemetry

Diagnostic path for video calls. Gated by `RIVENDELL_DEBUG_TELEMETRY` (default off → endpoint returns 404).

- Per-client activation via `?rtcdebug=1` / localStorage, or operator-forced via `debug_telemetry:true` in `GET /api/instance`.
- `self_user_id` is never sent — server stamps it from the session. No candidate IP ever logged.
- Telemetry capture runs off the media path on a 3 s timer. `voice.js` accesses it only via `dbg`/`dbgEvent` indirection (null in prod/tests) — never import `rtcdebug.js` from `voice.js`.
- Server logs via `slog` TextHandler (logfmt): `msg=rtc-telem.snap`/`rtc-telem.evt`.
