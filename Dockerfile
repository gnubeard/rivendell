# syntax=docker/dockerfile:1

# --- build stage ---------------------------------------------------------
FROM golang:1.22-bookworm AS build

WORKDIR /src

# Cache modules first.
COPY go.mod go.sum ./
RUN go mod download

# Build the static binary.
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/snug ./cmd/server

# --- runtime stage -------------------------------------------------------
# Distroless: no shell, no package manager, tiny attack surface.
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app
COPY --from=build /out/snug /usr/local/bin/snug
COPY web /app/web

ENV SNUG_ADDR=:8080 \
    SNUG_WEB_DIR=/app/web

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/snug"]
