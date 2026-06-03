# Snug — project guide for Claude Code

Snug is a small, self-hosted chat server for ~20 friends (a private Discord/Slack
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
internal/config/config.go     env-var config (all SNUG_* vars)
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

Module path is `snug`; Go 1.22. Imports are `snug/internal/...`.

## Build, test, run (use the Makefile)

- `make build` — compile to `./bin/snug`.
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

- **Postgres is managed as a system cluster**, not via `pg_ctl` directly. Start it
  with `pg_ctlcluster 16 main start`. Config lives at `/etc/postgresql/16/main/`,
  not in `PGDATA`. Dev role/db: user `chat`, password `chat_dev_pw`, databases
  `chat` and `chat_test`. Default DSN:
  `postgres://chat:chat_dev_pw@localhost:5432/chat?sslmode=disable`.
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
- **Auth:** session cookie `snug_session` (HttpOnly, SameSite=Lax, Secure from
  config). Tokens are random 256-bit, stored only as SHA-256 hashes. No email —
  admins mint single-use magic links for set/reset password.
- **Passwords:** `internal/auth/password.go`, format
  `pbkdf2-sha256$<iter>$<b64salt>$<b64key>`, 600k iterations, constant-time
  compare. Don't lower the iteration count.
- **Roles:** admin > moderator > member (`roleRank` in handlers). Guard against
  removing/disabling the last admin (`CountAdmins`).
- **Realtime:** the hub broadcasts `{type, payload}` events. Private-channel events
  are scoped to an audience set (`audienceForChannel`, fail-closed). `/api/ws` is
  deliberately not logged by `logMW` (to preserve the Hijacker) — its absence from
  logs is expected, not a bug.
- **Frontend:** keep `format.js` and `state.js` pure and unit-tested. `format.js`
  is XSS-safe by construction (escape first, then a fixed markdown-lite pass on the
  escaped string) — preserve that ordering. The CSS relies on
  `[hidden] { display: none !important; }` to beat class-level `display` rules;
  don't remove it. Realtime init must never be able to break UI wiring — wire
  controls before `startRealtime()`, and `new WebSocket` is wrapped because some
  browsers throw synchronously under a CSP that doesn't allow the `wss:` origin.

## Configuration (env vars, all optional except the DB URL in prod)

`SNUG_ADDR`, `SNUG_DATABASE_URL`, `SNUG_WEB_DIR`, `SNUG_PUBLIC_URL`,
`SNUG_COOKIE_SECURE`, `SNUG_SESSION_TTL`, `SNUG_MAGIC_LINK_TTL`,
`SNUG_MAX_MESSAGE_BYTES`, `SNUG_MAX_AVATAR_BYTES`, `SNUG_BOOTSTRAP_ADMIN`. See
`.env.example`. On an empty install the server creates a first admin
(`SNUG_BOOTSTRAP_ADMIN`, default `admin`) and logs a one-time set-password link;
this fires only when there are zero admins.

## Deployment notes (behind nginx + TLS)

Set `SNUG_PUBLIC_URL` to the externally reachable URL or magic links point at
localhost. Set `SNUG_COOKIE_SECURE=true` when served over HTTPS. Two nginx things
are required for realtime:

1. A dedicated `location /api/ws` that upgrades the connection
   (`proxy_http_version 1.1;` + `Upgrade`/`Connection "upgrade"` headers; bump
   `proxy_read_timeout`, the socket is long-lived; server pings every 30s).
2. If a Content-Security-Policy header is set, `connect-src` must explicitly list
   the `wss://` origin — Firefox does not expand `'self'` to cover `ws/wss`.

## Punch list (requested next work, with notes)

1. **Private-channel creation UX.** Currently the new-channel flow uses a
   `confirm()` ("cancel = not private"), which is confusing. Replace with an
   explicit control (a real "Private" checkbox/toggle in a small create-channel
   form/modal). Pure frontend.
2. **Let users edit display name and status text.** Backend already supports it
   (`PATCH /api/me` via `handleUpdateMe`; status text has a click handler). Add
   proper UI for editing the display name (and tidy the status-text affordance).
3. **Fix presence dot colors.** `away` and `dnd` currently show the green
   (online) indicator. Give each status its own color in `renderMembers`/CSS
   (e.g. online=green, away=amber, dnd=red, offline=grey). Small CSS + class logic.
4. **Scrolling.** Once messages exceed the viewport, the whole page scrolls.
   Scrolling should be contained to the message list. Fix the flex/overflow on the
   app grid and `.message-list` (it should be the scroll container;
   `min-height: 0` on flex children is the usual culprit).
5. **Delete and reorder channels.** Backend already has `ArchiveChannel`
   (`DELETE /api/channels/{id}`) and `UpdateChannel` with a `position` field
   (`PATCH /api/channels/{id}`). Needs UI: a delete affordance (mod/admin only) and
   a way to reorder (drag, or up/down — keep it simple, no DnD library).
6. **DMs.** Implement a DM as a **private channel with exactly two members, reusing
   the existing `channels` + `channel_members` model** — do NOT build a parallel
   messaging system. The owner's own framing: "a DM is basically a channel with 2
   people in it." Suggested approach: mark such channels (e.g. an `is_dm` flag or a
   naming/type convention), create-or-find the 2-member channel when starting a DM,
   and in the UI render DMs in their own list section showing the *other*
   participant's display name instead of the channel name. Respect the existing
   private-channel audience scoping for realtime.

When in doubt on UI, favor clarity over polish — aesthetics are explicitly
secondary to "it works" for this draft. Keep changes small and tested.

## Status / history

Backend, frontend, and tooling are built and green. Auth, presence/status,
channels (public/private), roles, messaging (with edit/soft-delete), avatars, and
realtime are working. Known-good as of the last session; voice/video was always
the big deferred item for later (it would layer onto the existing WS hub as a
signaling channel). If git history is sparse, commit a baseline before large
changes so diffs and rollbacks are clean.
