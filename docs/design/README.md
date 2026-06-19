# Feature design notes

Why each subsystem is wired the way it is, plus its invariants — for contributors.
This file is the index. The larger subsystems have their own deep-dive note in this
directory (linked inline below); the smaller ones are documented here in full.

Deep dives: [voice.md](voice.md) · [video.md](video.md) ·
[secret-chat.md](secret-chat.md) · [web-push.md](web-push.md) ·
[uploads.md](uploads.md) · [rich-text.md](rich-text.md).

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

Keyset pagination: `GET …/messages?before=<id>&limit=<n>` (and `after=<id>` for the forward direction). Client loads `PAGE` (50) on open. The paging state machine lives in `history.js` (`createHistoryPaging` factory): IntersectionObserver sentinels at top/bottom drive `loadOlderMessages`/`loadNewerMessages`, short page = history-window complete in that direction, and a banner signals a non-tail window (after `jumpToMessage`). `renderMessages` preserves scroll position; `isNearBottom`/`scrollToBottom` (free exports, threshold `NEAR_BOTTOM_PX` = 80) auto-scroll only when already at the tail. `loadChannel`/`jumpToMessage` stay in app.js and drive the factory via accessors.

## Unread indicators

`state.unread` (channelId→count). `message.new` on a non-active channel that isn't your own bumps it. Soft DM chime (Web Audio) for DMs. The whole decision — does an incoming message raise the unread/mention badges, and does it alert (chime/notification) — is the pure `classifyIncomingMessage(state, evt, view)` in `unread.js` (the realtime handler feeds it three view booleans it reads from the DOM: `active`, `focused`, `adminPanelOpen`); it's exhaustively unit-tested (muted silences all; a focused-active channel marks read, not unread; a ping there only alerts if the admin panel is covering it). Don't re-inline that matrix into the handler.

## Client state reducer (`state.applyEvent`)

`state.js` is the immutable client world-model; `applyEvent(state, evt)` is the **single place** a realtime event folds into it, and is total over state-mutating events (incl. `message.new`'s `last_message_at` bump and `member.remove`'s channel drop — the realtime handler does only side effects after the fold, never its own `state = S.…` for those). Pure and unit-tested; keep new event-driven state changes here, not in the handler's if-ladder.

## Reactions (migration `0009`)

`message_reactions` PK `(message_id, user_id, emoji)`. Add is idempotent (`ON CONFLICT DO NOTHING`). `PUT`/`DELETE /api/messages/{id}/reactions`. Deleted messages return 409. Validation: known shortcode or `validUnicodeEmoji`. One realtime event `reaction.update` carries re-aggregated groups. **A `message.update` that omits `reactions` must preserve existing ones** (`addMessage` guards this, unit-tested). `toggleReaction` takes the pill's known `mine` — don't regress to a `findMessage` lookup.

## Channel topics

Editable inline by moderator+ (`PATCH /api/channels/{id}`, broadcasts `channel.update`). `renderChannelHeader()` is the single paint point. `channel.update` for the active channel repaints the header but skips it while an edit input is open.

## Inline message editing

`renderMessages` is the source of truth — a message whose id == `editingMessageId` draws the inline editor. Before each `innerHTML` reset it captures the live draft + caret + focus and restores them. Don't "simplify" to preserving a DOM node. Enter saves / Shift+Enter newline / Esc cancels; empty draft on own most-recent message deletes it silently.

## Markdown links + inline images

`format.js` extracts links from each escaped run *before* the markdown pass — `inlineMarkup` runs only on the gaps between links. A URL never feeds through the italic rule. Don't refactor to a single regex sweep that linkifies last. `formatMessage(..., {embedImages:false})` for search rows only.

## Composer live-markdown decoration (`composer-richtext.js`)

See [rich-text.md](rich-text.md) for the full design. The composer is a contenteditable (`upgradeComposerField` facade preserves the textarea API); `createComposerRichText` decorates markdown *in place* as you type, mirroring `format.js`'s inline rules (bold before italic, code pulled out first) — kept in lockstep by a parity test.

- **Load-bearing invariant:** `decorate` only WRAPS runs (markers kept, dimmed), never adds/removes a character, so `.value` stays the exact markdown source and the facade's text-offset caret math holds. The `input` handler captures caret offsets BEFORE its image-harvest/flatten mutations and threads them to `rich.onInput(start,end)`.
- **Decoration is ORTHOGONAL to behavior:** `prefs.loadRichText()` (default ON, `#richtext-enable`) only controls styled rendering; Ctrl-B/I and undo/redo work either way.
- **Undo/redo is OURS, always-on:** programmatic mutations (innerHTML rewrite + Ctrl-B/I) desync the browser's native history, so `createUndoHistory` (pure, unit-tested) replaces it and `handleKeydown` preventDefaults Ctrl/Cmd-Z, Cmd-Shift-Z, Ctrl-Y. Any out-of-band `.value` set (channel switch, send-clear, error-restore) must call `rich.resetHistory()`.

