# rivendell — Makefile
# Common housekeeping tasks. Run `make help` for a list.

# Config (override on the command line, e.g. `make run RIVENDELL_ADDR=:9000`)
RIVENDELL_ADDR            ?= :8080
RIVENDELL_DATABASE_URL    ?= postgres://chat:chat_dev_pw@localhost:5432/chat?sslmode=disable
TEST_DATABASE_URL    ?= postgres://chat:chat_dev_pw@localhost:5432/chat_test?sslmode=disable
E2E_DATABASE_URL     ?= postgres://chat:chat_dev_pw@localhost:5432/chat_e2e?sslmode=disable
RIVENDELL_WEB_DIR         ?= ./web

# E2E browser + database-reset plumbing.
#
# E2E_DB_RESET_CMD — how the pre-run schema wipe reaches Postgres. Empty by
#   default: global-setup.js then runs a host `psql` against E2E_DATABASE_URL,
#   which is all a standard setup (local Postgres + host psql) needs. If your e2e
#   DB lives behind a container or a nonstandard port, set this to a command that
#   resets it — the wipe SQL arrives as $E2E_RESET_SQL — in a git-ignored
#   Makefile.local (see Makefile.local.example). Pass E2E_DB_RESET=off to skip the
#   wipe and reuse the DB.
# PLAYWRIGHT_INSTALL — omits `--with-deps`, which shells out to apt-get (Debian/
#   Ubuntu only). If a freshly downloaded browser won't launch, install the OS libs
#   once per host out of band (Debian: `cd web && npx playwright install-deps`).
E2E_DB_RESET_CMD     ?=
# E2E_WEBKIT — opt in to the WebKit (Safari-engine) smoke project. Empty by
#   default so `make test-e2e` is Chromium-only and green on any host. This box
#   sets it (plus the host-setup hook) in Makefile.local.
E2E_WEBKIT           ?=
# E2E_FIREFOX — opt in to the Firefox (Gecko-engine) smoke project. Empty by
#   default, same as WebKit. Unlike WebKit, Gecko needs no native host stack on
#   Linux, so there's no setup hook — Makefile.local just flips this to 1.
E2E_FIREFOX          ?=
# Chromium is always installed; WebKit/Firefox only when their opt-in smoke is
# enabled (E2E_WEBKIT=1 / E2E_FIREFOX=1) — each is a separate ~100 MB download.
# WebKit also needs a provisioned native stack (see docs/testing/cross-browser.md); Gecko
# does not.
PLAYWRIGHT_INSTALL   ?= npx playwright install chromium $(if $(E2E_WEBKIT),webkit) $(if $(E2E_FIREFOX),firefox)

# Per-host overrides (container names, ports, reset command) live here, untracked.
-include Makefile.local
RIVENDELL_PUBLIC_URL      ?= http://localhost:8080
IMAGE                ?= rivendell:latest
BIN                  ?= ./bin/rivendell

# Go build flags: a single static-ish binary, trimmed paths.
GOFLAGS_BUILD        := -trimpath -ldflags "-s -w"

export GOFLAGS := -mod=mod

.PHONY: help build run migrate create-admin podman-create-admin test test-go test-web test-e2e vet fmt tidy \
        docker-build docker-run podman-build podman-test clean install-hooks install-service

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

build: ## Compile the server binary into ./bin
	@mkdir -p bin
	go build $(GOFLAGS_BUILD) -o $(BIN) ./cmd/server
	@echo "built $(BIN)"

run: ## Run the server (needs Postgres up; see RIVENDELL_DATABASE_URL)
	RIVENDELL_ADDR=$(RIVENDELL_ADDR) RIVENDELL_DATABASE_URL=$(RIVENDELL_DATABASE_URL) RIVENDELL_WEB_DIR=$(RIVENDELL_WEB_DIR) \
		go run ./cmd/server

migrate: ## Apply database migrations and exit
	RIVENDELL_DATABASE_URL=$(RIVENDELL_DATABASE_URL) go run ./cmd/server -migrate

