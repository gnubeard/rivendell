# Rivendell — project guide for Claude Code

Rivendell is a small, self-hosted chat server for ~20 friends (a private Discord/Slack
alternative). It is a single Go binary that serves a JSON API plus a static
vanilla-JS web client, backed by Postgres. Web UI for now; the API is meant to be
cleanly consumable by future native/mobile clients.

The owner is a technical, privacy-minded self-hoster. Prefers forthright, plainly
stated answers and minimal hand-holding. Calibrate to advanced proficiency.

## The prime directive: keep the dependency footprint tiny

This is the single most important rule in the repo. **The entire Go backend
depends on exactly one third-party module: `github.com/lib/pq` (the Postgres
driver, zero transitive deps). Everything else is the standard library.** The
frontend has **zero** runtime dependencies — no framework, no bundler, no npm
packages (Node is used only as the test runner).

Do not add dependencies to "help." Specifically, do **not** introduce:

- an HTTP router (we use stdlib `net/http` `ServeMux` method+pattern routing,
  e.g. `mux.HandleFunc("POST /api/auth/login", ...)`),
- a WebSocket library (we hand-roll RFC 6455 in `internal/ws/websocket.go`),
- a password-hashing or crypto library (we hand-roll PBKDF2-HMAC-SHA256 on top of
  stdlib `crypto`; see below),
- a migration tool (we run embedded SQL migrations ourselves),
- a frontend framework, build step, or CSS framework.

If a task seems to need a dependency, stop and propose it in plain terms before
adding it. The bar is high and deliberate. Some of these choices were also forced
by the build environment (see "Environment quirks"), so removing them is not a
free win even where a library would be conventional.

## Layout

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

Module path is `rivendell`; Go 1.26. Imports are `rivendell/internal/...`.

## Build, test, run (use the Makefile)

- `make build` — compile to `./bin/rivendell`.
- `make test` — Go + frontend tests. `make test-go` / `make test-web` individually.
- `make run` — run locally (needs Postgres up).
- `make migrate` — apply migrations and exit.
- `make fmt` / `make vet` — gofmt / go vet. Run both before considering work done.