## Voice / WebRTC (phases 1–4 complete)

P2P mesh over WebRTC, signaled through the existing WS hub. No media server; no new Go deps.

- **Offerer = lower user_id; Perfect Negotiation on top.** `onVoiceState` uses `myUserId < remoteUserId` for the initial offer. Everything after uses Perfect Negotiation with the same role mapping (lower = impolite).
- **Initial offer belongs to `onVoiceState` alone.** `sendOffer` (the `negotiationneeded` path) returns early while `!pc.remoteDescription`. Letting both offer at setup causes glare + ICE stall.
- **Glare re-offer is ONE-SHOT** (`renegotiatePending` flag in `onOffer`). Do NOT wire to `signalingstatechange` — both peers re-offer in lockstep and oscillate, breaking both video directions.
- **DM calls end for both parties.** `endDMVoiceCall`/`cleanupVoiceForUser` removes both participants. `TestDMCallEndsForBothParties` / `TestVoiceChannelLeaveKeepsOthers` guard both sides.
- **TURN credentials are HMAC-SHA1, not SHA256.** coturn validates with SHA1. `TestRTCCredentials` asserts the 20-byte digest.
- **Both `onconnectionstatechange` AND `oniceconnectionstatechange`** feed `effectiveConnectionState`. Firefox reports ICE failure before (sometimes instead of) connection state.
- ICE disconnect grace is 5 s on purpose — don't shorten.
- Per-user volume uses `audio.volume`, not a Web Audio GainNode (Chromium no-output bug with WebRTC+WebAudio).
- Teardown is synchronous (`finishTeardown` → `closeAllPeers` before farewell-tone await). `callGen` guards rapid re-join from colliding with stale teardown.
- Pure helpers all unit-tested in `voice.test.js`. E2E: `make test-e2e` (Playwright, not part of `make test`).
- REST: `GET /api/voice/state`, `GET /api/channels/{id}/voice`, `GET /api/rtc/credentials`.

