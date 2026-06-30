# Changelog

All user-visible changes to rivendell are documented here.
Internal-only changes (refactors, tests, tooling, docs) are omitted.

## [Unreleased]

## [2.1.17] - 2026-06-30

### Changed
- Desktop screen sharing now streams at a much higher resolution and stays sharp. Screen shares get their own, far more generous bitrate budget (up to ~2.5 Mbps vs. the old 800 kbps that was sized for phone-camera video), a resolution ladder that actually holds native resolution across a broad range instead of pinning a soft half-resolution, the VP9 codec (markedly sharper text/UI at the same bitrate), and bandwidth tuning that no longer mistakes a busy encoder for a failing network. Camera/phone video calls are unchanged.

### Added
- When someone shares their screen with audio (e.g. a tab or game), you can now set the volume of that shared audio independently from their voice — a separate "stream volume" slider appears for them in the members panel and the DM header while they're sharing, so you can quiet a loud video without turning down the person.

## [2.1.16] - 2026-06-30

### Fixed
- Pressing Delete (forward-delete) in the message composer no longer drags the cursor one position to the left. The rich-text layer was applying the character-count change as if the deletion happened before the caret; now a forward delete (and word-delete-forward) correctly keeps the caret in place.

## [2.1.15] - 2026-06-29

### Added
- Bluesky (`bsky.app`) is now on the default link-preview allowlist, so Bluesky links render og: preview cards out of the box.

## [2.1.14] - 2026-06-27

### Changed
- Disabled (banned) accounts are now hidden from the member roster for everyone, including admins. A disabled user is logged out and can't connect, so a lingering roster row only misled — admins still manage them in the admin panel, which lists every account regardless.

## [2.0.23] - 2026-06-17

### Fixed
- When you were scrolled to the bottom of a channel and a reaction was added to the latest message, the new row of reaction pills could nudge the view up a few pixels off the bottom. The message pane now stays pinned to the bottom across reaction repaints.

## [2.0.21] - 2026-06-17

### Fixed
- Another person's message could occasionally render directly beneath your own without an avatar or name — making it look like you'd sent it — if it arrived in the brief window while one of your own messages was still sending. Incoming messages now always slot above your in-flight (pending) message, so they're attributed to their real author.

## [2.0.9] - 2026-06-16

### Fixed
- Adding a custom emoji no longer shows a spurious "refreshEmojiManager is not defined" error in the manager modal. The upload always succeeded, but a dangling internal call left over from the admin/emoji refactor threw afterward and the modal didn't re-render the list right away.

## [2.0.8] - 2026-06-16

### Fixed
- A trailing period (or run of periods) at the end of an auto-linked URL is no longer swallowed into the link — "see example.com/page." now links just the URL and leaves the period as text. Explicit `[text](url)` links are left exactly as written.

## [2.0.7] - 2026-06-16

### Fixed
- Quiet-but-alive realtime connections are no longer dropped after 90s. The server now counts the browser's keep-alive ping/pong traffic toward liveness, not just data messages, so a connection that's idle of chat activity stays up.
- On reconnect, if you were scrolled up reading older messages, the resync no longer yanks you to the bottom — your place in the scrollback is preserved.

## [2.0.6] - 2026-06-16

### Fixed
- The profile editor no longer leaves a couple pixels of dead scroll past Save on mid-height phones.
- Clicking a #channel link inside the pinned-messages (or search) panel now closes that panel when it navigates you to the channel.

## [2.0.5] - 2026-06-16

### Fixed
- The profile editor no longer scrolls past the Save button. An empty error placeholder was reserving dead space below it.

## [2.0.4] - 2026-06-16

### Changed
- Removed the redundant "Edit profile" header from the profile editor; the fields make its purpose clear.

## [2.0.3] - 2026-06-15

### Changed
- Opening your profile on a touch device no longer immediately focuses the display-name field, so the on-screen keyboard no longer pops up before you've had a chance to look.

## [2.0.2] - 2026-06-15

