# Testing

How rivendell is tested, the databases the tests need, and the git hooks that
enforce them. The detailed engine- and device-specific notes live alongside this
file: [cross-browser.md](cross-browser.md) (WebKit + Gecko smoke specs),
[image-paste-qa.md](image-paste-qa.md) (the manual clipboard checklist),
[flaky-e2e.md](flaky-e2e.md) (e2e timing races found + hardened — read before adding
test retries), and [call-ui-video-staleness.md](call-ui-video-staleness.md) (an OPEN,
handed-off call-UI bug behind the remaining `dm-call`/`group-call` camera flakes).

## The test tiers

| Tier | Command | What it covers |
|---|---|---|
| Go | `make test-go` | Backend unit + integration tests (hit a real database). |
| Web unit | `make test-web` | Pure JS modules via Node's built-in runner. |
| Both of the above | `make test` | The full fast suite — what you run before finishing. |
| End-to-end | `make test-e2e` | DOM-heavy features driven in a real browser (Playwright). |
| Formatting / vet | `make fmt` / `make vet` | gofmt and `go vet ./...`. |

The dividing line on the frontend: **pure modules are unit-tested** (`web/test/*.test.js`,
run as `node --test web/test/*.test.js` — a directory argument is misinterpreted),
while **DOM-carrying modules are covered by e2e** instead, because they can't be
imported under Node. `web/test/atlas.test.js` is a special case: it reads `app.js`
and `docs/atlas.md` as *text* and guards that the in-file REGION banners stay in
sync with the [atlas](../atlas.md).

Always run gofmt, `go vet ./...`, `go test ./...`, and the web unit tests before
declaring work done, and add tests for new behavior.

## Databases

Go integration tests are gated on `TEST_DATABASE_URL` and run against a real
PostgreSQL. The e2e suite needs its **own** disposable database, separate from your
dev DB, because the suite wipes it before each run.

```sh
export TEST_DATABASE_URL='postgres://chat:<pw>@localhost:<port>/chat_test?sslmode=disable'
make test-go

make test-e2e E2E_DATABASE_URL='postgres://chat:<pw>@localhost:<port>/chat_e2e?sslmode=disable'
```

Host-specific details — a nonstandard port, or resetting the database through a
container when there's no host `psql` — belong in a git-ignored `Makefile.local`
(copy `Makefile.local.example`). The Makefile `-include`s it, so once it's in place
a bare `make test-e2e` works.

All Go DB tests route through `internal/dbtest.Open`, which takes a per-package
advisory lock so parallel packages can't `TRUNCATE` each other's data mid-run.

## The git hooks are the gate

The hooks (`make install-hooks`) **enforce** the suite, because on `develop` the
`post-commit` hook deploys the moment a shipping commit lands — so the hooks are the
only checkpoint upstream of the deploy.

- **`pre-commit`** runs the fast tier whenever source is staged, on any branch:
  gofmt + `make vet` + `make test-go` when Go changed, `make test-web` when `web/`
  changed. Then, on `develop`, it auto-bumps the patch digit of `Version` when a
  *shipping* source file is staged.
- **`pre-push`** runs the slow `make test-e2e` when the push range touches
  `cmd/server`, `internal/`, or `web/` — the gate for shipping to `main`.

What counts as a *shipping* change (and so triggers the version bump and deploy) is
the `DEPLOY_RE` allowlist — server code, the runtime web assets (`web/static`,
`web/sw.js`, `web/index.html`, `web/manifest.json`), `Dockerfile`, `go.mod` — kept
in sync across `scripts/hooks/pre-commit`, `scripts/hooks/post-commit`, and
`.github/workflows/release.yml`. Doc-only and test-/tooling-only commits run the
test gate but neither bump nor deploy.

### Escape hatches

For deliberate WIP, prefer these targeted env vars over `--no-verify` (which
disables everything at once, including the version bump):

| Variable | Effect |
|---|---|
| `RUN_TESTS=0 git commit …` | Skip the pre-commit test gate; the version bump still runs. |
| `RUN_BUMP=0 git commit …` | Skip the version bump; the test gate still runs. |
| `RUN_DEPLOY=0 git commit …` | Skip the post-commit image rebuild + container replace. |
| `RUN_E2E=0 git push …` | Skip the pre-push e2e suite. |

`RUN_BUMP=0` and `RUN_DEPLOY=0` are the right pair when a shipping file changed in a
way that shouldn't ship a new version — e.g. a comment-only edit.

## Cross-browser and manual checks

The Chromium e2e suite can't see Safari- or Firefox-only regressions, and can't
exercise real-device clipboard flows. Those are covered by:

- **[cross-browser.md](cross-browser.md)** — the opt-in WebKit (`E2E_WEBKIT=1`) and
  Gecko (`E2E_FIREFOX=1`) smoke specs, plus the RHEL-family host provisioning WebKit
  needs.
- **[image-paste-qa.md](image-paste-qa.md)** — the manual checklist to run by hand
  when touching image-paste, the clipboard, or the contenteditable composer.
