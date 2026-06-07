# Bridge DM update — self-note (delete after deploy confirmed)

## What changed in scripts/claude-bridge

Refactored the main channel-polling logic into a `handle_channel(channel_id, mode)`
function that supports two modes:

**normal** (the existing #claude channel):
- Runs `claude --print` in `$REPO_DIR` with the full `BRIDGE_PREAMBLE`
- State file: `$STATE_DIR/rivendell-bridge-lastid` (unchanged)

**dm** (any `is_dm=true` channel the bot is a member of):
- Runs `claude --print --effort low --disallowed-tools "Edit Write Bash"` in `/tmp`
  - `--effort low` → fastest response
  - `--disallowed-tools "Edit Write Bash"` → no write access to the repo
  - `cd /tmp` → no repo context loaded, no CLAUDE.md picked up
- No `BRIDGE_PREAMBLE` (that text is repo-specific and irrelevant in DMs)
- State file: `$STATE_DIR/rivendell-bridge-dm-<channel_id>` (one per DM)

The main loop now discovers DM channels dynamically each poll cycle via
`GET /api/channels` filtered to `is_dm == true`, so new DM conversations are
picked up automatically without a restart. Cursor seeding (skip replay on first
encounter) works the same way as the main channel.
