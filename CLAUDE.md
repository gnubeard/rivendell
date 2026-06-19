# rivendell — project guide for Claude Code

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
internal/store/               store.go (open/migrate + structs), queries.go (core:
                              ErrNotFound, collectRows/exec helpers, IsUniqueViolation);
                              the SQL methods are split by domain into store_<domain>.go
                              (users, emoji, admin, auth, invitations, channels, messages,
                              reactions, read, push, blobs, previews),
                              migrations/ (0001..NNNN .sql, embedded + applied in order)
internal/ws/                  websocket.go (RFC 6455), hub.go (fan-out + presence)
internal/httpapi/             server.go (Server struct + New + the Handler route
                              table), middleware.go (recover/log/auth/role + session
                              cookies), realtime.go (broadcast/audience/visibility +
                              onPresenceChange), ws_dispatch.go (onWSMessage + voice/
                              secret WS signaling + call teardown), static.go (versioned/
                              templated static serving), httputil.go (writeJSON/writeErr/
                              decodeBody/pathInt helpers); handlers.go (core: health/
                              instance/voice-state reads/WS upgrade + shared vars),
                              handlers_<domain>.go (handler bodies split by domain: auth,
                              users, channels, messages, reactions, pins, emoji, admin,
                              blobs, push)
internal/push/                push.go (Web Push: VAPID + RFC 8291/8188)
web/static/                   app.js (orchestrator; decomposed as far as is
                              sensible — now mapped by 8 REGION banners over 31
                              section markers, see docs/atlas.md; carve history
                              in docs/history/frontend-decomposition.md), api.js, ws.js, state.js,
                              format.js, syntax.js, voice.js (WebRTC engine),
                              secret.js, notify.js, rtcdebug.js, tones.js (all
                              Web Audio synthesis: chime + greet/farewell +
                              ring/pending), style.css; modules carved out of
                              app.js: unread.js, channelorder.js, drafts.js,
                              composer-field.js, composer-richtext.js (live
                              markdown decoration in the composer: createComposerRichText
                              owns highlight()+Ctrl-B/I, free export decorate),
                              attachments.js, autocomplete.js,
                              prefs.js, previews.js, util.js, search.js, emoji.js,
                              channeldrag.js, presence.js, imagewarm.js,
                              linkpreview.js, admin.js, secretui.js, forward.js,
                              pins.js, modals.js, mobilectx.js, videogrid.js,
                              voiceui.js (call/ring UI over voice.js: call strip,
                              ring banner, PTT, volume slider, camera + screen-share
                              toggles),
                              notifyui.js (foreground-notification UX over notify.js:
                              missed-count badge/title, ping toast, Web Push
                              subscription lifecycle, profile opt-in control),
                              history.js (message-pane history/paging + scroll
                              sub-system: createHistoryPaging factory owns the
                              older/newer paging, sentinels, history-window flags +
                              banner; free exports PAGE/NEAR_BOTTOM_PX/isNearBottom/
                              scrollToBottom; loadChannel/jumpToMessage stay in app.js
                              and drive it via accessors)
web/sw.js                     service worker (Web Push)
web/test/                     node:test unit suites for the pure JS modules
                              (DOM-carrying modules are covered by e2e instead)
web/e2e/                      Playwright specs (composer-paste, dm-call,
                              group-call, search, emoji-picker, channel-reorder,
                              link-previews, admin, secret-chat, forward, pins,
                              modals, mobile-ctx, video-grid, notifications,
                              non-admin, bot-dm, history, composer-richtext,
                              screen-share, live-append, optimistic-send,
                              lightbox-gallery, remove-embed, typing,
                              image-pin);
                              Chromium by default,
                              dev-only, run via `make test-e2e`. Plus webkit-smoke
                              (Safari-engine), opt-in via E2E_WEBKIT, and
                              firefox-smoke (Gecko-engine sibling), opt-in via
                              E2E_FIREFOX — both boot the client under the real
                              engine + probe getUserMedia; see docs/testing/cross-browser.md
