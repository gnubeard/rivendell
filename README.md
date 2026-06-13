# rivendell

A self-hosted chat server for a small group of friends — a minimal, private
alternative to Discord and Slack. Ships as a single Go binary backed by Postgres
with a vanilla-JS web client and no frontend dependencies.

- **Backend:** Go 1.26, stdlib only + `github.com/lib/pq` (one dependency, zero transitive)
- **Frontend:** Vanilla JS, no framework, no bundler, no npm packages
- **Database:** PostgreSQL, embedded migrations, no migration tool dependency

![rivendell chat UI](docs/screenshot.png)

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
- Inline markdown links and image embeds; same-origin message permalinks, YouTube embeds, and og: link preview cards for allowlisted domains
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
| --- | :--- | :--- |
| `RIVENDELL_DATABASE_URL` | `postgres://chat:chat_dev_pw@localhost:5432/chat?sslmode=disable` | **Required in production.** Postgres connection string. |
| `RIVENDELL_ADDR` | `:8080` | Listen address. |
| `RIVENDELL_PUBLIC_URL` | `http://localhost:8080` | Base URL used to build magic links. No trailing slash. |
| `RIVENDELL_WEB_DIR` | `web` | Path to the static web client. Relative to the working directory — `make run` sets this automatically; when running `./bin/rivendell` directly, either run from the repo root or set this to an absolute path. |
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
| `RIVENDELL_MAX_VOICE_AUDIO` | `10` | Max participants in one group voice channel. A join past this is refused (`voice.join_denied`). |
| `RIVENDELL_MAX_VOICE_VIDEO` | `6` | Max simultaneous cameras-on in one call. Turning a camera on past this keeps you audio-only. |
| `RIVENDELL_LINK_PREVIEW_DOMAINS` | _(see below)_ | Comma-separated list of hostnames eligible for og: link preview cards. Subdomains are included automatically (e.g. `wikipedia.org` covers `en.wikipedia.org`). Set to `off` to disable previews entirely. Default: `github.com`, `wikipedia.org`, `cnn.com`, `bbc.com`, `bbc.co.uk`, `nytimes.com`, `theguardian.com`, `arstechnica.com`, `wired.com`, `techcrunch.com`, `twitter.com`, `x.com`, `theatlantic.com`, `apnews.com`. Setting this variable **replaces** the default list. |

---

## Backups

Two things must be backed up:

- **PostgreSQL database** — all messages, users, channels, and metadata. Use `pg_dump` or your database provider's snapshot mechanism.
- **`RIVENDELL_BLOBS_DIR`** (default: `blobs/`) — uploaded images and files. This directory is content-addressed; a full directory copy or incremental rsync is sufficient.

Neither alone is a complete backup. Postgres holds references to blob hashes; the blobs directory holds the binary data.

---

## Operations

### Health check

`GET /api/health` — returns `{"status":"ok"}` (HTTP 200) when the server is up and the database is reachable, or HTTP 503 if the database is unavailable. Wire this into your uptime monitor or load balancer health check.

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

The `$connection_upgrade` map lets a single location block handle both HTTP and WebSocket
connections — `Connection` resolves to `upgrade` for WebSocket and `close` for plain HTTP.
No separate location block is needed.

```nginx
http {
    # Makes Connection header dynamic: "upgrade" for WS, "close" for HTTP.
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    server {
        listen 443 ssl;
        server_name chat.example.com;

        location / {
            proxy_pass         http://127.0.0.1:8080;
            proxy_http_version 1.1;
            proxy_set_header   Upgrade    $http_upgrade;
            proxy_set_header   Connection $connection_upgrade;
            proxy_read_timeout 3600s;
        }
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
web/static/                   app.js (orchestrator; being decomposed — see
                              docs/decomposition.md), api.js, ws.js, state.js,
                              format.js, syntax.js, voice.js, secret.js,
                              notify.js, rtcdebug.js, style.css; modules carved
                              out of app.js: unread.js, channelorder.js,
                              drafts.js, composer-field.js, attachments.js,
                              autocomplete.js, prefs.js, previews.js, util.js,
                              search.js, emoji.js
web/sw.js                     service worker (Web Push display + click routing)
web/manifest.json             PWA manifest (installability; iOS push needs install)
web/test/                     node:test unit suites (one per pure JS module)
web/e2e/                      Playwright specs (composer-paste, dm-call,
                              group-call, search, emoji-picker); dev-only, run
                              via `make test-e2e`
docs/                         decomposition.md (frontend module breakup),
                              design.md, otr.md, voice.md, video.md,
                              web_push.md, file_upload.md, composer-paste-qa.md,
                              call-drop-investigation.md, bridge-dm-update-note.md
```

