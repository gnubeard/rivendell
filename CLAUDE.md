# Rivendell — project guide for Claude Code

Small self-hosted chat server (~20 friends). Single Go binary + Postgres + vanilla-JS client.
Owner is technical, privacy-minded; forthright answers, no hand-holding.

## Prime directive: zero new dependencies

**Backend: exactly one third-party module — `github.com/lib/pq`. Everything else is stdlib.**
**Frontend: zero runtime deps.** Do not add an HTTP router, WebSocket lib, password lib,
migration tool, or frontend framework. If a task seems to need a dep, stop and propose it first.
Some choices were forced by the build environment — removing them is not a free win.

## Layout

```
cmd/server/main.go            entrypoint; flags; first-boot bootstrap
internal/config/config.go     env-var config (RIVENDELL_* vars)
internal/auth/                password.go (PBKDF2), token.go (random+hash)
internal/store/               store.go (open/migrate + structs), queries.go (all SQL)
internal/ws/                  websocket.go (RFC 6455), hub.go (fan-out + presence)
internal/httpapi/             server.go (routes/middleware), handlers.go (handler bodies)
internal/push/                push.go (Web Push: VAPID + RFC 8291/8188)
web/static/                   app.js, api.js, ws.js, format.js, state.js,
                              voice.js, secret.js, notify.js, syntax.js, style.css
web/sw.js                     service worker (Web Push)
web/test/                     node:test suites for all pure JS modules
docs/                         otr.md, voice.md, video.md, web_push.md
```

Module path `rivendell`; Go 1.26. Imports `rivendell/internal/...`.

## Build, test, run

- `make build` / `make run` / `make migrate`
- `make test` — Go + frontend. `make test-go` / `make test-web` individually.
- `make fmt` / `make vet` — run both before finishing.

Always run `gofmt`, `go vet ./...`, `go test ./...` (with `TEST_DATABASE_URL`), and
`node --test web/test/*.test.js` before declaring work done. Add tests for new behavior.

## Environment quirks

- **Postgres is a container**, not a host service. No `pg_ctlcluster`. Dev creds:
  user `chat` / pw `chat_dev_pw` / dbs `chat` + `chat_test`.
  Test DB already running at port 55432: `TEST_DATABASE_URL='postgres://chat:chat_dev_pw@localhost:55432/chat_test?sslmode=disable'`
- **Go module proxy unreachable in build sandbox.** Use `go env -w GOPROXY=direct GOSUMDB=off GOFLAGS=-mod=mod`.
- **docker.io unreachable in sandbox** (`403`). `make podman-build` works with normal registry access.
- Run web tests as `node --test web/test/*.test.js` (directory arg is misinterpreted).
- **GitHub push:** `GIT_SSH_COMMAND='ssh -i .creds/claude' git push origin <branch>`

## Conventions

- **List endpoints return `[]`, never `null`.** Use `out := []T{}`. `TestEmptyListsReturnArraysNotNull` guards this.
- **Bump `Version` in `internal/config/config.go`** (patch increment) with every meaningful commit to develop.
- Passwords: PBKDF2 format `pbkdf2-sha256$<iter>$<b64salt>$<b64key>`, 600k iterations. Don't lower.
- Roles: admin > moderator > member. Guard last-admin removal (`CountAdmins`).
- `channelVisibleTo` is the single visibility predicate — `audienceForChannel` and `canAccessChannel` both delegate to it.
  Private non-DM channels include all admins; DMs are strictly members-only.
- `users.status` is durable — `onPresenceChange` must **never** write it. `TestStatusDurableAcrossReconnect` guards this.
- Presence debounce (~1s, `schedulePresenceUpdate`) — don't "simplify" to immediate apply. Own user is exempt.
- `format.js`: escape first, then markdown pass. Links extracted *before* `inlineMarkup` — never refactor to linkify-last.
- CSS: `[hidden] { display: none !important; }` must stay. Wire controls before `startRealtime()`.

## Critical feature invariants (full design notes in README)

**Voice/WebRTC**
- Offerer = lower user_id. Initial offer from `onVoiceState` only — `sendOffer` returns early while `!pc.remoteDescription`.
- Glare re-offer is ONE-SHOT (`renegotiatePending` flag). Do NOT wire to `signalingstatechange` or both peers oscillate.
- TURN credentials are **HMAC-SHA1**, not SHA256. `TestRTCCredentials` asserts 20-byte digest.
- Both `onconnectionstatechange` AND `oniceconnectionstatechange` feed `effectiveConnectionState`. Don't key on either alone.
- DM calls end for both parties (`endDMVoiceCall`/`cleanupVoiceForUser` removes both). `TestDMCallEndsForBothParties` guards.
- Video bitrate cap (800 kbps) is the per-sender CEILING; `bitrateCapFor(numPeers,"video")` shrinks it across senders as the roster grows. Per-peer AIMD congestion control (`monitorCongestion`/`congestionTarget`, every 2.5s) lowers the live target below that ceiling on remote-reported loss/RTT spikes OR a CPU-pinned local encoder (`uplinkStressed`), and climbs back only after `CLIMB_AFTER_HEALTHY` consecutive healthy intervals (`healthyStreak`) — the streak gate is the anti-oscillation fix, don't drop it to one sample. `applyVideoBitrateCaps(uid,pc)` applies the full encoding shape via `withVideoEncodingCaps`: `effectiveVideoCap` (maxBitrate) PLUS `videoScaleForTarget` (scaleResolutionDownBy/maxFramerate) — bitrate-only back-off does NOT relieve a CPU-bound phone encoder, only dropping resolution/framerate does. Stability mechanism, NOT a freeze fix — don't remove it.
- Group caps are server-enforced (`MaxVoiceAudio`/`MaxVoiceVideo`): over-cap join ⇒ `voice.join_denied{reason:"full"}` (abort); over the video sub-cap ⇒ forced video-muted + `reason:"video_full"` (audio-only). DMs are exempt. `TestVoiceJoinDeniedWhenFull`/`TestVoiceVideoSubCap` guard.
- Per-user volume uses `audio.volume`, not Web Audio GainNode (Chromium no-output bug with WebRTC+WebAudio).
- Teardown is synchronous (`finishTeardown` → `closeAllPeers` before farewell-tone await). `callGen` guards rapid re-join.

**Reactions**
- `message.update` that omits `reactions` must PRESERVE existing ones (`addMessage` guards this).
- `toggleReaction` takes the pill's known `mine` — do NOT regress to a `findMessage` lookup.

**Web Push**
- JWT signature is JOSE raw `r||s` (64 bytes), **never DER** — `SignASN1` silently breaks all pushes.
- `aud` recomputed per endpoint (scheme://host) — cached global `aud` rejected by Mozilla/Apple.
- Push only to disconnected users. Runs in goroutine — must never slow message send.

**Secret chat**
- Offerer = lower user_id. Sessions in JS memory only — never persisted.
- No fallback to weaker crypto primitives — ever.
- Server relays `secret.*` WS frames opaque, same DM-membership validation as voice.

**Uploads / blobs**
- Content type sniffed with `http.DetectContentType`, never trusts header.
- Hash is 64-char lowercase hex; validated before use (path-traversal immunity).
- Writes are atomic (tmp + rename). Same bytes → same hash → one file (idempotent).

**Invitations vs magic links**
- `invitations` table is distinct from `magic_links`. Don't merge them.
- Account creation + invitation consumption are one transaction (`store.RedeemInvitation`).

**Link preview proxy: removed.** No arbitrary-URL server-side fetch. YouTube embeds and
message-permalink embeds are client-side only and were intentionally kept.