create-admin: ## Create first admin + print magic link (needs host Go): make create-admin USER=alice NAME="Alice"
	@test -n "$(USER)" || (echo "set USER=<username> (and optional NAME=...)"; exit 1)
	RIVENDELL_DATABASE_URL=$(RIVENDELL_DATABASE_URL) RIVENDELL_ADDR=$(RIVENDELL_ADDR) \
		go run ./cmd/server -create-admin "$(USER)" "$(NAME)"

podman-create-admin: ## Create an admin using the built image (no host Go): make podman-create-admin USER=alice NAME="Alice"
	@test -n "$(USER)" || (echo "set USER=<username> (and optional NAME=...)"; exit 1)
	podman run --rm --network host \
		-e RIVENDELL_DATABASE_URL="$(RIVENDELL_DATABASE_URL)" \
		-e RIVENDELL_PUBLIC_URL="$(RIVENDELL_PUBLIC_URL)" \
		$(IMAGE) -create-admin "$(USER)" "$(NAME)"
	@echo "Note: on an empty install you don't need this at all — the server"
	@echo "creates the first admin and logs a setup link on first boot."

test: test-go test-web ## Run all tests (Go + web)

test-go: ## Run Go tests (integration tests use TEST_DATABASE_URL)
	TEST_DATABASE_URL=$(TEST_DATABASE_URL) go test ./...

test-web: ## Run frontend unit tests (Node built-in test runner)
	cd web && node --test test/*.test.js

test-e2e: build ## Playwright WebRTC e2e (needs a DISPOSABLE chat_e2e db + ~1.5 GB browser download on first run)
	cd web && npm install
	cd web && $(PLAYWRIGHT_INSTALL)
	cd web && E2E_DATABASE_URL=$(E2E_DATABASE_URL) E2E_DB_RESET_CMD='$(E2E_DB_RESET_CMD)' E2E_WEBKIT='$(E2E_WEBKIT)' E2E_FIREFOX='$(E2E_FIREFOX)' npx playwright test

vet: ## go vet
	go vet ./...

fmt: ## gofmt the tree
	gofmt -w .

tidy: ## go mod tidy
	go mod tidy

docker-build: ## Build the container image with Docker
	docker build -t $(IMAGE) .

docker-run: ## Run the image with Docker (expects external Postgres)
	docker run --rm -p 8080:8080 \
		-e RIVENDELL_DATABASE_URL="$(RIVENDELL_DATABASE_URL)" \
		$(IMAGE)

podman-build: ## Build the container image with Podman
	podman build -t $(IMAGE) .

podman-test: ## Build with Podman and smoke-test the binary inside the image
	podman build -t $(IMAGE) .
	podman run --rm --entrypoint /usr/local/bin/rivendell $(IMAGE) -h 2>&1 | head -5 || true
	@echo "podman image built: $(IMAGE)"

clean: ## Remove build artifacts
	rm -rf bin
	go clean

install-hooks: ## Install git hooks from scripts/hooks/ into .git/hooks/
	@for hook in scripts/hooks/*; do \
		name=$$(basename "$$hook"); \
		chmod +x "$$hook"; \
		ln -sf "../../$$hook" ".git/hooks/$$name"; \
		echo "installed .git/hooks/$$name → $$hook"; \
	done
	@echo "Done. Edit scripts/hooks/post-commit (USER-CONFIGURABLE block) before committing."

install-service: ## Install scripts/claude-bridge.service as a systemd user unit
	@mkdir -p "$$HOME/.config/systemd/user"
	@cp scripts/claude-bridge.service "$$HOME/.config/systemd/user/claude-bridge.service"
	@systemctl --user daemon-reload
	@echo "Installed claude-bridge.service."
	@echo "Create $$HOME/.config/rivendell/claude-bridge.env (see scripts/claude-bridge.service header),"
	@echo "then: systemctl --user enable --now claude-bridge.service"
