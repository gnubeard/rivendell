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

- an HTTP router (we use stdlib `net/http` with Go 1.22 `ServeMux` method+pattern
  routing, e.g. `mux.HandleFunc("POST /api/auth/login", ...)`),
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
web/index.html                single-page shell (login / set-password / app views)
web/static/                   app.js, api.js, ws.js, format.js, state.js, style.css
web/test/                     format.test.js, state.test.js (node:test)
```

Module path is `rivendell`; Go 1.22. Imports are `rivendell/internal/...`.

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

## Conventions

- **API hygiene: list endpoints must return `[]`, never `null`.** This already bit
  us hard: a `var out []T` that's never appended to marshals as JSON `null`, and
  the client's `for...of` throws on it, taking down the whole UI. Initialize list
  results as `out := []T{}`. There's a regression test
  (`TestEmptyListsReturnArraysNotNull`) — keep it green.
- **Auth:** session cookie `rivendell_session` (HttpOnly, SameSite=Lax, Secure from
  config). Tokens are random 256-bit, stored only as SHA-256 hashes. No email —
  admins mint single-use magic links for set/reset password.
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
  invisible); computed in both `onPresenceChange` and `handleListUsers`.
- **Frontend:** keep `format.js` and `state.js` pure and unit-tested. `format.js`
  is XSS-safe by construction (escape first, then a fixed markdown-lite pass on the
  escaped string) — preserve that ordering. The CSS relies on
  `[hidden] { display: none !important; }` to beat class-level `display` rules;
  don't remove it. Realtime init must never be able to break UI wiring — wire
  controls before `startRealtime()`, and `new WebSocket` is wrapped because some
  browsers throw synchronously under a CSP that doesn't allow the `wss:` origin.

## Configuration (env vars, all optional except the DB URL in prod)

`RIVENDELL_ADDR`, `RIVENDELL_DATABASE_URL`, `RIVENDELL_WEB_DIR`, `RIVENDELL_PUBLIC_URL`,
`RIVENDELL_COOKIE_SECURE`, `RIVENDELL_SESSION_TTL`, `RIVENDELL_MAGIC_LINK_TTL`,
`RIVENDELL_MAX_MESSAGE_BYTES`, `RIVENDELL_MAX_AVATAR_BYTES`, `RIVENDELL_BOOTSTRAP_ADMIN`,
`RIVENDELL_INSTANCE_NAME` (display name/brand of this instance; "rivendell" is the
software, the instance can be e.g. "rivendell" — served unauthenticated at
`GET /api/instance` and applied to the page title + every `.brand`). See
`.env.example`. On an empty install the server creates a first admin
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

## Punch list — all six items completed

These were the requested next-work items; all are now implemented and tested.

1. **Private-channel creation UX.** ✅ Replaced the `confirm()` flow with a small
   create-channel modal (`#channel-modal`) carrying an explicit "Private" checkbox.
2. **Edit display name and status text.** ✅ Added an "Edit profile" modal
   (`#profile-modal`) for both fields (replacing the `prompt()` for status text);
   opened by clicking the name or status text in the sidebar foot.
3. **Presence dot colors.** ✅ `presenceClass()` in app.js + per-status `--away`
   (amber) / `--dnd` (red) vars; online=green, offline=grey.
4. **Scrolling.** ✅ App grid pinned to `grid-template-rows: 100%` + `overflow:
   hidden`; `min-height: 0` on `.sidebar/.main/.members` and `.message-list` so the
   message list (and the sidebar scroll region) are the scroll containers.
5. **Delete and reorder channels.** ✅ Hover controls (↑/↓/✕) on each channel row,
   mod/admin only. Reorder renormalizes positions to contiguous indices (positions
   all default to 0) and PATCHes only the rows that changed; delete uses
   `ArchiveChannel`. DMs are excluded from these controls.
6. **DMs.** ✅ A DM is a private channel with `is_dm = TRUE` and exactly two
   members (migration `0002_dms.sql`). Key design points to preserve:
   - **Canonical name `dm-<minUserId>-<maxUserId>`** makes a pair map to exactly
     one channel; `UNIQUE(name)` makes create-or-find race-safe
     (`store.GetOrCreateDM`, `POST /api/dms`).
   - **Visibility is members-only — even for moderators/admins.** Unlike regular
     private channels (which keep the mod+ bypass), `handleListChannels` and
     `canAccessChannel` special-case `is_dm` so nobody can see/read another pair's
     DM. `audienceForChannel` already scopes realtime to members (DMs are private).
   - **The client derives the "other" participant by parsing the two ids out of the
     channel name** (`state.js` `dmParticipants`/`otherDMParticipant`, unit-tested),
     since a single broadcast can't bake in a per-recipient "other". DMs render in
     their own sidebar section; start one by clicking a member in the member list.

### Follow-up fixes (post punch-list)

- **Private-channel invites.** `GET`/`POST /api/channels/{id}/members`
  (`handleListChannelMembers`/`handleAddChannelMember`). Only a channel member
  (or mod+) may invite, only into a real private channel — **public channels 400
  and DMs 403** (a DM is fixed at two participants). Adding a member re-broadcasts
  `channel.new` to the now-larger audience so the invitee learns of it in
  realtime. UI: the `+` in the members panel header opens `#invite-modal`.
  The **members panel is scoped to the active channel's membership** for private
  channels/DMs (public channels show everyone); `refreshActiveMembers()` re-fetches
  on channel open, on invite, and on realtime channel events for the active channel.
