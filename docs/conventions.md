# Conventions

The rules for writing code in rivendell, with the reasoning behind them.

> **Where conventions live.** This file is the human-facing *why*.
> [CLAUDE.md](../CLAUDE.md) at the repo root is the condensed, file-by-file editing
> checklist — every "don't do X" invariant, kept terse for quick scanning. The two
> are deliberately complementary: read this for the rationale, keep CLAUDE.md open
> while editing. Neither restates the other.

## The prime directive: zero new dependencies

**Backend: exactly one third-party module — `github.com/lib/pq`. Everything else is
the standard library. Frontend: zero runtime dependencies.**

No HTTP router, WebSocket library, password library, migration tool, or frontend
framework. The hand-rolled RFC 6455 WebSocket, the PBKDF2 implementation, the
embedded SQL migrations, and the bundler-free module loading are all consequences
of this rule, not accidents — removing them is not a free win. If a task seems to
need a dependency, stop and propose it before writing code. The payoff is a small,
auditable surface that one person can hold in their head and that builds anywhere.

## Naming and layout

- **Source files split by domain.** The store's SQL methods live in
  `store_<domain>.go`; HTTP handlers live in `handlers_<domain>.go`. Add new
  behavior to the matching domain file rather than a catch-all.
- **Docs are kebab-case** (`web-push.md`, `cross-browser.md`), grouped into
  `design/`, `testing/`, and `history/`. See [README.md](README.md).
- **Migrations are numbered and append-only** (`store/migrations/NNNN_*.sql`),
  applied in order at startup. Never edit a migration that has shipped.

## API and data conventions

- **List endpoints return `[]`, never `null`.** Build with `out := []T{}`.
  `TestEmptyListsReturnArraysNotNull` guards this — a `null` body breaks clients
  that expect to iterate.
- **Roles are ordered: admin > moderator > member.** Guard last-admin removal with
  `CountAdmins` so an instance can't be locked out.
- **`users.status` is durable.** Presence wiring (`onPresenceChange`) must never
  write it; `TestStatusDurableAcrossReconnect` guards it.
- **Passwords use PBKDF2** in the format `pbkdf2-sha256$<iter>$<b64salt>$<b64key>`
  at 600k iterations. Don't lower the iteration count.

## Versioning

Bump `Version` in `internal/config/config.go` (patch increment) with every
meaningful commit to `develop` that ships code — it surfaces in `/api/instance` and
the About dialog. Doc-only and test-/tooling-only changes don't need a bump. The
git hooks automate this (see [testing/](testing/README.md)); the `DEPLOY_RE`
allowlist that decides what counts as a shipping change is duplicated across
`scripts/hooks/pre-commit`, `scripts/hooks/post-commit`, and
`.github/workflows/release.yml` — keep the three in sync.

## Frontend specifics

- **CSS: `[hidden] { display: none !important; }` must stay.** Controls are wired
  before `startRealtime()` so a transport failure can never leave handlers
  unattached.
- **ES modules import siblings with bare relative specifiers** (`./api.js`, no
  version suffix). Cache-busting is path-based (see
  [architecture.md](architecture.md)), so one page load resolves each module to one
  URL — the single-instance guarantee that stateful modules rely on.
- **`format.js` escapes first, then makes its markdown pass**, and extracts links
  *before* the inline-markup pass. Never refactor to linkify last. The composer's
  live decoration ([design/rich-text.md](design/rich-text.md)) mirrors these inline
  rules and is kept in lockstep by a parity test.

## Per-subsystem invariants

The features with the sharpest "don't refactor this" edges — voice/WebRTC, secret
chat, Web Push, uploads, reactions, message-pane rendering — each carry their
invariants in their [design/](design/README.md) note and, in condensed form, in
CLAUDE.md. Read the relevant one before touching that subsystem.