### Fixed
- Incoming-call notifications and the ring banner now always name the caller instead of sometimes saying "Someone" (the caller's name now travels with the ring).
- Tapping a notification is more reliable at bringing the app to the front, especially on Firefox for Android.

## [2.0.1] - 2026-06-15

### Fixed
- Audio from a shared screen (a tab or system audio captured alongside the share) is now actually heard by everyone — previously only your microphone came through.

### Changed
- Shared screens get more frame rate back, so scrolling, video, and demos look smoother while still keeping text sharp.
- In a group call you no longer take up a tile for your own avatar while your camera is off.

### Added
- **Spotlight view in group calls.** A new control enlarges one stream with the rest as a filmstrip; it follows whoever's talking (and a shared screen takes priority), or click a tile to pin it.
- **Listen-only calls.** If your microphone is missing or blocked, you can still join a call to hear and see everyone instead of being shut out — the call shows you're listen-only.

## [2.0.0] - 2026-06-15

### Added
- **Screen sharing.** In a call, a desktop 🖥️ button shares your screen as an alternative to your camera (one or the other). On Chrome you can include the shared tab or system audio, so a video you're playing comes through for everyone — and muting your own microphone doesn't silence it. Shared screens are tuned to keep text sharp when the connection gets tight.

## [1.5.19] - 2026-06-15

### Added
- The emoji picker gained search, a recently-used row, and keyboard navigation, plus a dedicated top panel on mobile.

## [1.5.18] - 2026-06-15

### Added
- The composer now shows markdown formatting live as you type — **bold**, *italic*, `code`, ~~strikethrough~~, and spoilers render in place, with the markers kept but dimmed. Ctrl/Cmd-B and Ctrl/Cmd-I wrap the selection.

## [1.5.17] - 2026-06-15

### Fixed
- Voice and video calls handle Safari's media context more gracefully, with clearer guidance when the microphone or camera can't be reached (notably iOS home-screen apps).

## [1.5.16] - 2026-06-15

### Fixed
- The language label on a fenced code block now stays pinned to the top-right corner when the code is scrolled horizontally, instead of scrolling off with the code.

## [1.5.15] - 2026-06-14

### Changed
- Direct messages with a bot now hide the call (📞) and secret-chat (🔒) buttons, the same way self-DMs already do — bots can't take voice calls or do an end-to-end key exchange, so the buttons were meaningless there.

## [1.5.14] - 2026-06-14

### Added
- Fenced code blocks tagged ` ```diff ` (or ` ```patch `) now syntax-highlight added lines green, removed lines red, hunk headers cyan, and file headers dimmed.

## [1.5.1] - 2026-06-14

### Security
- Link-preview proxy now refuses to connect to non-public IP addresses (loopback, private, link-local including the cloud-metadata endpoint) and re-applies the https + domain allowlist on every redirect hop. Closes a server-side request forgery (SSRF) vector where an allowlisted host could redirect the fetch toward an internal address.

## [1.5.0] - 2026-06-14

### Added
- `nature.com` is now in the default link-preview allowlist, so links to Nature articles render preview cards.

### Fixed
- Mobile long-press message menu: for non-moderator members the sheet stopped rendering partway (a script error at the Pin row), hiding Mark-read/Delete. The full action sheet now renders for everyone.

## [1.4.67] - 2026-06-13

### Fixed
- Link preview description now shows up to 6 lines instead of 2, so full tweet-length text is no longer truncated on narrow mobile screens.

## [1.4.66] - 2026-06-13

### Fixed
- Link preview cards no longer overflow the viewport on narrow mobile screens; the card now shrinks to fit when the screen is narrower than 460px.

## [1.4.61] - 2026-06-12

### Added
- Fenced code blocks now support Perl syntax highlighting (`perl`, `pl`, `pm`).

## [1.4.60] - 2026-06-12

### Added
- Images in background channels are now prefetched after startup. The app walks all channels in sidebar order, warming up to 5 blob images per channel one at a time, so switching channels finds images already cached.

## [1.4.57] - 2026-06-12

### Added
- Image paste now works in the message composer on Firefox for Android (screenshot-copy, browser "Copy image", and Gboard clipboard-history flavors). Pasted images stage as attachments through the same upload path as the attach button.

### Changed
- The message composer is now a `contenteditable` field instead of a `<textarea>` (required for Android image paste delivery). Typing, drafts, @-mention autocomplete, emoji insertion, Enter-to-send, Shift+Enter newlines, and URL-wrap paste behave as before; the field now auto-grows via CSS instead of JS measurement.

### Fixed
- When the other person leaves a secret session, the composer now actually locks and shows "Session ended" until you return to chat. (A selector typo meant this lockout had never taken effect; the field stayed live in an ended session.)

## [1.4.56] - 2026-06-12