- **Pinned messages.** `pinned_at`/`pinned_by` on `messages` (migration `0004`,
  mirrors `edited_at`/`deleted_at`; `pinned_at IS NOT NULL` = pinned). Pin/unpin is
  **moderator+** (`PUT`/`DELETE /api/messages/{id}/pin`); listing
  (`GET /api/channels/{id}/pins`) is any member with channel access. Pin/unpin
  broadcasts a plain `message.update`, so the client folds `pinned_at` in via the
  existing `addMessage` reducer — no new event type. The pins panel
  (`#pins-modal`, 📌 in the channel header) fetches its own list since a pin may be
  older than the loaded message window; deleting a message also clears its pin.
- **Deleted-channel restore/purge.** Channel delete is a soft-delete
  (`archived_at`), and the `UNIQUE(name)` constraint keeps the name reserved while
  archived — so the name can't be reused until the tombstone is dealt with. Admin
  modal "Deleted channels" tab (admin-only): `GET /api/admin/channels/archived`,
  `POST …/{id}/restore` (clears `archived_at`, re-broadcasts `channel.new`; no name
  conflict since the name was never freed), `DELETE /api/admin/channels/{id}`
  (hard delete — cascades messages/members away and frees the name; refuses live
  channels). `archived_at` is now exposed on the channel JSON (omitempty).
- **Scrollback / history.** Storage is unbounded (plain rows, indexed
  `(channel_id, id DESC)`); the API does keyset pagination
  (`GET …/messages?before=<id>&limit=<n>`, `id < before ORDER BY id DESC`). The
  client loads the most recent `PAGE` (50) on open and fetches older pages as you
  scroll near the top (`loadOlderMessages` → `state.oldestMessageId` cursor →
  `prependMessages`), guarded by an in-flight flag and a `historyComplete` set
  (a short page = reached the start). `renderMessages` preserves the reader's
  scroll position on re-render (only auto-scrolls to bottom when already there).
- **In-app unread indicators.** `state.unread` (channelId→count, pure
  `bumpUnread`/`clearUnread`, unit-tested). `message.new` for a non-active channel
  that isn't your own bumps it; selecting a channel clears it. Rendered as a count
  pill + bold name on channel/DM rows. A soft DM chime (Web Audio) plays for DMs.
  (No browser Notification API yet.)
- **Deleted messages** collapse: a run of consecutive soft-deleted messages
  renders as one compact "N messages deleted" line (`renderMessages`).
- **Status text is visible** in the member list (stacked under the name, falling
  back to the presence word); the member-row alignment fix keeps the self row in
  line with the rest.
- **Reactions** (migration `0009`). `message_reactions` PK
  `(message_id, user_id, emoji)` — one of each emoji per user per message is
  intrinsic; add is idempotent (`ON CONFLICT DO NOTHING`). `emoji` is **either** a
  known custom `:shortcode:` **or** a literal Unicode grapheme; the client resolves
  which at render (registry hit → `<img>`, else literal). `PUT`/`DELETE
  /api/messages/{id}/reactions` carry the emoji in the **body** (no URL-encoding of
  Unicode); any member with channel access may toggle their own on a visible,
  non-deleted message (deleted → **409**, no access → **403**). Validation is
  **stdlib-only** (no emoji library — prime directive): a known shortcode, or
  `validUnicodeEmoji` (every rune a symbol/ZWJ/variation-selector/keycap-base and
  ≥1 emoji-ish rune — admits flags, skin-tone & ZWJ sequences, keycaps; rejects
  words). One realtime event, **`reaction.update`**, carries the re-aggregated
  groups (not add/remove deltas), folded client-side by `setReactions` — so a plain
  edit/pin `message.update` that omits `reactions` must **preserve** the existing
  ones (`addMessage` guards this; unit-tested). List/search/pins endpoints decorate
  via the batched `ReactionsForMessages` (no N+1); soft-delete **sheds** reactions
  (`DeleteReactionsForMessage`; cascade covers hard delete). Server stays
  viewer-agnostic — `Reaction{Emoji, UserIDs}` only; the client derives count and
  "did I react". UI: pill row under each message + a "react" action floating the
  shared emoji picker (now also a common-Unicode palette); the pins modal shows
  toggleable pills — `toggleReaction` takes the pill's known `mine` so it's correct
  even when the pinned message is **outside the loaded window** (don't regress this
  to a `findMessage` lookup). Search rows stay text-only (the whole row is
  click-to-jump).
- **Channel topics** are editable inline by **moderator+** (the backend already
  existed: `PATCH /api/channels/{id}`, mod-gated, broadcasts `channel.update`).
  `renderChannelHeader()` is the single place that paints the header title/topic
  (both `loadChannel` and `selectChannel` call it — don't re-inline that paint).
  Clicking the topic span opens an inline `<input>` (`beginTopicEdit`; Enter/blur
  save, Esc cancel). Note the realtime gotcha: a `channel.update` for the **active**
  channel must repaint the header — for a while it only re-rendered the channel
  *list*, so a topic change wouldn't show live; the handler now calls
  `renderChannelHeader` too, but **skips it while an edit input is open** so it
  doesn't clobber your own typing. Modals: Esc closes the top-most open one; the
  About/Pinned modals have no × (backdrop-tap dismisses on mobile).

When in doubt on UI, favor clarity over polish — aesthetics are explicitly
secondary to "it works" for this draft. Keep changes small and tested.

## Status / history

Backend, frontend, and tooling are built and green. Auth, presence/status,
channels (public/private), roles, messaging (with edit/soft-delete), avatars,
realtime, and now DMs are working, plus the full punch list above. Known-good as
of the last session; voice/video was always the big deferred item for later (it
would layer onto the existing WS hub as a signaling channel). If git history is
sparse, commit a baseline before large changes so diffs and rollbacks are clean.
