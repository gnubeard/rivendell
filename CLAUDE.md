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
web/index.html                single-page shell (login / set-password / app views)
web/static/                   app.js, api.js, ws.js, format.js, state.js, style.css
web/test/                     format.test.js, state.test.js (node:test)
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

## Feature notes

Key design invariants per feature — preserve these when modifying related code.

**DMs.** A DM is a private channel with `is_dm = TRUE` and exactly two members (migration `0002_dms.sql`).
- Canonical name `dm-<minUserId>-<maxUserId>` maps a pair to exactly one channel; `UNIQUE(name)` makes create-or-find race-safe (`store.GetOrCreateDM`, `POST /api/dms`).
- Visibility is members-only — even moderators/admins cannot see another pair's DM. `handleListChannels` and `canAccessChannel` special-case `is_dm`; `audienceForChannel` scopes realtime to members.
- The client derives the "other" participant by parsing the two ids out of the channel name (`state.js` `dmParticipants`/`otherDMParticipant`, unit-tested) — a single broadcast can't bake in a per-recipient "other".

**Private-channel invites.** `GET`/`POST /api/channels/{id}/members` (`handleListChannelMembers`/`handleAddChannelMember`). Only a channel member (or mod+) may invite, only into a real private channel — public channels return 400, DMs 403 (fixed at two participants). Adding a member re-broadcasts `channel.new` to the now-larger audience. The members panel is scoped to the active channel's membership for private channels/DMs (public channels show everyone); `refreshActiveMembers()` re-fetches on channel open, on invite, and on realtime channel events for the active channel.

**Pinned messages.** `pinned_at`/`pinned_by` on `messages` (migration `0004`). Pin/unpin is moderator+ (`PUT`/`DELETE /api/messages/{id}/pin`); listing (`GET /api/channels/{id}/pins`) is any member with channel access. Pin/unpin broadcasts a plain `message.update` — no new event type. The pins panel (`#pins-modal`) fetches its own list since a pin may be older than the loaded message window; deleting a message also clears its pin.

**Deleted-channel restore/purge.** Channel delete is a soft-delete (`archived_at`); `UNIQUE(name)` keeps the name reserved while archived. Admin-only: `GET /api/admin/channels/archived`, `POST …/{id}/restore` (clears `archived_at`, re-broadcasts `channel.new`), `DELETE /api/admin/channels/{id}` (hard delete — cascades messages/members, frees the name; refuses live channels). `archived_at` is exposed on the channel JSON (omitempty).

**Scrollback / history.** Keyset pagination: `GET …/messages?before=<id>&limit=<n>`. Client loads the most recent `PAGE` (50) on open and fetches older pages on scroll-near-top (`loadOlderMessages` → `state.oldestMessageId` cursor → `prependMessages`), guarded by an in-flight flag and a `historyComplete` set (short page = reached the start). `renderMessages` preserves the reader's scroll position on re-render; auto-scrolls to bottom only when already there.

**Unread indicators.** `state.unread` (channelId→count, pure `bumpUnread`/`clearUnread`, unit-tested). `message.new` for a non-active channel that isn't your own bumps it; selecting a channel clears it. Rendered as a count pill + bold name on channel/DM rows. A soft DM chime (Web Audio) plays for DMs.

**Deleted message collapse.** A run of consecutive soft-deleted messages renders as one compact "N messages deleted" line in `renderMessages`.

**Reactions** (migration `0009`). `message_reactions` PK `(message_id, user_id, emoji)` — one of each emoji per user per message; add is idempotent (`ON CONFLICT DO NOTHING`). `emoji` is either a known custom `:shortcode:` or a literal Unicode grapheme; the client resolves which at render (registry hit → `<img>`, else literal). `PUT`/`DELETE /api/messages/{id}/reactions` carry the emoji in the body (no URL-encoding of Unicode); deleted messages return 409. Validation is stdlib-only: a known shortcode or `validUnicodeEmoji` (every rune a symbol/ZWJ/variation-selector/keycap-base and ≥1 emoji-ish rune). One realtime event **`reaction.update`** carries re-aggregated groups; a plain `message.update` that omits `reactions` must **preserve** the existing ones (`addMessage` guards this; unit-tested). List/search/pins decorate via batched `ReactionsForMessages` (no N+1); soft-delete sheds reactions. The pins modal shows toggleable pills — `toggleReaction` takes the pill's known `mine` so it's correct even when the pinned message is outside the loaded window (don't regress this to a `findMessage` lookup).

**Channel topics.** Editable inline by moderator+ (`PATCH /api/channels/{id}`, broadcasts `channel.update`). `renderChannelHeader()` is the single paint point for the header title/topic — both `loadChannel` and `selectChannel` call it, don't re-inline. A `channel.update` for the active channel must repaint the header but skips it while an edit input is open to avoid clobbering your own typing. Modals: Esc closes the top-most open one; the About/Pinned modals have no × (backdrop-tap dismisses on mobile).

**Inline message editing.** `renderMessages` is the source of truth — a message whose id == `editingMessageId` draws the inline editor (seeded from `editDraft`). Before each `innerHTML` reset, `renderMessages` captures the live draft + caret + focus and restores them after; focus is only re-grabbed if it was focused, so background re-renders never steal the caret. Don't "simplify" this to preserving a DOM node — drive it from state. Enter saves / Shift+Enter newline / Esc cancels; empty-or-unchanged cancels (delete removes); channel switch abandons the edit; a save error keeps the editor open.

**Markdown links + inline images.** `format.js` extracts links from each escaped run *before* the markdown pass: `inlineMarkup` runs only on the gaps between links, so a URL never feeds through the italic rule — this fixes underscores mangling URLs (don't refactor it back to a single regex sweep that linkifies last). `LINK_RE` matches `[text](url)` (https only) or bare http(s) URLs; a bare URL whose path ends in an image extension renders as `<img class=msg-image>` wrapped in a link. The escape-first XSS invariant is preserved. `formatMessage(..., {embedImages:false})` is used for search rows only (the whole row is click-to-jump). Composer: pasting a single URL onto a non-empty selection wraps it `[selection](url)`.

When in doubt on UI, favor clarity over polish — aesthetics are secondary to "it works." Keep changes small and tested. Commit a baseline before large changes so diffs and rollbacks are clean.

## Backlog

Effort tags: XS = a few lines / one-shot · S = small, one layer · M = a session,
multiple layers · L = full feature (DB+API+realtime+UI) · XL = major project / new
security model. Sorted by effort, lowest first.

- **[M] Voice phase 3 — voice channels (multi-party mesh).** Extend voice.js to manage
  N peer connections, voice-channel sidebar UI (participant list + join/leave), speaking
  indicators (AnalyserNode RMS), per-participant volume sliders, soft cap (warn at 8,
  block at 12). See `docs/voice.md §Phase 3`.
- **[S→M] TURN server (coturn)** so calls work across symmetric NAT / CGNAT. Ops, not
  code: coturn container + `use-auth-secret = RIVENDELL_TURN_SECRET`, open UDP 3478 +
  the relay port range on firewalld AND the Oracle Cloud security list, set
  `RIVENDELL_TURN_URL`. STUN-only works on a LAN / real-IP network; TURN is the relay
  fallback for symmetric NAT / CGNAT.

**Deferred / future:**
- **[XL] OTR / end-to-end encrypted messaging.** Different security model entirely:
  client-side crypto, key generation/exchange, key+trust management (multi-device),
  server stores only ciphertext, verification UI. Signal/OMEMO class — needs its own
  design pass before any implementation.