### Added
- Animated loading screen (three bouncing dots) shown while the app boots; dismissed once the first channel and its images are fully loaded, so the initial frame is always content-complete rather than a flash of partially-rendered state.

## [1.4.55] - 2026-06-12

### Fixed
- Visiting an expired or invalid invite or magic link now shows a clear error message instead of a blank card with no form.

## [1.4.54] - 2026-06-11

### Fixed
- Self-DM scratch pad no longer shows the call button or the OTR secret-chat button (calling yourself or starting a secret session with yourself is not meaningful).

## [1.4.53] - 2026-06-11

### Added
- Self-DM: you can now open a direct message with yourself as a personal notes/scratchpad space.

### Fixed
- @mentions are only highlighted for real usernames; arbitrary @words (e.g. `@me`, `@everyone`) are left as plain text.

## [1.4.52] - 2026-06-11

### Fixed
- Bold, italic, and strikethrough markers that span across an inline code span (e.g. `**foo \`bar\` baz**`) now render correctly instead of being swallowed.

## [1.4.48] - 2026-06-11

### Fixed
- Re-opening a DM now sorts it to the top of the list even after a page refresh (initial channel load now considers `dm_open.opened_at`, matching the live-update path).

## [1.4.46] - 2026-06-11

### Fixed
- Re-opening an existing DM (one with old or no messages) now places it at the top of the DM list.

## [1.4.44] - 2026-06-11

### Fixed
- Opening or re-opening a DM now places it at the top of the DM list instead of the bottom.

## [1.4.43] - 2026-06-11

### Fixed
- The Leave button is now hidden for admins viewing a private channel they are not a member of.

## [1.4.42] - 2026-06-11

### Fixed
- Leaving a private channel as an admin now immediately hides the Leave button and removes yourself from the member roster, without waiting for the WebSocket round-trip.

## [1.4.41] - 2026-06-11

### Changed
- A private channel with no members left is automatically archived.
- Admins leaving a private channel get no confirmation dialog and the channel remains in their sidebar (admins retain bypass access regardless of membership).

## [1.4.40] - 2026-06-11

### Fixed
- "Mark read" now advances the "New messages" divider to the new cursor position. If the next unread message is already in the viewport, the divider is dismissed entirely.

## [1.4.39] - 2026-06-11

### Fixed
- Message action buttons are more visible on hover: raised resting opacity from 50% to 75% and anchored icon colour to `--text-dim`.

## [1.4.38] - 2026-06-11

### Fixed
- Light mode: message hover strip was invisible (white-on-white) and the action button gradient used wrong colours. Now uses theme-aware CSS variables throughout.

## [1.4.37] - 2026-06-11

### Added
- Channel picker: typing `#` in the composer or edit box now opens an autocomplete picker for channels (like `@` for mentions and `:` for emoji).
- Channel links: `#channelname` in messages renders as a clickable link that navigates directly to that channel when it exists.

## [1.4.36] - 2026-06-11

### Added
- Private notes on user profiles: clicking a user's avatar/name shows a "Notes" textarea where you can jot private reminders about that person — notes are stored server-side, visible only to you, and autosave on blur.

### Changed
- Profile card (user modal): removed the "Profile" heading and the × close button for a cleaner look; dismiss by clicking outside the card or pressing Escape.
- Edit profile modal: removed the × close button; dismiss by clicking outside or pressing Escape.

## [1.4.35] - 2026-06-11

### Fixed
- Secret chat: a malformed or truncated offer/accept frame (missing `eph`, `sig`, `session_nonce`, or peer identity key) now throws a clean error and tears down the pending session instead of letting `atob(undefined)` crash the accept handler as an unhandled promise rejection.

## [1.4.34] - 2026-06-11

### Fixed
- The "manage custom emojis" button (visible to mods/admins) now renders as a footer strip below the emoji picker instead of floating over the bottom-right corner of the grid.

## [1.4.33] - 2026-06-11

### Fixed
- Fixed a race condition where a pending backoff-retry timer could fire after a resume-triggered reconnect, leaving two live WebSocket connections feeding the same event handler — causing notifications (toasts, chimes) to fire twice per message.

## [1.4.32] - 2026-06-11

### Fixed
- Sending a DM now moves that conversation to the top of the DM list, matching the behaviour when receiving a message.

## [1.4.31] - 2026-06-11

### Changed
- Direct messages in the sidebar are now ordered by most recent message, with the conversation you last heard from at the top.

