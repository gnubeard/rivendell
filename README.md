# rivendell

```
   ____  _                      _      _ _ 
  |  _ \(_)_   _____ _ __   __| | ___| | |
  | |_) | \ \ / / _ \ '_ \ / _` |/ _ \ | |
  |  _ <| |\ V /  __/ | | | (_| |  __/ | |
  |_| \_\_| \_/ \___|_| |_|\__,_|\___|_|_|

  the small private room
```

A self-hosted chat server for a small group of friends — a minimal, private
alternative to Discord and Slack. Ships as a single Go binary backed by Postgres
with a vanilla-JS web client and no frontend dependencies.

- **Backend:** Go 1.22, stdlib only + `github.com/lib/pq` (one dependency, zero transitive)
- **Frontend:** Vanilla JS, no framework, no bundler, no npm packages
- **Database:** PostgreSQL, embedded migrations, no migration tool dependency

---

## Features

- Public and private channels, direct messages
- Roles: admin / moderator / member
- Realtime messaging over WebSocket (hand-rolled RFC 6455)
- Edit and soft-delete messages, pinned messages, scrollback with keyset pagination
- Presence and status (online / away / do not disturb / invisible)
- Unread indicators with DM chime
- Avatars (PNG, JPEG, WebP, GIF)
- Magic-link onboarding — no email server required; admins mint single-use links
- Soft-delete channels with admin restore or hard purge
- Private-channel invites

---

## Requirements

- **Go 1.22+** (only needed to build from source)
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
| `RIVENDELL_WEB_DIR` | `./web` | Path to the static web client. |
| `RIVENDELL_COOKIE_SECURE` | `false` | Set the `Secure` flag on session cookies. Enable when behind TLS. |
| `RIVENDELL_SESSION_TTL` | `720h` | Session lifetime (Go duration syntax: `720h`, `30m`, etc.). |
| `RIVENDELL_MAGIC_LINK_TTL` | `72h` | Set-password link lifetime. |
| `RIVENDELL_MAX_MESSAGE_BYTES` | `8192` | Reject messages larger than this. |
| `RIVENDELL_MAX_AVATAR_BYTES` | `1048576` | Reject avatar uploads larger than this (bytes). |
| `RIVENDELL_INSTANCE_NAME` | `rivendell` | Display name for this instance — shown as the page title and brand. |
| `RIVENDELL_BOOTSTRAP_ADMIN` | `admin` | Username auto-created on first boot when no admins exist. |

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

## License

MIT
