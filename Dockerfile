# syntax=docker/dockerfile:1

# --- build stage ---------------------------------------------------------
FROM golang:1.26-bookworm AS build

WORKDIR /src

# Cache modules first.
COPY go.mod go.sum ./
RUN go mod download

# Build the static binary.
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/rivendell ./cmd/server

# --- runtime stage -------------------------------------------------------
# Distroless: no shell, no package manager, tiny attack surface. *
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app
COPY --from=build /out/rivendell /usr/local/bin/rivendell
COPY web /app/web

ENV RIVENDELL_ADDR=:8080 \
    RIVENDELL_WEB_DIR=/app/web

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/rivendell"]