Module path `rivendell`; Go 1.26. Imports are `rivendell/internal/...`.

---

## Git hooks

Two hooks live in `scripts/hooks/` and can be installed with:

```sh
make install-hooks
```

This symlinks each hook into `.git/hooks/` so they stay up-to-date when you
pull changes to the scripts.

| Hook | What it does |
| --- | --- |
| `pre-commit` | On `develop`, auto-bumps the patch digit of `Version` in `internal/config/config.go` whenever a meaningful source file is staged (server code, web, Dockerfile, go.mod). Keeps the version constant in sync with every commit without requiring a manual edit. |
| `post-commit` | On `develop`, builds a fresh container image and replaces the running container when server source changed. Also restarts `claude-bridge.service` when `scripts/claude-bridge` changes. |

The `post-commit` hook is environment-specific. Edit the `USER-CONFIGURABLE`
block near the top of `scripts/hooks/post-commit` to set your container name,
network, env-file path, and blob volume before installing.

---

## Claude bridge

`scripts/claude-bridge` is a polling bot that connects a private rivendell
channel (default: `#claude`) to Claude Code, letting you send tasks to Claude
directly from the chat and receive threaded replies. See the script header for
the full feature list, environment variables, and setup checklist.

### Running as a systemd user service (recommended)

A systemd user service keeps the bridge running in the background, starts it
on login, and restarts it automatically on failure.

**1. Create the env file:**

```sh
mkdir -p ~/.config/rivendell
cat > ~/.config/rivendell/claude-bridge.env <<'EOF'
RIVENDELL_URL=https://chat.example.com
RIVENDELL_BOT_TOKEN=<token from the admin panel, Bot tokens tab>
RIVENDELL_TEST_DATABASE_URL=postgres://chat:<pw>@localhost:55432/chat_test?sslmode=disable
# Optional:
# RIVENDELL_CLAUDE_CHANNEL=claude
# RIVENDELL_RELEASE_UPDATE_CHANNEL=general
EOF
chmod 600 ~/.config/rivendell/claude-bridge.env
```

**2. Install and start the service:**

```sh
make install-service
systemctl --user enable --now claude-bridge.service
```

**3. Check it:**

```sh
systemctl --user status claude-bridge.service
journalctl --user -u claude-bridge.service -f
```

The `post-commit` hook automatically restarts the service whenever
`scripts/claude-bridge` is updated, so new versions take effect immediately
on the next develop commit.

### Running in tmux (alternative)

```sh
export RIVENDELL_URL=https://chat.example.com
export RIVENDELL_BOT_TOKEN=<token>
export RIVENDELL_TEST_DATABASE_URL=postgres://...
tmux new-session -d -s claude-bridge 'scripts/claude-bridge'
```

---

## Developer conventions

The authoritative reference is [CLAUDE.md](CLAUDE.md). Key invariants worth calling out:

- **List endpoints return `[]`, never `null`.** `TestEmptyListsReturnArraysNotNull` enforces this.
- **`users.status` is durable** — `onPresenceChange` must never write it. `TestStatusDurableAcrossReconnect` guards this.
- **`format.js`** escapes first, then markdown pass. Links are extracted *before* `inlineMarkup` — never invert this.
- **Feature subsystem design** — detailed invariants per feature live in [docs/design.md](docs/design.md).

---

## Backlog

- **[XL] Screen sharing / desktop video.** Screen capture track alongside camera in group calls. Highest-priority open feature.
- **Ctrl-B/I inline rich text.** Low priority; may not happen.

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).