## [1.4.30] - 2026-06-11

### Fixed
- Accepting a voice call or secret chat request now navigates to the DM conversation. If the DM had been closed, it is automatically re-opened so the page renders correctly.

## [1.4.27] - 2026-06-11

### Fixed
- Deactivated users no longer appear in the @-mention autocomplete list.
- Secret chat messages now correctly highlight your own @-mentions and render custom emoji shortcodes.
- Mobile long-press menu now shows the Pin/Unpin action for DM participants (not just mods).

## [1.4.26] - 2026-06-11

### Changed
- Member avatars are now preloaded so they paint instantly when you switch channels, instead of streaming in afterwards.

## [1.4.25] - 2026-06-11

### Fixed
- Quoting a message that contains a table, code block, or list (e.g. when forwarding it) no longer mangles the formatting. Blockquotes now render their contents as real Markdown blocks, so a forwarded table stays a table instead of becoming a wall of `>`-prefixed lines.

## [1.4.24] - 2026-06-11

### Changed
- Forwarding a message now jumps you to the forwarded copy in its target channel instead of leaving you where you were.

## [1.4.23] - 2026-06-11

### Fixed
- Web Push now renews itself when the browser rotates the push endpoint (a `pushsubscriptionchange` handler in the service worker re-registers the new subscription with the server). Previously a rotated endpoint went stale, the server pruned it on the first failed push, and notifications silently stopped until a full page reload — most visible as backgrounded-tab notifications disappearing on Firefox for Android.

## [1.4.21] - 2026-06-10

### Added
- Markdown bullet lists: consecutive lines starting with `* ` or `- ` now render as an unordered list.

## [1.4.20] - 2026-06-10

### Fixed
- Channel title in the header now updates again when switching channels (regressed in 1.4.9, which dropped the header repaint from the channel-load path).

## [1.4.19] - 2026-06-10

### Changed
- Forward picker now has a filter box, hover highlighting on the list, and hides DMs whose other member can't see the message you're forwarding.

