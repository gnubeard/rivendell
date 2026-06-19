// attachments.js — the composer's pending-image-upload tray.
//
// Images chosen/pasted/dropped into the composer are staged as tiles in a tray
// above the input (not as cryptic text placeholders), uploaded to /api/uploads
// in the background, and their markdown is appended to the message on send. This
// module owns the pending-uploads list, the tile DOM, and per-channel
// stash/unstash; app.js keeps the composer event wiring (paste/drop/attach +
// the secret-session gate) and the send path, calling in through this API.
//
// A pending upload is { id, objectUrl, status: "uploading"|"done", markdown,
// spoiler }. While anything is still uploading, send is blocked (hasUploading).
//
// DOM-bound; its test net is web/e2e/composer-paste.spec.js. The one piece of
// pure logic, composeMessageBody, is unit-tested in web/test/attachments.test.js.
//
// Every image, whatever channel it arrived by, is run through stripImageFile (see
// exif.js) before upload, so GPS/timestamps never leave the browser. This is the one
// upload choke point, so the strip lives here rather than at each paste/drop handler.

import { stripImageFile } from "./exif.js";

// composeMessageBody joins the typed text and each *done* attachment's image
// markdown (spoiler-wrapped in ||..|| when marked), one per line. Either part
// alone is enough to send; returns "" when there is nothing. Pure.
export function composeMessageBody(text, doneUploads) {
  const parts = [
    text.trim() ? text : "",
    ...doneUploads.map((u) => (u.spoiler ? `||${u.markdown}||` : u.markdown)),
  ].filter(Boolean);
  return parts.join("\n");
}

// createAttachmentTray wires the tray to its dependencies:
//   tray            the #composer-attachments container element
//   el              the app's element-builder helper
//   uploadBlob      (file) => Promise<{url}> — posts to /api/uploads
//   rejectOversized (file) => bool — alerts + returns true if over the limit
//   drafts          the per-channel draft store (stash/unstash use its attachments map)
export function createAttachmentTray({ tray, el, uploadBlob, rejectOversized, drafts }) {
  let pending = [];
  let seq = 0;

  function render() {
    tray.innerHTML = "";
    tray.hidden = pending.length === 0;
    for (const u of pending) {
      const img = el("img", { src: u.objectUrl, alt: "" });
      const cls = "attachment" +
        (u.status === "uploading" ? " uploading" : "") +
        (u.spoiler ? " spoiler-marked" : "");
      const tile = el(
        "div",
        { class: cls, title: u.status === "done" ? "Click to copy image link" : "Uploading…" },
        img,
      );
      if (u.status === "uploading") {
        tile.append(el("div", { class: "attachment-spinner" }));
      } else {
        tile.addEventListener("click", () => copyRef(u, tile));
        const spoilerBtn = el("button", {
          class: "attachment-spoiler-btn" + (u.spoiler ? " active" : ""),
          type: "button",
          title: u.spoiler ? "Remove spoiler" : "Mark as spoiler",
          onclick: (e) => {
            e.stopPropagation();
            u.spoiler = !u.spoiler;
            tile.classList.toggle("spoiler-marked", u.spoiler);
            spoilerBtn.classList.toggle("active", u.spoiler);
            spoilerBtn.title = u.spoiler ? "Remove spoiler" : "Mark as spoiler";
          },
        }, "SPOILER");
        tile.append(
          spoilerBtn,
          el("button", {
            class: "attachment-remove",
            type: "button",
            title: "Remove image",
            "aria-label": "Remove image",
            onclick: (e) => { e.stopPropagation(); remove(u.id); },
          }, "×"),
        );
      }
      tray.append(tile);
    }
  }

  function remove(id) {
    const idx = pending.findIndex((u) => u.id === id);
    if (idx === -1) return;
    const [u] = pending.splice(idx, 1);
    if (u.objectUrl) URL.revokeObjectURL(u.objectUrl);
    render();
  }

  async function copyRef(u, tile) {
    try {
      const text = u.spoiler ? `||${u.markdown}||` : u.markdown;
      await navigator.clipboard.writeText(text);
      tile.classList.add("copied");
      setTimeout(() => tile.classList.remove("copied"), 900);
    } catch { /* clipboard blocked (insecure context); nothing useful to do */ }
  }

  // uploadAndInsert: POST a File and surface it as a tile. The local file is
  // previewed immediately (object URL) so the user sees their image right away;
  // the tile shows a spinner until the upload resolves.
  async function uploadAndInsert(file) {
    if (rejectOversized(file)) return;
    const item = { id: ++seq, objectUrl: URL.createObjectURL(file), status: "uploading", markdown: "", spoiler: false };
    pending.push(item);
    render();
    try {
      const result = await uploadBlob(await stripImageFile(file));
      item.status = "done";
      item.markdown = `![image](${result.url})`;
    } catch (ex) {
      remove(item.id);
      alert("Image upload failed: " + ex.message);
      return;
    }
    render();
  }

  // canvasRecover: a natively-inserted blob: <img> (paste channel 3) can't be
  // read back without the network stack, so round-trip it through a canvas.
  // Lossy (re-encodes to PNG), but observed Gecko behavior only ever inserts
  // data: URIs — this is belt-and-braces for the blob: case.
  function canvasRecover(src) {
    const probe = new Image();
    probe.onload = () => {
      const c = document.createElement("canvas");
      c.width = probe.naturalWidth;
      c.height = probe.naturalHeight;
      c.getContext("2d").drawImage(probe, 0, 0);
      c.toBlob((blob) => {
        if (blob) uploadAndInsert(new File([blob], "pasted.png", { type: blob.type }));
      }, "image/png");
    };
    probe.src = src;
  }

  return {
    uploadAndInsert,
    canvasRecover,
    render,
    // hasUploading: any upload still in flight blocks send (the Enter handler).
    hasUploading: () => pending.some((u) => u.status === "uploading"),
    // doneUploads: the finished tiles, for assembling the outgoing message body.
    doneUploads: () => pending.filter((u) => u.status === "done"),
    // takeAll: hand the caller the staged uploads and clear the tray (on send).
    takeAll() { const sent = pending; pending = []; render(); return sent; },
    // putBack: restore a previously-taken list after a failed send, so it retries.
    putBack(list) { pending = list; render(); },
    // stash/unstash: park the tray's uploads with the channel being left and
    // restore the arrived channel's, so uploads follow their channel not the user.
    stash(cid) { drafts.saveAttachments(cid, pending); pending = []; render(); },
    unstash(cid) { pending = drafts.restoreAttachments(cid); render(); },
  };
}
