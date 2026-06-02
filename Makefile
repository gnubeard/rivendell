# Snug — Makefile
# Common housekeeping tasks. Run `make help` for a list.

# Config (override on the command line, e.g. `make run SNUG_ADDR=:9000`)
SNUG_ADDR            ?= :8080
SNUG_DATABASE_URL    ?= postgres://chat:chat_dev_pw@localhost:5432/chat?sslmode=disable
TEST_DATABASE_URL    ?= postgres://chat:chat_dev_pw@localhost:5432/chat_test?sslmode=disable
SNUG_WEB_DIR         ?= ./web
SNUG_PUBLIC_URL      ?= http://localhost:8080
IMAGE                ?= snug:latest
BIN                  ?= ./bin/snug

# Go build flags: a single static-ish binary, trimmed paths.
GOFLAGS_BUILD        := -trimpath -ldflags "-s -w"

export GOFLAGS := -mod=mod

.PHONY: help build run migrate create-admin podman-create-admin test test-go test-web vet fmt tidy \
        docker-build docker-run podman-build podman-test clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

build: ## Compile the server binary into ./bin
	@mkdir -p bin
	go build $(GOFLAGS_BUILD) -o $(BIN) ./cmd/server
	@echo "built $(BIN)"

run: ## Run the server (needs Postgres up; see SNUG_DATABASE_URL)
	SNUG_ADDR=$(SNUG_ADDR) SNUG_DATABASE_URL=$(SNUG_DATABASE_URL) SNUG_WEB_DIR=$(SNUG_WEB_DIR) \
		go run ./cmd/server

migrate: ## Apply database migrations and exit
	SNUG_DATABASE_URL=$(SNUG_DATABASE_URL) go run ./cmd/server -migrate

create-admin: ## Create first admin + print magic link (needs host Go): make create-admin USER=alice NAME="Alice"
	@test -n "$(USER)" || (echo "set USER=<username> (and optional NAME=...)"; exit 1)
	SNUG_DATABASE_URL=$(SNUG_DATABASE_URL) SNUG_ADDR=$(SNUG_ADDR) \
		go run ./cmd/server -create-admin "$(USER)" "$(NAME)"

podman-create-admin: ## Create an admin using the built image (no host Go): make podman-create-admin USER=alice NAME="Alice"
	@test -n "$(USER)" || (echo "set USER=<username> (and optional NAME=...)"; exit 1)
	podman run --rm --network host \
		-e SNUG_DATABASE_URL="$(SNUG_DATABASE_URL)" \
		-e SNUG_PUBLIC_URL="$(SNUG_PUBLIC_URL)" \
		$(IMAGE) -create-admin "$(USER)" "$(NAME)"
	@echo "Note: on an empty install you don't need this at all — the server"
	@echo "creates the first admin and logs a setup link on first boot."

test: test-go test-web ## Run all tests (Go + web)

test-go: ## Run Go tests (integration tests use TEST_DATABASE_URL)
	TEST_DATABASE_URL=$(TEST_DATABASE_URL) go test ./...

test-web: ## Run frontend unit tests (Node built-in test runner)
	cd web && node --test test/*.test.js

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
		-e SNUG_DATABASE_URL="$(SNUG_DATABASE_URL)" \
		$(IMAGE)

podman-build: ## Build the container image with Podman
	podman build -t $(IMAGE) .

podman-test: ## Build with Podman and smoke-test the binary inside the image
	podman build -t $(IMAGE) .
	podman run --rm --entrypoint /usr/local/bin/snug $(IMAGE) -h 2>&1 | head -5 || true
	@echo "podman image built: $(IMAGE)"

clean: ## Remove build artifacts
	rm -rf bin
	go clean
