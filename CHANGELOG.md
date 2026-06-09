# Changelog

All user-visible changes to Rivendell are documented here.
Internal-only changes (refactors, tests, tooling, docs) are omitted.

## [Unreleased]

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
