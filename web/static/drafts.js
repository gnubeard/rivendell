// drafts.js — per-channel composer scratch: unsent draft text and pending
// upload tiles, saved when the user leaves a channel and restored on return so
// switching channels doesn't discard work. The DOM (composer field, attachment
// tray render) stays in app.js; this just owns the two maps and the rule for
// what's worth keeping.

export function createDraftStore() {
  const text = new Map(); // channelId -> unsent composer text
  const attachments = new Map(); // channelId -> pending upload tiles

  return {
    // saveText keeps the channel's draft only when it has non-blank content,
    // dropping the entry otherwise so a cleared composer leaves nothing stale
    // behind. The text is stored verbatim (trailing whitespace/newlines the user
    // typed are preserved); the trim is only the keep/drop test.
    saveText(cid, value) {
      if (value && value.trim()) text.set(cid, value);
      else text.delete(cid);
    },
    restoreText(cid) {
      return text.get(cid) || "";
    },

    // saveAttachments mirrors saveText for the pending-upload tray: keep the list
    // while it's non-empty, drop it otherwise.
    saveAttachments(cid, uploads) {
      if (uploads && uploads.length) attachments.set(cid, uploads);
      else attachments.delete(cid);
    },
    restoreAttachments(cid) {
      return attachments.get(cid) || [];
    },
  };
}
