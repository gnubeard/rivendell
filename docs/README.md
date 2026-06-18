# rivendell documentation

These docs explain how rivendell is built and why. The arrangement puts the
current architecture up front and pulls finished history aside, so the file list
itself is a table of contents.

## Start here

- **[architecture.md](architecture.md)** — how the whole system fits together: the
  single binary, the backend layers, the request/event lifecycle, the frontend
  serving model.
- **[conventions.md](conventions.md)** — the rules for writing code here: the
  zero-dependency directive, naming, and the invariants worth knowing before you
  edit.
- **[testing/](testing/README.md)** — how the project is tested: the test tiers,
  the databases they need, the git hooks that enforce them, and the manual checks.

## Feature design

[**design/**](design/README.md) holds a per-feature design note for every major
subsystem — the durable record of *why* each is wired the way it is, plus its
invariants. The index ([design/README.md](design/README.md)) also covers the
smaller subsystems that don't need a file of their own. The deep dives:

- [design/voice.md](design/voice.md) — voice calling (P2P WebRTC mesh)
- [design/video.md](design/video.md) — camera video, congestion control, screen sharing
- [design/secret-chat.md](design/secret-chat.md) — OTR-style end-to-end encrypted DMs
- [design/web-push.md](design/web-push.md) — offline push notifications
- [design/uploads.md](design/uploads.md) — the content-addressed blob store
- [design/rich-text.md](design/rich-text.md) — live markdown decoration in the composer

## Frontend map

- **[atlas.md](atlas.md)** — a navigation map of `web/static/app.js`, the client
  orchestrator, organized into regions you can browse from the top down.

## History

[**history/**](history/) is the archive: finished efforts and resolved
investigations, kept for the reasoning, not as live work.

- [history/frontend-decomposition.md](history/frontend-decomposition.md) — the
  completed breakup of `app.js` into modules.
- [history/call-drop-investigation.md](history/call-drop-investigation.md) — the
  resolved ~90-second call-drop bug (fixed in v1.3.108).