docs/                         README.md (index of everything below), architecture.md
                              (system overview), conventions.md (code conventions),
                              atlas.md (app.js navigation map: 8 regions over 31
                              sections + structural findings);
                              design/ (per-feature design notes: README.md index +
                              voice.md, video.md, secret-chat.md, web-push.md,
                              uploads.md, rich-text.md);
                              testing/ (README.md guide + cross-browser.md
                              [WebKit+Gecko smoke] + image-paste-qa.md);
                              history/ (archive: frontend-decomposition.md,
                              call-drop-investigation.md)
```

Module path `rivendell`; Go 1.26. Imports `rivendell/internal/...`.

## Build, test, run

- `make build` / `make run` / `make migrate`
- `make test` — Go + frontend. `make test-go` / `make test-web` individually.
- `make fmt` / `make vet` — run both before finishing.

Always run `gofmt`, `go vet ./...`, `go test ./...` (with `TEST_DATABASE_URL`), and
`node --test web/test/*.test.js` before declaring work done. Add tests for new behavior.

The git hooks (`make install-hooks`) now **enforce** this — they are the gate, since
the deploy fires from `post-commit`. `pre-commit` runs the fast tier whenever source
is staged (gofmt + `make vet` + `make test-go` when Go changed; `make test-web` when
`web/` changed) on any branch, then the develop-only version bump. `pre-push` runs the
slow `make test-e2e` only when pushing `main` (the release gate) and the push range
touches `cmd/server|internal/|web/` — a `develop`/feature push skips it, so pushing
develop+main together runs the suite once. Escape
hatches for deliberate WIP (prefer these over `--no-verify`, which disables
everything at once): `RUN_TESTS=0 git commit …` (skip the test gate),
`RUN_BUMP=0 git commit …` (skip the version bump), `RUN_DEPLOY=0 git commit …` (skip
the post-commit deploy), `RUN_E2E=0 git push …` (skip the e2e suite). `RUN_BUMP=0` +
`RUN_DEPLOY=0` together are for a shipping-file change that shouldn't ship a new
version, e.g. a comment-only edit. See docs/testing/README.md.

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
- **Bump `Version` in `internal/config/config.go`** (patch increment) with every meaningful commit to develop. Doc-only changes (`README.md`, `CLAUDE.md`, `docs/`) don't need a bump — and neither do test-/tooling-only changes (`web/e2e`, `web/test`, the playwright config, Makefiles). The `pre-commit` hook only auto-bumps (and `post-commit` only deploys) when a *shipping* source file is staged: server code, the runtime web assets (`web/static`, `web/sw.js`, `web/index.html`, `web/manifest.json`), `Dockerfile`, or `go.mod`. This `DEPLOY_RE` allowlist lives in `scripts/hooks/pre-commit` + `post-commit` + `.github/workflows/release.yml` — keep the three in sync.
- Passwords: PBKDF2 format `pbkdf2-sha256$<iter>$<b64salt>$<b64key>`, 600k iterations. Don't lower.
- Roles: admin > moderator > member. Guard last-admin removal (`CountAdmins`).
- `channelVisibleTo` is the single visibility predicate — `audienceForChannel` and `canAccessChannel` both delegate to it.
  Private non-DM channels include all admins; DMs are strictly members-only.
- `users.status` is durable — `onPresenceChange` must **never** write it. `TestStatusDurableAcrossReconnect` guards this.
- Presence debounce (~1s, `schedulePresenceUpdate`) — don't "simplify" to immediate apply. Own user is exempt.
- `format.js`: escape first, then markdown pass. Links extracted *before* `inlineMarkup` — never refactor to linkify-last. The link scanner is **one** regex built by `makeLinkRe(escaped)`: `LINK_RE` (escaped-HTML context, for `inline()`) and `RAW_LINK_RE` (raw text, for the `extract*`/`suppressEmbedURL` helpers) are its two instances — don't re-introduce per-function copies. Groups: `m[1]` `<autolink>`, `m[2]`/`m[3]` `[text](url)`, `m[4]` bare URL. An `<angle-bracketed>` URL is a deliberate opt-OUT: it renders as a plain link (never an image/preview) and every `extract*` skips it. The author "remove embed" affordance (a hover × on a card / `.msg-image-url` image, or the mobile long-press sheet) is just `suppressEmbedURL` wrapping the embed's URL in `<>` via an edit. `e2e/remove-embed` pins it.
- `composer-richtext.js`: live composer decoration **mirrors** `format.js`'s inline rules (bold before italic, code pulled out first) — keep them in lockstep; the parity test guards it. Load-bearing invariant: `decorate` only WRAPS runs (markers kept, dimmed), never adds/removes a character, so `.value` stays the exact markdown source and the facade's text-offset caret math holds. The composer's `input` handler captures the caret offsets BEFORE its image-harvest/flatten mutations and threads them to `rich.onInput(start,end)` — those mutations destroy the live Selection but not the offsets.
  - **Decoration toggle is ORTHOGONAL to behavior.** `prefs.loadRichText()` (default ON, profile checkbox `#richtext-enable`) only controls whether markdown is *rendered styled*; Ctrl-B/I and undo/redo work either way. Don't re-couple them.
  - **Undo/redo is OURS, always-on.** Because both the decoration rewrite and Ctrl-B/I mutate the field programmatically (innerHTML / `.value`), the browser's native history is desynced and unreliable — so `createUndoHistory` (pure, unit-tested) replaces it wholesale and `handleKeydown` preventDefaults Ctrl/Cmd-Z, Cmd-Shift-Z, Ctrl-Y. Typing coalesces into word-ish steps; Ctrl-B/I and the URL-wrap paste (`rich.commit()`) are discrete steps. Any out-of-band `.value` set (channel switch, send-clear, error-restore) must call `rich.resetHistory()` so undo can't bridge that boundary.
- CSS: `[hidden] { display: none !important; }` must stay. Wire controls before `startRealtime()`.
- Frontend ES modules import siblings with **bare relative specifiers** (`./api.js`,
  no version suffix). Cache-busting is **path-based**: index.html loads the entry from
  `/v/<version>/static/app.js`, and relative imports keep every sibling under that same
  prefix, so one page load resolves each module to one URL = one instance (the
  single-instance guarantee for stateful modules like secret.js). The server strips
  `/v/<version>/` and serves the file raw + immutable (`handleVersionedStatic`); the
  `<version>` value is a pure cache key (ignored on read). A bump changes the prefix ⇒
  all module URLs change at once. Only index.html and sw.js still carry the
  `__RIVENDELL_VERSION__` token (templated at serve time). Guarded by the
  `TestVersioned*` / `TestIndexReferencesVersionedEntry` tests in `static_test.go`.

## Critical feature invariants (full rationale in docs/design/ — the README.md index and the per-subsystem notes)

**Voice/WebRTC**
- Offerer = lower user_id. Initial offer from `onVoiceState` only — `sendOffer` returns early while `!pc.remoteDescription`.
- Glare re-offer is ONE-SHOT (`renegotiatePending` flag). Do NOT wire to `signalingstatechange` or both peers oscillate.
- TURN credentials are **HMAC-SHA1**, not SHA256. `TestRTCCredentials` asserts 20-byte digest.
- Both `onconnectionstatechange` AND `oniceconnectionstatechange` feed `effectiveConnectionState`. Don't key on either alone.
- DM calls end for both parties (`endDMVoiceCall`/`cleanupVoiceForUser` removes both). `TestDMCallEndsForBothParties` guards.
- Video bitrate cap (800 kbps) is the per-sender CEILING; `bitrateCapFor(numPeers,"video")` shrinks it across senders as the roster grows. Per-peer AIMD congestion control (`monitorCongestion`/`congestionTarget`, every 2.5s) lowers the live target below that ceiling on remote-reported loss/RTT spikes OR a CPU-pinned local encoder (`uplinkStressed`). Recovery is deliberately SLOW (the AIMD asymmetry): climb only after `CLIMB_AFTER_HEALTHY`=4 consecutive healthy intervals (`healthyStreak`), by a small `+40k` step — a fast climb reads "loss cleared because we backed off" as "link healed", re-probes the ceiling, and re-chokes. **The climb has memory: `softCeilingFor` learns a per-peer cap (`meta.softCeiling`), ratcheting to 85% of the bitrate that just broke on each stress and re-probing up only by a slow `+5k`/settled-interval — so the target PARKS near the sustainable rate instead of sawtoothing through the cliff (the marginal-wifi call-drop fix). Don't remove the soft ceiling or speed the climb.** `applyVideoBitrateCaps(uid,pc)` applies the full encoding shape via `withVideoEncodingCaps`: `effectiveVideoCap` (maxBitrate) PLUS `videoScaleForTarget` (scaleResolutionDownBy/maxFramerate), filtered through `resolutionWithHysteresis` (coarsen at once, refine toward native res ONE tier at a time and only with 20% headroom — a wiggling target must not flap resolution, since each change forces an expensive keyframe; per-peer scale tracked in `meta.videoScale`, reset on a camera↔screen swap). It also sets the sender's `degradationPreference` (screen+motion ⇒ `maintain-framerate` so the encoder sheds RESOLUTION per-frame on a scene change; screen+detail ⇒ `maintain-resolution`; camera ⇒ `balanced`), and biases a constrained screen's motion resolution down a tier (`MOTION_RES_BIAS`). Bitrate-only back-off does NOT relieve a CPU-bound phone encoder, only dropping resolution/framerate does. Stability mechanism, NOT a freeze fix — don't remove it.
- Group caps are server-enforced (`MaxVoiceAudio`/`MaxVoiceVideo`): over-cap join ⇒ `voice.join_denied{reason:"full"}` (abort); over the video sub-cap ⇒ forced video-muted + `reason:"video_full"` (audio-only). DMs are exempt. `TestVoiceJoinDeniedWhenFull`/`TestVoiceVideoSubCap` guard.
- Per-user volume uses `audio.volume`, not Web Audio GainNode (Chromium no-output bug with WebRTC+WebAudio).
- Teardown is synchronous (`finishTeardown` → `closeAllPeers` before farewell-tone await). `callGen` guards rapid re-join.
- **Screen share is a SECOND video SOURCE on the single video slot, mutually exclusive with the camera** (`setScreenShareEnabled`). Camera↔screen swaps the source on the existing m-line via `replaceTrack` (instant, no reneg); first-enable `addTrack`s and renegotiates. `contentHint="detail"` + `videoScaleForTarget(t, isScreen=true)` (captured at `frameRate:{ideal:30}`) scale on SCREEN-SPECIFIC thresholds (`VIDEO_SCALE_SCREEN_FULL_BPS` 700k / `VIDEO_SCALE_SCREEN_QUARTER_BPS` 350k), more aggressive than the camera's: native res only with real headroom (≥700k), **½** across the broad middle (350–700k), **¼** at the floor (<350k), framerate held at 30. A shared screen is high-res (1080p+), so holding native res on a constrained link emits frames too big to drain — the ~0.5s-smooth/~0.5s-stall pacing oscillation (telemetry: `out.v.res` pinned full, `out.v.fps` swinging 5↔21 under 13–40% loss). So a screen steps resolution DOWN willingly rather than starving the pipe (crisp-but-laggy is worse than soft-but-fluid — the *opposite* of the old "hold res, shed fps" rule, which was wrong here). The AIMD target (loss/RTT + CPU-bound encoder) is what drops us, so res only gives once the controller judges the link can't carry it. **`detectScreenMotion`** (hysteretic latch — static screen ~0–2 fps, video ~24+) flips `contentHint="motion"` on a sustained-high reading and keeps 30 fps even at the ¼ floor (a static doc eases to 24 there), reverting on quiet. The latch is global (one shared source) and reset wherever `videoIsScreen` flips. `e2e/screen-share` asserts the switch via the local track's `contentHint`. `track.onended` catches the browser's native "Stop sharing" bar and flips to video-off.
- Screen VIDEO parks its sender on stop (`replaceTrack(null)`, reused via `idleVideoSender`). **`idleVideoSender` must only match a transceiver already negotiated to SEND (`currentDirection` sendrecv/sendonly), never a recvonly RECEIVE slot** — else whoever turns their camera on SECOND in a 2-way call reuses the receive slot and silently never offers (the 2.0.0 regression). `dm-call`'s sequential-camera spec guards it.
- Screen AUDIO (Chrome tab/system audio) is `addTrack`ed INTO the mic's `localStream` so the remote groups both by msid and plays them through its one per-peer `<audio>`; it rides its OWN m-line, so muting the mic never silences it. Teardown FULLY removes it (`pc.removeTrack`, NOT park) — audio has no `video_muted`-style gate, so a parked-but-lingering track would still be heard. `web/e2e/screen-share` pins share→receive→camera-swap→teardown.

**Reactions**
- `message.update` that omits `reactions` must PRESERVE existing ones (`addMessage` guards this).
- `toggleReaction` takes the pill's known `mine` — do NOT regress to a `findMessage` lookup.

**Message-pane rendering**
- Realtime event repaints batch through `scheduleRender(...surfaces)` — one paint per task on a `setTimeout(0)`, **never `requestAnimationFrame`**: rAF is paused in a hidden tab, but the unread count in the document title must keep climbing while backgrounded. The synchronous load/jump/scroll paths (`loadChannel`/`jumpToMessage`/`resync`/`selectChannel`) bypass it and call the render fns directly (they measure scroll right after painting).
- `message.new` at the live tail appends ONE row (`appendMessageRow`); `reaction.update`/`message.update` swap the single touched row (`patchMessageRow`). Full `renderMessages()` (innerHTML wipe + rebuild) stays the source of truth for channel-open/jump/resync and the fallback when a row can't be patched (delete/system/secret/history/scrolled-up). The fast paths exist so a reader's text selection, in-flight images, and scroll survive live traffic — don't route live events back through the full render.
- `read.update` (including the self-echo from your own mark-read) and `markActiveChannelRead` must **NOT** full-render — they call `refreshReadMarks()` (👁 titles only). A full render there wipes the selection on every incoming message; the unread divider is local session state a remote read doesn't move. Guarded by `web/e2e/live-append.spec.js`.
- Sending is **optimistic**: `showOptimisticSend` paints a dimmed `pending` row (NEGATIVE temp id — can't collide with a server id) at the live tail before the POST; the message.new echo reconciles it via `reconcileOptimistic`, matched by `(channel, exact content)` because the server round-trips no client nonce (don't "simplify" the match to id — there is no shared id until the echo). A failed POST rolls it back (`removePending`) and restores the composer; a channel switch drops tracked rows (`clearPendingSends`). Optimistic only at the live tail — a history window / secret view keep their reload / secret paths. Guarded by `web/e2e/optimistic-send.spec.js`.
- **A pending optimistic row lives in the DOM but NOT in `state.messages`**, so the DOM tail can disagree with array order. Both `appendMessageRow` and `reconcileOptimistic` therefore drop a real row at its array-sorted DOM slot via `insertionPointFor` (above any `.msg.pending` tail), NOT blindly before the bottom sentinel — otherwise a cross-user `message.new` arriving mid-send lands BELOW your pending row and groups avatarless under it, mis-attributing their message to you (and the echo reconciles out of order). Grouping is computed off `state.messages`, so DOM order MUST mirror it. Guarded by `web/e2e/optimistic-send.spec.js` (the cross-user-mid-send case).

**Typing indicator**
- Client-side TTL is the source of truth for "is this user still typing", NOT frame delivery. `state.typing[ch][uid]` stores the typer's last-refresh **timestamp** (not bare `true`); `activeTypers(state, ch, now, ttl)` drops anything older than `TYPING_TTL_MS` (4000ms, comfortably above the 1500ms `TYPING_INTERVAL_MS` re-emit). This is the fix for a phantom typer left when a receiver misses the server's `active:false` frame (socket drop / backgrounded tab) — don't regress the storage to a boolean or remove the TTL. `setTyping` takes an injectable `now` so the pure logic is unit-tested (`state.test.js`).
- `renderTypingIndicator` arms a one-shot timer (`typingExpiryTimer`) to repaint when the soonest live entry ages out, so the indicator clears with **no** further events. Arm only for live entries — a lingering stale entry must not spin an endless timer. `message.new` clears the sender's entry in `applyEvent` (instant, not after the TTL); `presence.update` with `online:false` sweeps the user everywhere via `clearTypingForUser` (no `active:false` ever arrives for a disconnected peer). No server change / no new protocol field backs any of this. `web/e2e/typing.spec.js` pins the TTL + message.new clears by routing the receiver's WS to DROP the `active:false` frame (reproducing the missed-frame condition); the pure TTL/clear logic is unit-tested in `state.test.js`.

**Web Push**
- JWT signature is JOSE raw `r||s` (64 bytes), **never DER** — `SignASN1` silently breaks all pushes.
- `aud` recomputed per endpoint (scheme://host) — cached global `aud` rejected by Mozilla/Apple.
- Push only to disconnected users. Runs in goroutine — must never slow message send.

**Secret chat**
- Offerer = lower user_id. Sessions in JS memory only — never persisted.
- No fallback to weaker crypto primitives — ever.
- Server relays `secret.*` WS frames opaque, same DM-membership validation as voice.
- UI/UX lives in `secretui.js` (banner, 🔒 button, safety modal); `secret.js` owns the
  crypto/session state. Identity key is published at boot (idempotent) so any peer can be
  offered a session — an offer needs the peer's key already published. `web/e2e/secret-chat`
  pins offer→accept→matching safety number across two browsers.

**Uploads / blobs**
- Content type sniffed with `http.DetectContentType`, never trusts header.
- Hash is 64-char lowercase hex; validated before use (path-traversal immunity).
- Writes are atomic (tmp + rename). Same bytes → same hash → one file (idempotent).

**Invitations vs magic links**
- `invitations` table is distinct from `magic_links`. Don't merge them.
- Account creation + invitation consumption are one transaction (`store.RedeemInvitation`).

**Link preview proxy: allowlist-only.** No *arbitrary-URL* server-side fetch — the proxy
(`preview.go`, route `GET /api/link-preview`) fetches OG tags (Wikipedia via its summary
API) only for hostnames on the allowlist: a hardcoded default set in `config.go`
(github/wikipedia/major news orgs), overridable via `RIVENDELL_LINK_PREVIEW_DOMAINS`;
`domainAllowed` matches subdomains too. A non-allowlisted or cache-errored URL gets a bare
`404` (`http.NotFound`, no JSON — the allowlist isn't leaked), which `api.getLinkPreview`
maps to a "no card" marker without throwing. An empty allowlist disables the feature.
YouTube + message-permalink embeds are client-side only and were intentionally kept.
SSRF hardening (`newPreviewClient`): the outbound fetch client refuses to dial any
non-public IP (loopback/RFC1918/ULA/link-local incl. the 169.254.169.254 metadata
endpoint) via a `net.Dialer.Control` hook — vetting the resolved IP at connect time, so
DNS rebinding can't bypass it — AND re-applies the https + `domainAllowed` checks on
**every** redirect hop, not just the entry URL, so an allowlisted host's open redirect
can't pivot the fetch off-allowlist or inward. The allowlist alone is enforced once, at
the door; these two guards keep it true end-to-end. Guarded by `TestIsPublicIP`,
`TestCheckPreviewRedirect`, `TestPreviewClientRefusesInternal`.
