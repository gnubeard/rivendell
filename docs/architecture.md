# Architecture

rivendell is a single Go binary that serves a JSON + WebSocket API and a
vanilla-JS client straight from disk — no media server, no message broker, no
frontend build step. State lives in PostgreSQL; uploaded files live in a
content-addressed directory on the filesystem. It is sized for ~20 friends, and
that scale is what makes the simple choices correct.

## The one binary

`cmd/server/main.go` is the entrypoint: it reads `RIVENDELL_*` configuration
(`internal/config`), opens the database and applies any pending migrations,
bootstraps the first admin on an empty database, and starts the HTTP server. The
same process serves the API, upgrades WebSocket connections, and serves the static
client. There is nothing else to deploy.

## Backend layers

The backend (`internal/`, module path `rivendell`, Go 1.26) is layered by
responsibility:

- **`store`** — the data layer. `database/sql` over the pure-Go `lib/pq` driver,
  plain auditable SQL (no ORM, no query builder). Schema migrations are embedded in
  the binary (`store/migrations/NNNN_*.sql`) and applied in order at startup. The
  SQL methods are split by domain into `store_<domain>.go`; `queries.go` holds the
  shared helpers (`ErrNotFound`, row collectors, `IsUniqueViolation`).
- **`ws`** — a hand-rolled RFC 6455 WebSocket (`websocket.go`) and a hub
  (`hub.go`) that fans events out to connected clients and tracks presence. The hub
  also holds the ephemeral, in-memory voice-channel roster — call state never
  touches the database.
- **`httpapi`** — the HTTP layer. Routing on the stdlib `net/http` ServeMux (no
  third-party router); middleware for recover / log / auth / role and session
  cookies (`middleware.go`); the realtime broadcast and channel-visibility logic
  (`realtime.go`); and request handlers split into `handlers_<domain>.go` files.
- **`auth`** — PBKDF2 passwords and hashed random tokens.
- **`push`** — Web Push (VAPID + RFC 8291/8188), composed from the standard
  library.

Every package above is standard-library-only; `lib/pq` is the single third-party
module in the whole backend. See [conventions.md](conventions.md) for why.

## Request and event lifecycle

A normal action follows one path:

1. The client sends an authenticated HTTP request. Middleware recovers panics,
   logs, and resolves the session cookie (or Bearer token, for bots) to a user and
   role before the handler runs.
2. The domain handler validates input, calls the `store` to read or write, and
   writes a JSON response (`httputil.go`'s `writeJSON`/`writeErr` helpers).
3. If the action produces a realtime event (a new message, a reaction, presence),
   the handler hands it to the hub, which computes the audience via the single
   channel-visibility predicate (`channelVisibleTo`) and pushes the event over each
   recipient's live WebSocket.
4. The client's WebSocket pump folds the event into its immutable state model and
   repaints the affected surfaces.

Calls bypass the server for media entirely: clients form a peer-to-peer WebRTC
mesh and the server only relays signaling frames (`voice.*` / `secret.*`) between
members of a channel it has already authorized. Offline notifications take the
other branch — when a recipient has no live socket, the server sends an encrypted
Web Push instead (see [design/web-push.md](design/web-push.md)).

## Frontend

The frontend (`web/`) is one HTML shell plus ES modules served raw, with
path-based cache-busting in place of a bundler. `web/static/app.js` is the
orchestrator that wires the API, the WebSocket, the formatter, and the pure
`state.js` reducer to the DOM; over time its self-contained logic has been carved
into focused sibling modules (composer, voice/video UI, search, emoji, …). For a
guided tour of `app.js`, see [atlas.md](atlas.md); for the module breakup, see
[history/frontend-decomposition.md](history/frontend-decomposition.md).

Cache-busting is path-based: `index.html` loads the entry from
`/v/<version>/static/app.js`, and relative imports keep every sibling under that
same prefix, so one page load resolves each module to exactly one URL. The server
strips the version prefix and serves the file raw and immutable. `web/sw.js` is the
service worker, used only for Web Push.

## Where the detail lives

This file is the map. The per-feature design notes in [design/](design/README.md)
carry the rationale and invariants for each subsystem; [CLAUDE.md](../CLAUDE.md) at
the repo root is the condensed, file-by-file editing checklist.