Go integration tests need a Postgres test database and are gated on the
`TEST_DATABASE_URL` env var (they skip if it's unset). The web tests are pure and
need nothing. Always run `gofmt`, `go vet ./...`, `go test ./...` (with
`TEST_DATABASE_URL` set), and `cd web && node --test test/*.test.js` before
declaring a change finished. Add tests for new behavior — this repo tests early.

## Environment quirks (these are real and have bitten us)

- **Postgres runs as a container** (podman/docker), not a host service. Bring up
  a dev/test instance yourself rather than assuming a system cluster — there is no
  `pg_ctlcluster`/`/etc/postgresql` install to rely on, and `psql` may not be on
  the host. Dev role/db: user `chat`, password `chat_dev_pw`, databases `chat` and
  `chat_test`. The Makefile defaults to port 5432
  (`postgres://chat:chat_dev_pw@localhost:5432/chat?sslmode=disable`); if your
  container publishes a different host port, override `RIVENDELL_DATABASE_URL` /
  `TEST_DATABASE_URL` accordingly. A throwaway test DB is e.g.:
  ```
  podman run -d --name rivendell-test-pg \
    -e POSTGRES_USER=chat -e POSTGRES_PASSWORD=chat_dev_pw \
    -e POSTGRES_DB=chat_test -p 55432:5432 postgres:16-alpine
  export TEST_DATABASE_URL='postgres://chat:chat_dev_pw@localhost:55432/chat_test?sslmode=disable'
  ```
  The Go integration tests skip unless `TEST_DATABASE_URL` points at a reachable DB.
- **Go module proxy and golang.org are unreachable in the build sandbox.** Use
  `go env -w GOPROXY=direct GOSUMDB=off GOFLAGS=-mod=mod`. Only github.com-hosted
  modules are fetchable — another reason the single-dependency rule matters.
- **Container builds can't reach docker.io in the sandbox** (`403 Host not in
  allowlist`). The Dockerfile is correct (multi-stage, distroless); it just may
  not build where registry egress is blocked. `make podman-build` works anywhere
  with normal registry access.
- Node is present and is the frontend test runner only. Run web tests as
  `node --test web/test/*.test.js` (a bare `web/test/` directory arg is
  misinterpreted by this Node version).
- **GitHub push uses a dedicated SSH key at `.creds/claude`.** No `~/.ssh` config
  changes are needed. Push with:
  ```
  GIT_SSH_COMMAND='ssh -i .creds/claude' git push origin <branch>
  ```
  `.creds/` is `.gitignore`d — the key never leaves this directory.

## Conventions

- **API hygiene: list endpoints must return `[]`, never `null`.** This already bit
  us hard: a `var out []T` that's never appended to marshals as JSON `null`, and
  the client's `for...of` throws on it, taking down the whole UI. Initialize list
  results as `out := []T{}`. There's a regression test
  (`TestEmptyListsReturnArraysNotNull`) — keep it green.
- **Auth:** session cookie `rivendell_session` (HttpOnly, SameSite=Lax, Secure from
  config). Tokens are random 256-bit, stored only as SHA-256 hashes. No email —
  new accounts are created by the **invitation** flow (admins mint a single-use
  signup link; the new person picks their own username/password — see Feature
  notes), and admins mint single-use **magic links** to set/reset the password of
  an *existing* user.
- **Passwords:** `internal/auth/password.go`, format
  `pbkdf2-sha256$<iter>$<b64salt>$<b64key>`, 600k iterations, constant-time
  compare. Don't lower the iteration count.
- **Roles:** admin > moderator > member (`roleRank` in handlers). Guard against
  removing/disabling the last admin (`CountAdmins`).
- **Realtime:** the hub broadcasts `{type, payload}` events. Private-channel events
  are scoped to an audience set (`audienceForChannel`, fail-closed). That set must
  mirror `canAccessChannel`: for a non-DM private channel it's the members **plus
  all moderators/admins** (who can read/write it via the bypass), so an admin who
  posts/edits/deletes in a channel they aren't a member of still gets their own
  broadcast echo (the client renders from the broadcast, not the POST response).
  DMs are exempt from the bypass and stay strictly members-only. `/api/ws` is
  deliberately not logged by `logMW` (to preserve the Hijacker) — its absence from
  logs is expected, not a bug.
- **Presence vs. status:** `users.status` is the user's *durable chosen* presence
  (online/away/dnd/offline) and is written **only** by `handleSetStatus`.
  Connectivity is transient and lives in the hub; `onPresenceChange` must never
  write it back to the column (doing so was a bug that reset away/dnd on every
  reconnect — `TestStatusDurableAcrossReconnect` guards it). Effective `online`
  reported to clients = connected AND status != "offline" (so "offline" doubles as
  invisible); computed in both `onPresenceChange` and `handleListUsers`. **Idle**
  is a separate ephemeral per-connection hub flag (`hub.IsIdle`): a user is idle
  only when *every* tab/connection is idle (one active tab keeps them non-idle).
  It is included in `GET /api/users` as the `idle` field. Bots (`is_bot = true`)
  never connect over WebSocket, so their online status is derived from the
  `users.status` column directly rather than hub presence.
- **Presence is debounced client-side (~1s).** `presence.update` is not applied
  immediately — `schedulePresenceUpdate` (app.js) holds it per user for
  `PRESENCE_DEBOUNCE_MS`, replacing any pending update for that user; if the latest
  value already matches what's displayed (`S.presenceMatches`, the pure equality
  check in state.js), the change is dropped without repainting. This kills the dot
  flicker on a brief connectivity blip. **Our own user is exempt** (applied
  immediately — status is server→broadcast with no optimistic local update, so
  debouncing self would lag a deliberate pick). Pending flips are flushed in
  `resync()` so a stale deferred update can't fire over a fresh roster pull. Don't
  "simplify" this back to an immediate apply.
- **Frontend:** keep `format.js` and `state.js` pure and unit-tested. `format.js`
  is XSS-safe by construction (escape first, then a fixed markdown-lite pass on the
  escaped string) — preserve that ordering. The CSS relies on
  `[hidden] { display: none !important; }` to beat class-level `display` rules;
  don't remove it. Realtime init must never be able to break UI wiring — wire
  controls before `startRealtime()`, and `new WebSocket` is wrapped because some
  browsers throw synchronously under a CSP that doesn't allow the `wss:` origin.
  App layout: `grid-template-rows: 100%` + `overflow: hidden` on the root grid;
  `min-height: 0` on `.sidebar`, `.main`, `.members`, and `.message-list` so
  the message list (and sidebar scroll region) are the actual scroll containers.

## Configuration (env vars, all optional except the DB URL in prod)

`RIVENDELL_ADDR`, `RIVENDELL_DATABASE_URL`, `RIVENDELL_WEB_DIR`, `RIVENDELL_PUBLIC_URL`,
`RIVENDELL_COOKIE_SECURE`, `RIVENDELL_SESSION_TTL`, `RIVENDELL_MAGIC_LINK_TTL`,
`RIVENDELL_MAX_MESSAGE_BYTES`, `RIVENDELL_MAX_AVATAR_BYTES`, `RIVENDELL_MAX_IMAGE_BYTES`
(file-upload size cap, default 5 MiB), `RIVENDELL_BLOBS_DIR` (content-addressed blob
storage dir, default `blobs`), `RIVENDELL_BOOTSTRAP_ADMIN`,
`RIVENDELL_INSTANCE_NAME` (display name/brand of this instance; "rivendell" is the
software, the instance can be e.g. "rivendell" — served unauthenticated at
`GET /api/instance` and applied to the page title + every `.brand`).
Voice/WebRTC: `RIVENDELL_STUN_URL` (default: `stun:stun.l.google.com:19302`),
`RIVENDELL_TURN_URL` (comma-separated list of TURN endpoints, e.g.
`turn:turn.example.com:3478,turns:turn.example.com:5349`; omit for STUN-only),
`RIVENDELL_TURN_SECRET` (shared HMAC secret for time-limited coturn credentials).
Web Push: `RIVENDELL_VAPID_SUBJECT` (the VAPID `sub` claim — a mailto: or https
URL; defaults to `RIVENDELL_PUBLIC_URL`). The VAPID keypair itself is generated
on first boot and persisted in `push_vapid`, so there is no key to configure.
Diagnostics: `RIVENDELL_DEBUG_TELEMETRY` (bool, default false) enables the WebRTC
debug-telemetry endpoint + advertises capture to clients (see Feature notes).
See `.env.example`. On an empty install the server creates a first admin
(`RIVENDELL_BOOTSTRAP_ADMIN`, default `admin`) and logs a one-time set-password link;
this fires only when there are zero admins.

## Deployment notes (behind nginx + TLS)

Set `RIVENDELL_PUBLIC_URL` to the externally reachable URL or magic links point at
localhost. Set `RIVENDELL_COOKIE_SECURE=true` when served over HTTPS. Two nginx things
are required for realtime:

1. A dedicated `location /api/ws` that upgrades the connection
   (`proxy_http_version 1.1;` + `Upgrade`/`Connection "upgrade"` headers; bump
   `proxy_read_timeout`, the socket is long-lived; server pings every 30s).
2. If a Content-Security-Policy header is set, `connect-src` must explicitly list
   the `wss://` origin — Firefox does not expand `'self'` to cover `ws/wss`.

## Feature notes

Key design invariants per feature — preserve these when modifying related code.

**Signup invitations** (migration `0017`). New accounts are self-service via an admin-issued, single-use invitation link — admins no longer pick a new user's name/role.
- An `invitations` row stores only the token's SHA-256 hash (like sessions/magic links), plus `created_by`, `expires_at`, and `used_at`/`used_by` (set on redemption). TTL reuses `RIVENDELL_MAGIC_LINK_TTL`. This table is **distinct from `magic_links`**, which still set/reset the password of an *existing* user (unchanged) — don't merge the two.
- Admin endpoints (admin-only): `POST /api/admin/invitations` (mint; returns `{id,url,token,expires_at}` — the raw token is shown **once**), `GET /api/admin/invitations` (list; never returns the token), `DELETE /api/admin/invitations/{id}` (revoke/delete). Admin panel "Invitations" section drives these.
- Public endpoints: `GET /api/auth/invitation/{token}` (peek validity, doesn't consume), `POST /api/auth/signup` `{token,username,password}` — creates the account and auto-logs-in. The new user **always starts as a member**, the **display name defaults to the username**, and the password is set during signup (no separate set-password step). Client route is `/invite#<token>` (`bootSignup`).
- **Account creation + invitation consumption are one transaction** (`store.RedeemInvitation`): a duplicate username aborts before the invitation is touched (stays redeemable → 409), an invalid/used/expired token rolls back the new account (→ 404), and concurrent reuse of one link can never mint two users. `SeedPublicReadCursors` runs after, so the first login isn't a wall of unread.
- Tests: `TestInvitationSignupFlow`, `TestInvitationRevoke`, `TestInvitationSignupValidation`; `TestMagicLinkFlow` still guards the unchanged password set/reset path.

**DMs.** A DM is a private channel with `is_dm = TRUE` and exactly two members (migration `0002_dms.sql`).
- Canonical name `dm-<minUserId>-<maxUserId>` maps a pair to exactly one channel; `UNIQUE(name)` makes create-or-find race-safe (`store.GetOrCreateDM`, `POST /api/dms`).
- Visibility is members-only — even moderators/admins cannot see another pair's DM. `handleListChannels` and `canAccessChannel` special-case `is_dm`; `audienceForChannel` scopes realtime to members.
- The client derives the "other" participant by parsing the two ids out of the channel name (`state.js` `dmParticipants`/`otherDMParticipant`, unit-tested) — a single broadcast can't bake in a per-recipient "other".

**Private-channel invites.** `GET`/`POST /api/channels/{id}/members` (`handleListChannelMembers`/`handleAddChannelMember`). Only moderators+ may invite, only into a real private channel — public channels return 400, DMs 403 (fixed at two participants). The invite button (`#invite-btn`) is hidden client-side for non-mods via `isModPlus()`. Adding a member re-broadcasts `channel.new` to the now-larger audience. The members panel is scoped to the active channel's membership for private channels/DMs (public channels show everyone); `refreshActiveMembers()` re-fetches on channel open, on invite, and on realtime channel events for the active channel.

**Pinned messages.** `pinned_at`/`pinned_by` on `messages` (migration `0004`). Pin/unpin is moderator+ (`PUT`/`DELETE /api/messages/{id}/pin`); listing (`GET /api/channels/{id}/pins`) is any member with channel access. Pin/unpin broadcasts a plain `message.update` — no new event type. The pins panel (`#pins-modal`) fetches its own list since a pin may be older than the loaded message window; deleting a message also clears its pin.

**Deleted-channel restore/purge.** Channel delete is a soft-delete (`archived_at`); `UNIQUE(name)` keeps the name reserved while archived. Admin-only: `GET /api/admin/channels/archived`, `POST …/{id}/restore` (clears `archived_at`, re-broadcasts `channel.new`), `DELETE /api/admin/channels/{id}` (hard delete — cascades messages/members, frees the name; refuses live channels). `archived_at` is exposed on the channel JSON (omitempty).

**Scrollback / history.** Keyset pagination: `GET …/messages?before=<id>&limit=<n>`. Client loads the most recent `PAGE` (50) on open and fetches older pages on scroll-near-top (`loadOlderMessages` → `state.oldestMessageId` cursor → `prependMessages`), guarded by an in-flight flag and a `historyComplete` set (short page = reached the start). `renderMessages` preserves the reader's scroll position on re-render; auto-scrolls to bottom only when already there.

**Unread indicators.** `state.unread` (channelId→count, pure `bumpUnread`/`clearUnread`, unit-tested). `message.new` for a non-active channel that isn't your own bumps it; selecting a channel clears it. Rendered as a count pill + bold name on channel/DM rows. A soft DM chime (Web Audio) plays for DMs.

**Deleted message collapse.** A run of consecutive soft-deleted messages renders as one compact "N messages deleted" line in `renderMessages`.

**Reactions** (migration `0009`). `message_reactions` PK `(message_id, user_id, emoji)` — one of each emoji per user per message; add is idempotent (`ON CONFLICT DO NOTHING`). `emoji` is either a known custom `:shortcode:` or a literal Unicode grapheme; the client resolves which at render (registry hit → `<img>`, else literal). `PUT`/`DELETE /api/messages/{id}/reactions` carry the emoji in the body (no URL-encoding of Unicode); deleted messages return 409. Validation is stdlib-only: a known shortcode or `validUnicodeEmoji` (every rune a symbol/ZWJ/variation-selector/keycap-base and ≥1 emoji-ish rune). One realtime event **`reaction.update`** carries re-aggregated groups; a plain `message.update` that omits `reactions` must **preserve** the existing ones (`addMessage` guards this; unit-tested). List/search/pins decorate via batched `ReactionsForMessages` (no N+1); soft-delete sheds reactions. The pins modal shows toggleable pills — `toggleReaction` takes the pill's known `mine` so it's correct even when the pinned message is outside the loaded window (don't regress this to a `findMessage` lookup).

**Channel topics.** Editable inline by moderator+ (`PATCH /api/channels/{id}`, broadcasts `channel.update`). `renderChannelHeader()` is the single paint point for the header title/topic — both `loadChannel` and `selectChannel` call it, don't re-inline. A `channel.update` for the active channel must repaint the header but skips it while an edit input is open to avoid clobbering your own typing. Modals: Esc closes the top-most open one; the About/Pinned modals have no × (backdrop-tap dismisses on mobile).

**Inline message editing.** `renderMessages` is the source of truth — a message whose id == `editingMessageId` draws the inline editor (seeded from `editDraft`). Before each `innerHTML` reset, `renderMessages` captures the live draft + caret + focus and restores them after; focus is only re-grabbed if it was focused, so background re-renders never steal the caret. Don't "simplify" this to preserving a DOM node — drive it from state. Enter saves / Shift+Enter newline / Esc cancels; empty draft on the most recent own message deletes it (no confirm — intent is clear), empty on any other message just cancels, unchanged cancels; channel switch abandons the edit; a save error keeps the editor open.

**Markdown links + inline images.** `format.js` extracts links from each escaped run *before* the markdown pass: `inlineMarkup` runs only on the gaps between links, so a URL never feeds through the italic rule — this fixes underscores mangling URLs (don't refactor it back to a single regex sweep that linkifies last). `LINK_RE` matches `[text](url)` (https only) or bare http(s) URLs; a bare URL whose path ends in an image extension renders as `<img class=msg-image>` wrapped in a link. The escape-first XSS invariant is preserved. `formatMessage(..., {embedImages:false})` is used for search rows only (the whole row is click-to-jump). Composer: pasting a single URL onto a non-empty selection wraps it `[selection](url)`.

**Voice / WebRTC** (phases 1–4 complete). P2P mesh over WebRTC, signaled through the existing WS hub. No media server; no new Go deps. Key invariants — don't break these:
- **Offerer = lower user_id; Perfect Negotiation on top.** The deterministic rule avoids glare when two peers join simultaneously: `onVoiceState` uses `myUserId < remoteUserId` to decide who sends the initial offer. Everything after setup (mid-call camera, ICE restarts, future screen share) runs the standard Perfect Negotiation pattern with the same rule mapped onto roles: lower user_id = impolite (its colliding offer wins), higher user_id = polite (`politeFor`; it implicitly rolls back via `setRemoteDescription(offer)` and answers). `peerMeta` carries the `makingOffer`/`ignoreOffer` flags; every manual offer path (initial, ICE restart) must bracket itself with `makingOffer` or crossing offers are mis-handled.
- **DM calls end for both parties.** When one party hangs up (`endDMVoiceCall`) or disconnects (`cleanupVoiceForUser`), the server removes *both* participants from the DM voice channel — nobody is left alone. Regular voice channels don't do this. `TestDMCallEndsForBothParties` / `TestVoiceChannelLeaveKeepsOthers` guard both sides.
- **TURN credentials are HMAC-SHA1, not SHA256.** coturn validates with SHA1; `handleGetRTCCredentials` uses `crypto/sha1`. A "cleanup" to SHA256 silently breaks every TURN credential. `TestRTCCredentials` asserts the digest length (20 bytes) as an independent guard.
- **ICE restart: offerer drives it, answerer waits — keyed on the worst-of state.** `reconnectPlan` (pure, unit-tested) decides the action per state and role; `restartOutcome` (pure, unit-tested) decides what to do when the timer fires; on give-up the peer is closed and `voice.join` re-announces us so the connection rebuilds from a fresh `voice.state`. Both `onconnectionstatechange` AND `oniceconnectionstatechange` feed the plan through `effectiveConnectionState` (pure, unit-tested) — Firefox reports disconnected/failed on the ICE state well before (sometimes instead of) `connectionState`, so keying on `connectionState` alone reacts late or never. The disconnect grace is 5 s on purpose (earlier detection + 2 s grace churned restarts on self-healing blips); don't shorten it without re-reading the comment on `ICE_DISCONNECT_GRACE_MS`.
- **Every video sender is bitrate-capped** (`VIDEO_MAX_BITRATE_BPS`, 800 kbps) via `applyVideoBitrateCaps` after each negotiation and on `connected` — a stability cap so one sender can't saturate a phone's uplink; REMB/TWCC adapts below it. It is NOT a fix for the FF-Android encoder freeze (that's upstream; see docs/video.md) — don't remove it as "tried and failed" or re-add it as a freeze cure.
- **Self join/leave tones fire inside the mic-live window.** Greet fires *after* `getUserMedia` resolves (AEC settled); farewell fires *before* tracks are stopped. Playing either one during the device-open/close transition clips/drops it. `voice.test.js` records a timeline and asserts the ordering.
- **Per-user volume uses `audio.volume`, not a Web Audio `GainNode`.** Routing remote WebRTC audio through Web Audio has a long-standing no-output bug in Chromium. The range is 0–1 so the element's own `.volume` is equivalent and doesn't conflict with deafen (`.muted`) or the metering `AudioContext`. Volumes persist to localStorage.
- **Pure helpers are all unit-tested in voice.test.js:** `computeRMS`, `clampVolume`, `pttShouldFire`, `pttKeyLabel`, `micErrorMessage`, `reconnectPlan`, `restartOutcome`, `politeFor`, `effectiveConnectionState`, `withVideoBitrateCap`, `orderVideoCodecsVP8First`.
- **E2E: `make test-e2e`** runs a Playwright suite (`web/e2e/`, dev-only devDependency — the frontend keeps zero runtime deps) that drives two real Chromium contexts with fake capture devices against a real server binary: DM-call happy path, mid-call camera renegotiation, simultaneous-camera offer glare, and both-parties hang-up. It needs a DISPOSABLE `chat_e2e` database (provisioning is idempotent and goes through the public bootstrap/invitation surface — no test backdoors) and a one-time ~1.5 GB browser download; it is NOT part of `make test`.
- REST: `GET /api/voice/state` (all accessible voice channels + participants, for page-load seed); `GET /api/channels/{id}/voice` (single channel); `GET /api/rtc/credentials` (fresh STUN/TURN credential pair).

**Theme.** `users.theme` column (migration `0012`). Persisted via `PATCH /api/me` alongside `display_name`/`status_text`; defaults to `"default"`; validated against a known list — unknown value → 400, persisted value unchanged. Returned in `GET /api/me` and all user objects. `TestUpdateProfileValidation` covers round-trip and rejection.

**User profiles.** `users.pronouns` (≤32 chars) + `users.bio` (free-format notes box, ≤1000 chars), migration `0018`. Both optional, default `''`, edited via `PATCH /api/me` (same handler as display_name/theme; over-length → 400). They ride on **every** user object — there is deliberately **no** per-user profile fetch endpoint; the client already holds the full roster in `state.users`, so the profile card reads straight from there. Frontend: clicking a message avatar or author name opens a read-only card (`#user-modal` / `openUserCard`); clicking your own routes to the editable profile modal instead. Bio is rendered through `formatMessage(..., {embedImages:false})` to keep the escape-first XSS invariant. `TestUpdateProfileValidation` covers pronouns/bio round-trip + rejection.

**Bot tokens / is_bot flag.** Bots are regular users with `is_bot = true` (migration `0013`). `PUT /api/admin/users/{id}/bot` (admin-only) sets/clears the flag and broadcasts `user.update`. Bot tokens are permanent Bearer credentials (random 256-bit, SHA-256-hashed, same scheme as sessions) managed at `GET/POST/DELETE /api/admin/bot-tokens` (admin-only). A request with a valid `Authorization: Bearer <token>` header authenticates as the owning user without a session cookie. `TestBotTokenAuth` covers token auth. Because bots never hold a WebSocket connection, their online status in `GET /api/users` comes from `users.status`, not hub presence.

**Link preview proxy — removed (was `GET /api/link-preview`).** The server-side OpenGraph/Twitter-card scraper for external hosts (bsky/twitter/x/xcancel/github/wikipedia/tumblr) was deleted. It was a standing SSRF surface (user-controlled URL → server-side fetch; CodeQL `go/request-forgery`), the scraper only re-validated the *initial* host so redirects could walk off-allowlist, and the feature was already half-dead from the deploy IP (X serves a JS wall, Tumblr IP-bans us, xcancel 503s) — previews for ~3 hosts at the cost of the only user-driven outbound-fetch path in the binary. **No arbitrary-URL server-side fetch remains.** Two adjacent features were deliberately *kept*, as neither makes a server-side request: client-side **YouTube embeds** (`extractYouTubeVideoID` → thumbnail link) and same-origin **message-permalink embeds** (`extractMessagePermalinkURL` → `GET /api/messages/{id}`, gated by normal channel access). `extractHideURL` still suppresses the inline text of a URL those two render.

**File / image uploads** (migration `0014`). Content-addressed blobs on a local volume (`blobs/<2-hex-prefix>/<sha256>`), metadata in Postgres (`blobs` table), behind the `blobs.BlobStore` interface (`FSStore` the only impl). `POST /api/uploads` takes a raw image body, bounds it with `http.MaxBytesReader` (`RIVENDELL_MAX_IMAGE_BYTES`) *before* reading, **sniffs** the content type with `http.DetectContentType` (never trusts the header) and allowlists png/jpeg/webp/gif, then stores + dedups by hash; returns `{hash, url, content_type, size}`. `GET /api/blobs/{hash}` serves it **gated behind the session** (images stay as private as the channels they're in), validates the hash is 64-char lowercase hex (path-traversal immunity — the filename is never user input), and sets `Cache-Control: private, max-age=31536000, immutable` (blobs are immutable). Writes are atomic (tmp + rename). Uploads are idempotent — same bytes → same hash → one file. If the blob store can't be created at boot, uploads are disabled (503), not fatal. No thumbnails (CSS `max-width` handles display); no EXIF stripping yet (would have to happen *before* hashing). `TestBlobUploadAndServe` covers the lifecycle. No new dependencies — all stdlib. *Composer UX:* uploads (paste / drop / 📎) surface as preview tiles in a tray above the textarea (`#composer-attachments`), **not** as text in the box. Each tile shows a spinner while uploading and an × to remove once done; **send is blocked while any upload is in flight** (the Enter handler checks `uploadsPending()`). On send the done tiles' `![image](url)` markdown is appended to the typed text (one per line) and the tray clears; a send error puts both the text and the tiles back. Clicking a finished tile copies its blob markdown to the clipboard, so the same upload can be re-pasted freely (the store dedups by hash). State lives in `pendingUploads` in `wireComposer`; object URLs are revoked on remove and on successful send.

**Secret chat / OTR-style E2E encryption** (migration `0015`). Ephemeral, session-scoped end-to-end encryption for DMs. Defends against passive server/DB compromise and authenticated MITM when the safety number is verified. Does **not** hide metadata, provide cryptographic deniability, work offline, or survive a page reload. See `docs/otr.md` for the full design. Key invariants — don't break these:
- **All crypto is SubtleCrypto. We compose, never implement.** Ed25519 (identity signing), X25519 (ephemeral ECDH), HKDF-SHA-256 (key derivation), AES-256-GCM (AEAD message encryption), SHA-256 (fingerprinting).
- **Identity key: non-extractable private key in IndexedDB.** `users.identity_key` holds the SPKI-encoded public key so peers can fetch it before chatting. `PUT /api/me/identity-key` publishes it. The private key never leaves the browser; even an XSS bug can't exfiltrate it. `secret.js` — `ensureIdentityKey`, `getMyPubKeyB64`.
- **Offerer = lower user_id.** Same deterministic glare rule as voice. If both click 🔒 at once, the lower user_id's offer wins; the higher user_id's `secret.offer` is dropped.
- **Handshake: authenticated ephemeral ECDH (SIGMA-lite).** Each party signs their ephemeral X25519 public key with their Ed25519 identity key, binding it to the session nonce, sender, and recipient. A verified peer can't be MITM'd without access to the identity private key.
- **Message crypto: symmetric hash ratchet (HKDF chain).** Per-message keys via `ratchetStep`; per-message random 96-bit nonce; AEAD AAD binds sender, counter, channel, and session nonce — prevents replay and cross-context reuse. Receiver enforces strict counter monotonicity (`replayOk`).
- **Sessions are in JS memory only.** Reloading the page ends the session — no ciphertext or keys are ever persisted server-side. The server relays `secret.*` WS frames as opaque blobs exactly like voice signaling (`handleSecretWSMessage`), with the same DM-membership validation.
- **Feature-detected at load.** `isSecretSupported()` probes for Ed25519 + X25519 WebCrypto; the 🔒 button is disabled with a tooltip on older browsers. No fallback to weaker primitives — ever.
- **Verified vs. unverified is loud in the UI.** A session where the safety number hasn't been compared out-of-band shows as yellow (encrypted but unauthenticated); green means verified. A peer key change revokes verification loudly — never silently.
- **Pure helpers are all unit-tested in secret.test.js:** `formatSafetyNumber`, `buildAAD`, `replayOk`, `canonicalPubKeyOrder`, `ratchetStep`, `encryptMessage`, `decryptMessage`.
- **Multi-tab sibling dismiss.** When a peer's tab accepts a request, the server sends `secret.dismiss` to the peer's other connections so their request banners clear — identical to the `voice.ring_dismissed` pattern. The one tab that completed the handshake holds the session; others have no matching pending state and ignore the accept.
- **Session ends on peer disconnect.** `terminateSessionForPeer` ends any active session when presence signals the peer went offline; `sendEndAllOnUnload` fires `secret.end` best-effort on page unload.

**Notifications + Web Push** (migration `0016`). Foreground notifications
(`notify.js`, `shouldNotify`) fire while a tab is alive; **Web Push** delivers
DMs/@-mentions when the app is fully closed. The two are routed by connectivity
and must not double-fire — see `docs/web_push.md` for the full design. Key
invariants — don't break these:
- **All push crypto is stdlib (`internal/push`), composed not imported.** VAPID =
  ECDSA P-256 signing an ES256 JWT (RFC 8292); payload = RFC 8291 over the
  `aes128gcm` content coding (RFC 8188) via `crypto/ecdh` + `crypto/hkdf` +
  AES-128-GCM. No `webpush-go`, no JWT lib. `internal/push/push_test.go` round-trips
  the encryption (encrypt server-side, decrypt receiver-side) and verifies the JWT.
- **Two distinct keys.** The VAPID key (ECDSA, long-lived, persisted in
  `push_vapid`, generated on first boot) signs the JWT and is the browser's
  `applicationServerKey`. The message ephemeral key (ECDH, fresh per push) is the
  `aes128gcm` `keyid`. Don't conflate them.
- **JWT signature is JOSE raw `r||s` (64 bytes), never DER.** A `SignASN1`
  "cleanup" silently breaks every push. `aud` is recomputed per endpoint
  (scheme://host) — a cached/global `aud` is rejected by Mozilla/Apple.
- **Gated on connectivity + mutes.** `sendPushNotifications` pushes only to ping
  recipients who are **not** connected (`hub.IsConnected` — connected users get the
  foreground WS path) and haven't muted the channel. Runs in a goroutine off the
  message-create path; a slow push service must never slow a send. A `404`/`410`
  prunes the subscription (`push.ErrSubscriptionGone`).
- **Secret chat is never pushed** — OTR messages don't persist and never reach
  `handleCreateMessage`, so there's nothing to leak. Push payloads carry the same
  plaintext the server already stores for normal messages.
- **One toggle.** The "Desktop notifications" checkbox drives both foreground and
  push (`enablePush`/`disablePush` in app.js). Push is best-effort: if SW
  registration or `subscribe` fails (old browser, blocked), foreground still works.
  `firePing` prefers `registration.showNotification` (works on Android, where
  `new Notification()` throws), falling back to the page-context constructor.
- **iOS needs an installed PWA** (16.4+) — hence `web/manifest.json` +
  apple-touch-icon. Desktop/Android push works without install.
- **Pure helpers unit-tested in `notify.test.js`:** `urlBase64ToUint8Array`,
  `pushSubscriptionPayload` (trims a PushSubscription to the strict
  `{endpoint, keys}` body the server's `DisallowUnknownFields` decoder accepts —
  `expirationTime` must be dropped).
- `web/sw.js` is notifications-only — no fetch caching/offline-app behaviour. It
  `skipWaiting()`/`clients.claim()` so updates take effect immediately, renders
  `push` events, and on `notificationclick` focuses an existing tab (posting it the
  permalink to `jumpToMessage`) or `openWindow`s the deep link.

**WebRTC debug telemetry** (Phase 1 of the video-reliability arc). The diagnostic
path for video calls: instead of an on-screen HUD read off a phone (the removed
`?rtcdebug=1` approach), the client ships a structured debug package to the server,
logged so you debug by reading stdout. Gated by `RIVENDELL_DEBUG_TELEMETRY` (default
off → `POST /api/debug/telemetry` returns **404**, masking its existence). Key
invariants — don't break these:
- **Activation is opt-in OR operator-forced.** `rtcDebugEnabled(serverFlag)`
  (`rtcdebug.js`) is true when `?rtcdebug=1` / `localStorage["rivendell.rtcDebug"]`
  is set (per-client) OR the server advertises `debug_telemetry:true` in
  `GET /api/instance` (forces capture on for *everyone* during a debugging window).
- **`self_user_id` is never sent — the server stamps `self=` from the session**
  (like `from_user_id` injection in voice signaling). The wire schema has no field
  for it, so `DisallowUnknownFields` rejects a forged one. Legs are stitched by
  `(channel_id, user-pair)`; each client generates its own per-call `call_id`.
- **No candidate IP ever reaches a log.** `buildSnapshot` reads only candidate
  *type* (host/srflx/relay) + RTT from the selected pair; `pairStats` (Go) has no
  address field. `TestTelemetryRecordsFormat` and the JS `never leaks a candidate
  IP` test guard this.
- **Telemetry never perturbs a call.** Capture runs off the media path on a 3s
  timer; every entry point is try/wrapped; disabled ⇒ zero work. `voice.js` calls
  the hook only via the guarded `dbg`/`dbgEvent` indirection (null in prod/tests),
  so it stays dependency-free and the existing voice tests are unaffected — never
  make `voice.js` import `rtcdebug.js`.
- **Server logs via a dedicated `slog` `TextHandler` (logfmt), not `log.Printf`.**
  Lines are `msg=rtc-telem.snap`/`rtc-telem.evt` + key=value attrs — greppable by
  eye and machine-parseable. Cumulative counters render `cur(+delta)` (the pure
  `deltaStr`/`telemetryRecords` in `telemetry.go`) so a frozen counter (the silent
  drop / FF-Android encoder freeze) jumps out. `slog` is the only structured-logging
  use so far; the rest of the app stays on `log.Printf`.
- **Pure helpers unit-tested:** JS `deltaOf`, `buildSnapshot`, `capPayload`,
  `rtcDebugEnabled` (`rtcdebug.test.js`); Go `telemetryRecords`/`deltaStr` +
  endpoint behavior (`telemetry_test.go`).

When in doubt on UI, favor clarity over polish — aesthetics are secondary to "it works." Keep changes small and tested. Commit a baseline before large changes so diffs and rollbacks are clean.

## Backlog

**Deferred / future:**
- **[XL] OMEMO-class E2E (not OTR).** OTR-style ephemeral secret chat is implemented (see above). What remains deferred is the fundamentally different product: ciphertext at rest, async delivery, multi-device key sync, encrypted scrollback/search. That's a separate design pass — see `docs/otr.md` "Non-goals for v1.3" for the scope fence.
- **EXIF stripping on uploaded images.** Would have to happen before hashing (so it affects the stored blob). Currently no-op; no new deps.
