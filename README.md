# rivendell

A self-hosted chat server for a small group of friends — a minimal, private
alternative to Discord and Slack. It ships as a single Go binary backed by
PostgreSQL, with a vanilla-JavaScript web client and no frontend build step.

- **Backend** — Go 1.26, standard library plus a single dependency (`github.com/lib/pq`, zero transitive)
- **Frontend** — Vanilla JS: no framework, no bundler, no npm runtime packages
- **Database** — PostgreSQL with embedded SQL migrations applied at startup (no migration tool)

![rivendell chat UI](docs/screenshot.png)

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Development](#development)
- [Architecture](#architecture)
- [Project tooling](#project-tooling)
- [Developer conventions](#developer-conventions)
- [Roadmap](#roadmap)
- [License](#license)

---

## Features

**Messaging**

- Public and private channels with topics, plus direct messages
- Realtime delivery over a hand-rolled RFC 6455 WebSocket
- Edit and soft-delete messages, pin messages, and forward a message to another channel or DM
- Emoji reactions, including instance-wide custom `:shortcode:` emoji
- @-mentions with inline autocomplete, and live typing indicators
- Markdown formatting — bold, italic, `code`, fenced code blocks, strikethrough, spoilers — rendered in messages and shown live in the composer as you type (Ctrl/Cmd-B/I to format; the markers stay visible, just dimmed)
- Full-text search, scoped to the channels you can access
- Scrollback with keyset pagination; every timestamp is a permalink into history

**Calls**

- Voice channels and 1:1 or group calls, with optional camera
- Desktop screen sharing as an alternative video source — including shared tab/system audio (Chrome), tuned to keep text sharp under congestion
- Peer-to-peer WebRTC mesh — no media server (STUN/TURN configurable, with server-enforced participant caps)

**Privacy and security**

- Secret chat — opt-in end-to-end encrypted DMs with a verifiable safety number; sessions live only in browser memory, never on the server
- Roles: admin, moderator, and member
- Magic-link onboarding (no email server required), private-channel invites, and bot accounts with Bearer tokens for scripting

**Media and embeds**

- Image and file uploads to a content-addressed blob store — paste, drop, or attach — with inline rendering
- Markdown links and image embeds; same-origin permalink embeds, YouTube embeds, and og: preview cards for allowlisted domains
- Avatars (PNG, JPEG, WebP, GIF) and per-user UI themes

**Presence and notifications**

- Status (online, away, do-not-disturb, invisible) with automatic idle detection
- Unread badges with a DM chime, per-channel and per-DM mute, and opt-in alerts — foreground desktop notifications plus offline Web Push (installable PWA)

**Administration**

- Admin panel with instance stats: users, channels, messages, and live connections
- Soft-delete channels, with admin restore or hard purge

---

## Requirements

| | Version | Needed for |
| --- | --- | --- |
| **Go** | 1.26+ | Building from source |
| **PostgreSQL** | 14+ | Runtime (always) |
| **Node.js** | any current LTS | Frontend unit tests and Playwright e2e (development only) |

The release binary and container image bundle the web client, so a deployed
instance needs only PostgreSQL.

---

## Quick start

### Docker / Podman

```sh
# build the image
podman build -t rivendell:latest .

# start PostgreSQL (skip if you already have one)
podman run -d --name rivendell-pg \
  -e POSTGRES_USER=chat \
  -e POSTGRES_PASSWORD=changeme \
  -e POSTGRES_DB=chat \
  -p 5432:5432 \
  postgres:16-alpine

# run the server
podman run --rm --network host \
  -e RIVENDELL_DATABASE_URL="postgres://chat:changeme@localhost:5432/chat?sslmode=disable" \
  -e RIVENDELL_PUBLIC_URL="http://localhost:8080" \
  rivendell:latest
```

On first boot the server creates the `admin` user (configurable via
`RIVENDELL_BOOTSTRAP_ADMIN`) and logs a one-time set-password link. Open that link
in your browser to finish setup.

### From source

```sh
git clone https://github.com/gnubeard/rivendell.git
cd rivendell
make build    # → ./bin/rivendell
make run      # build, then run against the dev database
```

`make run` defaults `RIVENDELL_DATABASE_URL` to
`postgres://chat:chat_dev_pw@localhost:5432/chat?sslmode=disable`; override it to
point elsewhere.

---

## Configuration

All configuration is through environment variables — there is no config file. Every
variable is optional except `RIVENDELL_DATABASE_URL` (required in production). Copy
[`.env.example`](.env.example) to `.env` as a starting point.

| Variable | Default | Description |
| --- | :--- | :--- |
| `RIVENDELL_DATABASE_URL` | `postgres://chat:chat_dev_pw@localhost:5432/chat?sslmode=disable` | **Required in production.** PostgreSQL connection string. |
| `RIVENDELL_ADDR` | `:8080` | Listen address. |
| `RIVENDELL_PUBLIC_URL` | `http://localhost:8080` | Base URL used to build magic links. No trailing slash. |
| `RIVENDELL_WEB_DIR` | `web` | Path to the static web client, relative to the working directory. `make run` sets this for you; when running `./bin/rivendell` directly, run from the repo root or set an absolute path. |
| `RIVENDELL_COOKIE_SECURE` | `false` | Set the `Secure` flag on session cookies. Enable when serving over TLS. |
| `RIVENDELL_SESSION_TTL` | `720h` | Session lifetime (Go duration syntax: `720h`, `30m`, …). |
| `RIVENDELL_MAGIC_LINK_TTL` | `72h` | Set-password link lifetime. |
| `RIVENDELL_MAX_MESSAGE_BYTES` | `8000` | Reject messages larger than this. |
| `RIVENDELL_MAX_AVATAR_BYTES` | `524288` | Reject avatar uploads larger than this (512 KiB). |
| `RIVENDELL_MAX_IMAGE_BYTES` | `5242880` | Reject image and file uploads larger than this (5 MiB). |
| `RIVENDELL_BLOBS_DIR` | `blobs` | Directory for content-addressed uploaded blobs. |
| `RIVENDELL_INSTANCE_NAME` | `rivendell` | Display name for this instance — used as the page title and brand. |
| `RIVENDELL_BOOTSTRAP_ADMIN` | `admin` | Username auto-created on first boot when no admins exist. |
| `RIVENDELL_STUN_URL` | `stun:stun.l.google.com:19302` | STUN server for WebRTC. |
| `RIVENDELL_TURN_URL` | _(none)_ | Comma-separated TURN endpoints (e.g. `turn:turn.example.com:3478`). Omit for STUN-only. |
| `RIVENDELL_TURN_SECRET` | _(none)_ | Shared HMAC secret for time-limited coturn (TURN) credentials. |
| `RIVENDELL_VAPID_SUBJECT` | _(public URL)_ | The VAPID `sub` claim sent to the push service — a `mailto:` or `https` URL it can use to reach the operator. The VAPID keypair itself is generated on first boot and stored in the database; nothing else is required for Web Push. |
| `RIVENDELL_MAX_VOICE_AUDIO` | `10` | Maximum participants in one group voice channel. A join past this is refused (`voice.join_denied`). |
| `RIVENDELL_MAX_VOICE_VIDEO` | `6` | Maximum simultaneous cameras-on in one call. Turning a camera on past this keeps you audio-only. |
| `RIVENDELL_LINK_PREVIEW_DOMAINS` | _(curated list — see below)_ | Comma-separated hostnames eligible for og: preview cards. Subdomains are included automatically (e.g. `wikipedia.org` covers `en.wikipedia.org`). Set to `off` to disable previews. Setting this variable **replaces** the default list rather than extending it. |
| `RIVENDELL_DEBUG_TELEMETRY` | `false` | Diagnostic switch for video-call issues: enables `POST /api/debug/telemetry` and tells every client to capture WebRTC `getStats()` snapshots and call-lifecycle events, logged to stdout as `rtc-telem.*` lines. Leave off in normal operation. |

**Default link-preview allowlist:** `github.com`, `wikipedia.org`, `cnn.com`,
`bbc.com`, `bbc.co.uk`, `nytimes.com`, `theguardian.com`, `arstechnica.com`,
`wired.com`, `techcrunch.com`, `twitter.com`, `x.com`, `theatlantic.com`,
`apnews.com`, `nature.com`.

---

## Deployment

### Reverse proxy and TLS (nginx)

A single `location` block handles both HTTP and WebSocket traffic. The
`$connection_upgrade` map resolves the `Connection` header to `upgrade` for
WebSocket requests and `close` for plain HTTP, so no separate block is needed.

```nginx
http {
    # Connection header becomes dynamic: "upgrade" for WS, "close" for HTTP.
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

When serving over TLS, also set:

```sh
RIVENDELL_COOKIE_SECURE=true
RIVENDELL_PUBLIC_URL=https://chat.example.com
```

If you send a `Content-Security-Policy` header, add the `wss://` origin to
`connect-src` explicitly — Firefox does not expand `'self'` to cover `ws`/`wss`.

### Backups

Two things must be backed up, and neither alone is complete — PostgreSQL holds
references to blob hashes, and the blobs directory holds the binary data:

- **PostgreSQL database** — messages, users, channels, and all metadata. Use `pg_dump` or your provider's snapshot mechanism.
- **`RIVENDELL_BLOBS_DIR`** (default `blobs/`) — uploaded images and files. The directory is content-addressed, so a full copy or an incremental `rsync` is sufficient.

### Health checks and monitoring

`GET /api/health` returns `{"status":"ok"}` with HTTP 200 when the server is up and
the database is reachable, or HTTP 503 when the database is unavailable. Wire it
into your uptime monitor or load-balancer health check.

---

## Development

```sh
make test       # Go tests + frontend unit tests
make test-go    # Go tests only
make test-web   # Frontend unit tests only (Node built-in runner)
make fmt        # gofmt
make vet        # go vet
```

### Go integration tests

The Go integration tests hit a real database and are gated on `TEST_DATABASE_URL`.
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

### End-to-end tests

Playwright specs in `web/e2e/` drive the DOM-heavy features (composer, calls,
search, modals, …) in a real browser. They are **not** part of `make test` and need
their own disposable database — separate from your dev DB, since the suite wipes it
before each run:

```sh
make test-e2e E2E_DATABASE_URL='postgres://chat:chat_dev_pw@localhost:55432/chat_e2e?sslmode=disable'
```

Host-specific details — a nonstandard port, or resetting the database through a
container when there is no host `psql` — belong in a git-ignored `Makefile.local`
(copy [`Makefile.local.example`](Makefile.local.example)). The Makefile `-include`s
it, so once it is in place a bare `make test-e2e` works. A standard setup with a
host `psql` needs none of this.

---

## Architecture

rivendell is one Go binary serving a JSON + WebSocket API and a vanilla-JS client
straight from disk — no media server, no message broker, no frontend build step.
State lives in PostgreSQL; uploaded files live in a content-addressed blob
directory on the filesystem.

**Backend** (`internal/`, module path `rivendell`, Go 1.26) is layered by
responsibility:

- **`store`** — the data layer: `database/sql` over the pure-Go `lib/pq` driver, plain auditable SQL (no ORM, no query builder), with schema migrations embedded in the binary and applied in order at startup.
- **`ws`** — a hand-rolled RFC 6455 WebSocket and a hub that fans events out to connected clients and tracks presence.
- **`httpapi`** — the HTTP layer: routing on the stdlib `net/http` ServeMux (no third-party router), middleware (recover / log / auth / role + sessions), the realtime broadcast + channel-visibility logic, and request handlers split into files by domain.
- **`auth`** (PBKDF2 passwords, hashed tokens) and **`push`** (Web Push: VAPID + RFC 8291/8188) round it out — both stdlib-only.

**Frontend** (`web/`) is a single HTML shell plus ES modules served raw, with
path-based cache-busting in place of a bundler. `app.js` is the orchestrator,
progressively carved into focused feature modules (composer, voice/video UI,
search, emoji, …); `sw.js` is the service worker for Web Push. Calls are a
peer-to-peer WebRTC mesh — the server only relays signaling — so media never
touches the backend.

The authoritative, file-by-file map and the per-feature invariants are kept
current in [CLAUDE.md](CLAUDE.md); deeper design notes live in
[docs/design.md](docs/design.md) and the per-subsystem notes alongside it.

---

## Project tooling

### Git hooks

Three hooks live in `scripts/hooks/`. Install them with:

```sh
make install-hooks
```

This symlinks each hook into `.git/hooks/`, so they track changes you pull to the
scripts.

| Hook | What it does |
| --- | --- |
| `pre-commit` | Runs the fast test tier whenever source is staged, on any branch (`gofmt` + `go vet` + `go test` when Go changed; the web unit tests when `web/` changed) — the gate that keeps the `develop` auto-deploy from shipping red code. Then, on `develop`, auto-bumps the patch digit of `Version` in `internal/config/config.go` when a meaningful source file is staged (server code, web assets, Dockerfile, `go.mod`). Skips both for doc-only commits. Escape hatch: `RUN_TESTS=0 git commit …`. |
| `pre-push` | Runs the Playwright e2e suite (`make test-e2e`) when the push range touches runtime source (`cmd/server`, `internal/`, `web/`) — the gate for shipping to `main`. Skips docs/tooling-only pushes. Escape hatch: `RUN_E2E=0 git push …`. |
| `post-commit` | On `develop`, builds a fresh container image and replaces the running container when server source changed. Also restarts `claude-bridge.service` when `scripts/claude-bridge` changes. |

Prefer the `RUN_TESTS=0` / `RUN_E2E=0` escape hatches over `--no-verify`, which
also disables the version bump.

The `post-commit` hook is environment-specific. Edit the `USER-CONFIGURABLE` block
near the top of `scripts/hooks/post-commit` to set your container name, network,
env-file path, and blob volume before installing.

### Claude bridge

`scripts/claude-bridge` is a polling bot that connects a private rivendell channel
(default `#claude`) to [Claude Code](https://claude.com/claude-code), letting you
send tasks from chat and receive threaded replies. See the script header for the
full feature list, environment variables, and setup checklist.

#### As a systemd user service (recommended)

A systemd user service keeps the bridge running in the background, starts it on
login, and restarts it on failure.

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

The `post-commit` hook restarts the service whenever `scripts/claude-bridge`
changes, so new versions take effect on the next `develop` commit.

#### In tmux (alternative)

```sh
export RIVENDELL_URL=https://chat.example.com
export RIVENDELL_BOT_TOKEN=<token>
export RIVENDELL_TEST_DATABASE_URL=postgres://...
tmux new-session -d -s claude-bridge 'scripts/claude-bridge'
```

---

## Developer conventions

Two documents carry the detail, at different altitudes: [CLAUDE.md](CLAUDE.md) is
the condensed checklist of editing rules — the file-by-file map and every "don't do
X" invariant — while [docs/design.md](docs/design.md) and the per-subsystem notes
alongside it carry the design rationale. A few invariants worth calling out here:

- **List endpoints return `[]`, never `null`.** `TestEmptyListsReturnArraysNotNull` enforces this.
- **`users.status` is durable** — `onPresenceChange` must never write it. `TestStatusDurableAcrossReconnect` guards it.
- **`format.js` escapes first, then makes its markdown pass.** Links are extracted *before* `inlineMarkup` — never invert this.
- Voice/WebRTC, secret chat, Web Push, and uploads each carry their own invariants — see the two references above.

---

## Roadmap

Screen sharing — the last major feature — shipped in 2.0.0. What's left is
refinement around the edges of calls:

- **Graceful media fallback** — when a participant has no camera, offer to share their screen instead; when they have no working mic, let them join listen-only (one-way audio beats none).
- **Per-stream receive control** — let a viewer stop receiving a participant's video to save bandwidth. On the P2P mesh this means signalling the sender to stop, not just hiding the tile.

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).