### Fixed
- Forwarding a DM message now sends a quoted "*Forwarded:*" copy of its text instead of a permalink (a DM permalink only opens for that DM's two participants, so it was useless to everyone else). Forwarding a channel message is unchanged.

## [1.4.18] - 2026-06-10

### Changed
- Swapped the sign-out icon from ⏻ to 🚪 so it renders consistently on mobile.

## [1.4.17] - 2026-06-10

### Fixed
- "Mark unread" now sticks: a channel you marked unread stays unread (it won't auto-mark read while you're still in it) until you leave and return, at which point it jumps you to the "New messages" marker.

## [1.4.14] - 2026-06-10

### Changed
- Moved sign-out to a ⏻ button in the sidebar header (highlights red on hover); widened the profile modal.

## [1.4.13] - 2026-06-10

### Added
- Holding Shift while selecting an emoji from the picker keeps the picker open, allowing multiple emoji to be inserted or reacted without reopening it.

## [1.4.12] - 2026-06-10

### Fixed
- "New messages" bar now appears immediately when using "Mark unread" on a message in the active channel.
- "New messages" bar now appears when new messages arrive while you are scrolled up in the active channel.

## [1.4.11] - 2026-06-10

### Fixed
- "Mark unread" / "Mark read" action is now available in the mobile long-press context menu.

## [1.4.10] - 2026-06-10

### Fixed
- Selecting a channel with unread messages now correctly scrolls to the first unread message instead of staying pinned to the bottom.
- The "New messages" divider no longer appears when sending a message yourself or while actively watching a channel.

## [1.4.9] - 2026-06-10

### Added
- "New messages" divider line appears in the message list at the point where unread messages begin; clicking a channel with unreads scrolls directly to it.
- Per-message "👁" action button lets you mark any message read or unread, moving your read cursor forward or backward on demand.

## [1.4.8] - 2026-06-10

### Fixed
- @-mention autocomplete no longer suggests users who are already mentioned in the message being composed.

## [1.4.7] - 2026-06-10

### Changed
- Per-message hover actions on desktop (react, reply, forward, edit, pin, delete) are now emoji icon buttons instead of text links, reducing clutter when all six controls are visible.

## [1.4.6] - 2026-06-10

### Fixed
- Typing in the inline message editor no longer causes the message list to scroll — the scroll position is preserved while the edit textarea grows.

## [1.4.5] - 2026-06-10

### Fixed
- Arrow-key navigation in the `@`-mention and `:emoji` autocomplete popups now scrolls the highlighted row into view, so on desktop the selection no longer disappears off the bottom when the list is longer than the visible area.

## [1.4.4] - 2026-06-10

### Added
- The inline message editor now supports `@`-mention and `:emoji` autocomplete, plus a 😀 button to insert custom or Unicode emoji — the same completions the composer offers.

### Fixed
- Long-pressing inside an edit box no longer pops the message context menu, so you can select and copy/paste text while editing on touch devices.

## [1.4.3] - 2026-06-10

### Changed
- Spoiler bars now hide emoji too — both custom and Unicode emoji inside a `||spoiler||` stay obscured until you click, instead of leaking through.
- Reaction hover tooltips now show the emoji's `:shortcode:` alongside who reacted.
- In-app ping toasts wrap to multiple lines (up to four) instead of truncating a longer message to a single line.

### Fixed
- The file-picker "Browse…" button in the custom-emoji dialog is now themed to match the rest of the form instead of rendering as a bare system button.

## [1.4.2] - 2026-06-10

### Changed
- Congestion back-off now also lowers video resolution and frame rate, not just bitrate, so a phone whose encoder can't keep up at full resolution (latency climbing, frame rate collapsing) gets real relief instead of a smeary full-size picture. The sender also reacts to its own encoder being CPU-pinned, and waits for the link to stay healthy before climbing back up — so quality stops oscillating on a marginal connection.

## [1.4.1] - 2026-06-10

### Changed
- Group/voice video now adapts its bitrate to the network: when the link shows packet loss or RTT spikes (common on a phone's uplink), the sender backs off and recovers as conditions clear. This reduces the self-inflicted congestion that was dropping group calls on marginal connections.

## [1.4.0] - 2026-06-10

### Added
- Group voice and video calls: any voice channel now supports more than two people, with an N-tile video gallery and the active speaker highlighted. Turn your camera on with the 🎥 button in any call.
- Calls are capped at 10 participants and 6 simultaneous cameras (configurable via `RIVENDELL_MAX_VOICE_AUDIO` / `RIVENDELL_MAX_VOICE_VIDEO`). Joining a full call tells you it's full; turning a camera on past the video limit keeps you in audio-only.

### Changed
- Outbound video bitrate now shrinks as a call grows, so a phone's uplink isn't saturated in a crowded call (a 1:1 call is unchanged).

## [1.3.129] - 2026-06-10

### Fixed
- Emoji picker and mention/emoji autocomplete popup are now scrollable by touch-drag on mobile; tapping still selects as before

## [1.3.128] - 2026-06-10

### Fixed
- Avatars now cache in the browser for up to a year instead of 60 seconds; avatar URLs carry a `?v=<avatar_updated_at>` version token so the cache is busted immediately when someone changes their photo

## [1.3.127] - 2026-06-10

### Added
- Built-in shortcodes for the common Unicode emoji palette: `:joy:`, `:pray:`, `:fire:`, `:wave:`, `:eyes:`, `:100:`, `:+1:`, `:thumbsdown:`, `:symbolic_heart:`, `:wink:`, `:heart_eyes:`, `:thinking:`, `:tada:`, `:raised_hands:`, `:open_mouth:`, `:cry:`, `:angry:`, `:white_check:` — render as inline glyphs in messages without a custom emoji registry; appear in the colon-autocomplete picker
- Emoticon rendering: `:D` → 😁, `:)` → 🙂, `:(`→ 🙁, `<3` → ❤️ (in message text; not in the picker)
- End-to-end WebRTC test suite (`make test-e2e`, Playwright, dev-only): two real browsers exercise the DM call happy path, mid-call camera renegotiation, simultaneous-camera glare, and both-parties hang-up against a real server

### Changed
- Call signaling now uses the standard WebRTC Perfect Negotiation pattern (lower user_id = impolite, higher = polite), making simultaneous renegotiations — both parties toggling cameras at once, a camera toggle crossing an ICE restart — converge reliably instead of depending on lucky timing
- Call reconnection now reacts to ICE-level connection trouble as well, which Firefox reports earlier (and sometimes exclusively) — dropped connections are detected and repaired sooner; the grace period before acting on a transient "disconnected" was raised from 2 s to 5 s so brief blips (Wi-Fi roam, radio handover) self-heal instead of triggering restart churn
- Outgoing call video is now capped at 800 kbps per recipient, so a burst of motion can't saturate a phone's uplink and degrade the call's audio or stability
- The emoji autocomplete picker no longer opens when typing a colon followed by a capital letter (`:D`, `:Fire`, etc.)

## [1.3.126] - 2026-06-10

Cleanup only: reverted a 13-commit mobile keyboard GIF / image-paste experiment (v1.3.113–v1.3.125) that never converged. No user-visible change from v1.3.112.

## [1.3.108] - 2026-06-09

### Fixed
- Voice/video calls no longer drop at ~90 seconds: the client now sends a keepalive heartbeat every 45 s during a call so the WebSocket read-deadline is reset, and a WS reconnect mid-call now closes stale peer connections for any participant who left while the socket was down

## [1.3.106] - 2026-06-09

### Added
- Mobile long-press menu now includes a "Copy" action to copy message text to the clipboard

## [1.3.105] - 2026-06-09

### Fixed
- DM video call UI and camera now close promptly when the other party hangs up, instead of remaining open with a frozen frame until ICE times out (~30 s). The server now broadcasts an empty `voice.state` alongside `voice.end` as a fallback, the client treats an empty roster as a server-side teardown, and reconnect-resync verifies the call is still live on the server

## [1.3.104] - 2026-06-09

### Added
- DM voice calls now log "Call started" and "Call ended" system messages in the conversation, giving timestamps to track call duration

## [1.3.103] - 2026-06-09

### Fixed
- When someone signs up via an invitation, users already online now see the new account appear immediately — in the member list and as the author of their first message — instead of "unknown user" until the next refresh. The server now broadcasts the new user on signup, like it already did for profile/role changes

## [1.3.101] - 2026-06-09

### Removed
- Link preview cards for external sites (Bluesky, Twitter/X, GitHub, Wikipedia). The server-side scraper behind them was a security liability (server-side fetch of a user-supplied URL — an SSRF surface that followed redirects off the host allowlist) and was already mostly broken from the server's IP (X serves a login wall, Tumblr blocks us, xcancel is flaky). Pasted links now render as ordinary clickable links. **YouTube embeds and links to other messages in this chat are unaffected** — those never made a server-side request

## [1.3.100] - 2026-06-09

### Fixed
- Syntax highlighting of `bash` code blocks no longer hangs on a crafted unterminated double-quoted string (a regex with exponential backtracking — a posted code block could freeze every viewer's tab). The rule is now linear, and as a bonus correctly highlights strings containing a bare `$digit` like `"cost: $5"`, which previously rendered unhighlighted

## [1.3.99] - 2026-06-09

### Removed
- Tumblr link previews. Tumblr now hard-blocks our server's IP at the edge — every request returns an nginx 403 regardless of User-Agent, endpoint (page or oEmbed), or path — so no preview could ever be fetched, cached or not. Rather than keep a special-case crawler User-Agent and allowlist entry for a host that refuses us outright, Tumblr is dropped from the preview allowlist. Other previews (Bluesky, Twitter/X, GitHub, Wikipedia) are unaffected

## [1.3.98] - 2026-06-09

### Fixed
- Mobile: the message composer no longer ends up "crushed" to a thin sliver after a video call. While a call hides the composer (`display:none`), the textarea autosize could read a zero height and pin the box to nothing; sizing now skips a hidden composer, and the box is re-sized when it reappears as the call ends

## [1.3.97] - 2026-06-09

### Fixed
- Tumblr link previews (again): Tumblr serves OpenGraph-tagged HTML only to a *recognized* social-crawler client and hands a real browser a tag-less consent/JS shell. The previous fix sent a browser User-Agent, which landed on exactly that empty shell — so the preview never rendered. The scrape now identifies as a known unfurl crawler (facebookexternalhit) for Tumblr hosts, the variant Tumblr serves its og:* tags to

## [1.3.96] - 2026-06-09

### Fixed
- Signup validation errors (bad username, too-short password, mismatched passwords) now stay on screen. The form previously deferred to the browser's native HTML5 validation, which flashed a transient bubble and pre-empted our own descriptive in-page message; the form now routes every case through its own handler so the error persists until you fix it

## [1.3.95] - 2026-06-08

### Changed
- Channel reordering (moderators+) is now drag-and-drop. On desktop, press and drag a channel up or down; on mobile, long-press a channel to "unstick" it, then drag. The cramped ↑/↓ arrow glyphs — too easy to hit by accident — are gone. A plain click/tap still selects a channel, and a vertical swipe still scrolls the sidebar

## [1.3.94] - 2026-06-08

### Fixed
- Wikipedia link previews now show the article summary and lead image again. The Wikimedia REST API was rejecting our requests (its User-Agent policy blocks generic/browser-spoofing agents), so only the page title scraped through; the summary call now sends a policy-compliant User-Agent that identifies the app
- Tumblr link previews render again: the scrape now presents a real-browser User-Agent, so Tumblr's WAF serves the OpenGraph-bearing HTML instead of a challenge shell with no metadata

## [1.3.93] - 2026-06-08

### Fixed
- Tumblr link previews work again: the scraper now reads the page through the end of its `<head>` rather than a fixed byte prefix, so Tumblr's OpenGraph tags (buried under hundreds of KiB of inline state, past the previous 512 KiB limit) are found

## [1.3.92] - 2026-06-08

### Fixed
- The message composer no longer jiggles the text by a pixel or two as the cursor moves — including on single-line drafts (the auto-grown height now accounts for the textarea border)
- Wikipedia link previews now include the article summary and lead image (fetched from Wikipedia's REST summary API, since article pages carry no OpenGraph description)
- Tumblr link previews now work (the scraper reads enough of the page to reach Tumblr's OpenGraph tags, which sit past the previous read limit)

## [1.3.91] - 2026-06-08

### Added
- Markdown-style tables now render in messages (GFM syntax: a header row, a `---` delimiter row, then body rows; `:` in the delimiter sets per-column alignment)

### Fixed
- The message composer no longer jiggles the text by a pixel or two when the cursor reaches the top or bottom of a multi-line draft

## [1.3.90] - 2026-06-08

### Added
- Link previews now also work for GitHub, Wikipedia (all language subdomains), and Tumblr (all blog subdomains)

## [1.3.89] - 2026-06-08

### Added
- Keyboard shortcuts for the conversation list: Ctrl+Up/Down move through channels and DMs; Ctrl+Shift+Up/Down jump to the nearest unread conversation above/below

### Changed
- The Custom Emojis manager is wider on desktop so the add-emoji row and emoji grid aren't cramped

## [1.3.88] - 2026-06-08

### Added
- Moderators and admins can now manage custom emojis directly from a ➕ in the emoji picker, which opens the same Custom Emojis manager available in the admin panel

## [1.3.87] - 2026-06-08

### Added
- Oversized image and avatar uploads are now rejected client-side with a clear message before the upload starts, instead of failing after the bytes are sent

## [1.3.86] - 2026-06-08

### Changed
- In-app ping toasts now appear only on mobile; on desktop they are suppressed (the message is already on screen or a click away)

## [1.3.85] - 2026-06-08

### Changed
- Moderators can no longer see private channels they are not members of; only admins retain the bypass to access all non-DM private channels

## [1.3.84] - 2026-06-08

### Changed
- Ping toasts are larger and use a high-visibility amber background for better noticeability

## [1.3.83] - 2026-06-08

### Added
- In-app ping toast: when a DM, @-mention, or reply arrives while the tab is focused (OS notifications are suppressed), a brief banner slides in from the top of the screen and auto-dismisses after 4 seconds; tapping it navigates to the channel. Works correctly when the admin panel is open.

## [1.3.82] - 2026-06-08

### Fixed
- Uploaded images that haven't been sent yet now stay with their channel draft instead of following the user to other channels.

## [1.3.81] - 2026-06-08

### Added
- Release notes posted by the claude-bridge bot are now automatically pinned in the release channel.

## [1.3.80] - 2026-06-08

### Fixed
- Mobile long-press "React" now correctly opens the emoji picker; previously the picker appeared and was immediately dismissed by the global outside-click handler.

## [1.3.79] - 2026-06-08

### Added
- Message forwarding: desktop hover actions now include a "forward" button that opens a channel picker and sends the message as a permalink embed to the chosen channel.
- Mobile long-press context menu: on touch devices, message hover actions are hidden; a long-press on any message opens a bottom sheet with react, reply, forward, edit, pin/unpin, delete, and a reactions panel showing who reacted with what.
- Reaction pill tooltips on desktop now show the emoji name followed by the list of reactors (e.g. "🤔: Elrond, Emily" or "working: Dan, Rob").

## [1.3.78] - 2026-06-08

Changelog started at this version.