**Video bitrate + congestion control.** The 800 kbps per-sender cap is a CEILING, not a freeze fix. `bitrateCapFor(numPeers,"video")` shrinks it across senders as the roster grows. Per-peer AIMD control (`monitorCongestion`/`congestionTarget`, every 2.5 s) lowers the live target below the ceiling on remote-reported loss/RTT spikes OR a CPU-pinned local encoder (`uplinkStressed`), and climbs back only after `CLIMB_AFTER_HEALTHY` consecutive healthy intervals (`healthyStreak` — the anti-oscillation gate, don't drop to one sample). `applyVideoBitrateCaps(uid,pc)` applies the full encoding shape via `withVideoEncodingCaps`: `effectiveVideoCap` (maxBitrate) PLUS `videoScaleForTarget` (scaleResolutionDownBy/maxFramerate) — bitrate-only back-off does NOT relieve a CPU-bound phone encoder; only dropping resolution/framerate does.

**Server-enforced group caps.** `MaxVoiceAudio`/`MaxVoiceVideo`: over-cap join ⇒ `voice.join_denied{reason:"full"}` (abort); over the video sub-cap ⇒ forced video-muted + `reason:"video_full"` (audio-only). DMs are exempt. `TestVoiceJoinDeniedWhenFull`/`TestVoiceVideoSubCap` guard.

**Screen share (Phase 4, 2.0.0).** A SECOND video source on the single video slot, mutually exclusive with the camera (`setScreenShareEnabled`). Camera↔screen swaps the source on the existing m-line via `replaceTrack` (instant, no reneg); first-enable `addTrack`s + renegotiates. `contentHint="detail"` + `videoScaleForTarget(t, isScreen=true)` (captured at `frameRate: { ideal: 30 }`) scale on screen-specific thresholds (`VIDEO_SCALE_SCREEN_FULL_BPS` 700k / `VIDEO_SCALE_SCREEN_QUARTER_BPS` 350k): native res only with real headroom (≥700k), ½ across the broad middle (350–700k), ¼ at the floor (<350k), holding 30 fps. A 1080p+ frame too big for the link stalls in bursts (the ~0.5 s smooth/hiccup oscillation), so a screen steps resolution DOWN willingly rather than pinning native res and starving the pipe. When the share is playing high-fps video/game (`detectScreenMotion` watches outbound `framesPerSecond` in `monitorCongestion`, hysteretic) it flips `contentHint="motion"` and keeps 30 fps even at the ¼ floor (a static doc eases to 24). `track.onended` catches the browser's native "Stop sharing" bar and flips to video-off. Screen VIDEO parks its sender on stop (`replaceTrack(null)`, reused via `idleVideoSender`, which must only match an already-SEND transceiver — never a recvonly receive slot, the 2.0.0 regression). Screen AUDIO is `addTrack`ed into the mic's `localStream` (rides its own m-line, so muting the mic never silences it) and FULLY removed on teardown (no `video_muted`-style gate). UI lives in `voiceui.js`; `web/e2e/screen-share` pins share→receive→camera-swap→teardown.

## Theme (migration `0012`)

`users.theme` persisted via `PATCH /api/me`. Defaults to `"default"`. Validated against a known list. Returned on all user objects.

## User profiles (migration `0018`)

`users.pronouns` (≤32 chars) + `users.bio` (≤1000 chars). Edited via `PATCH /api/me`. Ride on every user object — no separate profile endpoint. Bio rendered through `formatMessage(..., {embedImages:false})`.

## System messages (migration `0019`)

Server-generated channel-log events (e.g. call started / call ended): `messages.user_id` is NULL and `is_system = TRUE`. The client renders them differently — no avatar, no actions, centred event text. (Migration `0019` drops the `user_id NOT NULL` constraint to allow the authorless row.)

## Avatars (migrations `0020`, `0022`)

`POST /api/me/avatar` uploads; stored as a content-addressed blob (same pipeline as file uploads). `users.avatar_updated_at` is the cache-busting version stamp — `GET /api/users/{id}/avatar` keys on it so a new avatar invalidates client caches; migration `0022` backfills it for existing rows. Admins can set/clear another user's avatar via `POST`/`DELETE /api/admin/users/{id}/avatar`.

## Per-user private notes (migration `0021`)

`user_notes` (PK `(owner_id, subject_id)`) holds a private note one user keeps about another — visible only to the owner. `GET`/`PUT /api/users/{id}/note`. Cascades on either user's deletion.

## Bot tokens / is_bot flag (migration `0013`)

Bots are users with `is_bot = true`. `PUT /api/admin/users/{id}/bot`. Bot tokens are permanent Bearer credentials managed at `GET/POST/DELETE /api/admin/bot-tokens`. Bots never hold a WebSocket connection — their online status comes from `users.status`, not hub presence.

## Link preview proxy — allowlist-only (migration `0023`)

> History: an earlier free-form OpenGraph scraper was deleted for SSRF surface. The
> current proxy is its allowlisted, SSRF-hardened replacement — **not** arbitrary-URL fetch.

`GET /api/link-preview` (`preview.go`) fetches OG tags (Wikipedia via its summary API) for **allowlisted hostnames only**, caching results in Postgres.

- Allowlist: a hardcoded default set in `config.go` (github/wikipedia/major news orgs), overridable via `RIVENDELL_LINK_PREVIEW_DOMAINS`; `domainAllowed` matches subdomains too. An empty allowlist disables the feature.
- A non-allowlisted or cache-errored URL gets a bare `404` (`http.NotFound`, no JSON — the allowlist isn't leaked), which `api.getLinkPreview` maps to a "no card" marker without throwing.
- **SSRF hardening (`newPreviewClient`):** the outbound client refuses to dial any non-public IP (loopback/RFC1918/ULA/link-local incl. the `169.254.169.254` metadata endpoint) via a `net.Dialer.Control` hook — vetting the *resolved* IP at connect time, so DNS rebinding can't bypass it — AND re-applies the https + `domainAllowed` checks on **every** redirect hop, so an allowlisted host's open redirect can't pivot off-allowlist or inward.
- `inFlight` (sync.Map) de-dupes concurrent fetches of the same URL.
- Guarded by `TestIsPublicIP`, `TestCheckPreviewRedirect`, `TestPreviewClientRefusesInternal`.
- Client-side YouTube embeds and same-origin message-permalink embeds remain client-only (intentionally not proxied).

## File / image uploads (migration `0014`)

Content-addressed blobs at `blobs/<2-hex-prefix>/<sha256>`. `POST /api/uploads`: `MaxBytesReader` before reading; content type sniffed with `http.DetectContentType` (never trusts header); allowlists png/jpeg/webp/gif. `GET /api/blobs/{hash}` is session-gated; hash validated as 64-char lowercase hex (path-traversal immunity); `Cache-Control: private, max-age=31536000, immutable`. Writes are atomic (tmp + rename). Same bytes → same hash → one file (idempotent). Composer: uploads surface as preview tiles in `#composer-attachments`; send is blocked while any upload is in flight.

## Secret chat / OTR-style E2E encryption (migration `0015`)

Ephemeral, session-scoped E2E encryption for DMs. See [secret-chat.md](secret-chat.md) for the full design.

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

Foreground notifications (`notify.js`) while alive; Web Push for DMs/@-mentions when closed. See [web-push.md](web-push.md).

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
