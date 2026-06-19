// linkpreview.js — inline link/embed previews under a message. One bare URL per
// message gets a card, chosen in priority order by buildLinkPreview:
//   1. a same-origin message permalink  → .msg-embed   (fetched via api.getMessage)
//   2. a YouTube URL                    → .yt-thumb     (pure client-side, no fetch)
//   3. any other allowlisted bare URL   → .link-preview (og: card via api.getLinkPreview)
//
// This is a DOM-carrying feature module (the search.js method): it owns its two
// fetch caches and the debounce that coalesces their completions into one
// re-render, renders its own cards, and wires the embed card's click→navigate.
// It has no extractable pure core (the cache state machine already lives in
// previews.js, unit-tested there), so the net is web/e2e/link-previews.spec.js,
// which pins all three card paths.
//
// Deps: el (element builder), getState (() => state, read fresh — state is
// reassigned on every update), api (getMessage/getLinkPreview), jumpToMessage
// (navigate to an embedded message), rerender (re-render the message list when a
// fetch resolves — the only side effect that reaches back into app.js).

import { formatMessage, extractMessagePermalinkURL, extractYouTubeVideoID, extractFirstBareURL } from "./format.js";
import { formatTime } from "./util.js";
import { createPreviewCache } from "./previews.js";

export function createLinkPreviews({ el, getState, api, jumpToMessage, rerender }) {
  // Preview caches (state machine in previews.js): same-origin message embeds and
  // external og: link cards. Keys move unrequested → loading → resolved/pending/failed.
  const msgPreviews = createPreviewCache();
  const extPreviews = createPreviewCache();

  // Debounce token: multiple preview fetches completing close together collapse
  // into one rerender() call instead of one per URL.
  let _previewRenderTimer = null;
  function schedulePreviewRender() {
    if (_previewRenderTimer) return;
    _previewRenderTimer = setTimeout(() => { _previewRenderTimer = null; rerender(); }, 60);
  }

  // fetchExtPreview requests a link preview for url and triggers a re-render when
  // the result arrives. On 202 (background fetch in progress) it retries once
  // after 2.5 s. Idempotent: a second call while already loading is a no-op.
  async function fetchExtPreview(url) {
    if (!extPreviews.begin(url)) return;
    const data = await api.getLinkPreview(url);
    if (data && data.title) {
      extPreviews.resolve(url, data);
    } else if (data && data._status === 202) {
      extPreviews.pending(url);
      setTimeout(() => { extPreviews.forget(url); schedulePreviewRender(); }, 2500);
      return;
    } else {
      extPreviews.fail(url);
    }
    schedulePreviewRender();
  }

  // renderExtPreviewCard builds an og: link-preview card for an external URL.
  function renderExtPreviewCard(preview, url) {
    const hostname = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    const site = preview.site_name || hostname;
    const card = el("a", {
      class: "link-preview",
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
    });
    card._previewUrl = url;
    const textCol = el("div", { class: "link-preview-text" });
    textCol.append(el("div", { class: "link-preview-site" }, site));
    if (preview.title) textCol.append(el("div", { class: "link-preview-title" }, preview.title));
    if (preview.description) textCol.append(el("div", { class: "link-preview-desc" }, preview.description));
    card.append(textCol);
    if (preview.image_url) {
      const img = el("img", { class: "link-preview-image", src: preview.image_url, alt: "", loading: "lazy" });
      card.append(img);
    }
    return card;
  }

  // fetchMsgPreview fetches a message for an embed preview card and triggers a
  // re-render when done. Idempotent — a second call for an already-cached id is a
  // no-op.
  async function fetchMsgPreview(messageId) {
    if (!msgPreviews.begin(messageId)) return;
    try {
      const msg = await api.getMessage(messageId);
      msgPreviews.resolve(messageId, msg);
    } catch {
      msgPreviews.fail(messageId);
    }
    schedulePreviewRender();
  }

  // renderMsgEmbedCard builds the inline preview card for a same-origin message
  // permalink. Clicking navigates the same way as the message timestamp link.
  function renderMsgEmbedCard(msg, channelId, messageId) {
    const state = getState();
    const author = state.users[msg.user_id];
    const card = el("div", { class: "msg-embed" });
    const head = el("div", { class: "msg-embed-head" });
    head.append(
      el("span", { class: "msg-embed-author" }, author ? author.display_name : "unknown"),
      el("span", { class: "msg-embed-time" }, formatTime(msg.created_at)),
    );
    card.append(head);
    const body = el("div", { class: "msg-embed-body" });
    if (msg.deleted_at) {
      body.append(el("span", { class: "deleted" }, "message deleted"));
    } else {
      // embedImages: true so an uploaded blob in the linked message renders as an
      // actual <img> in the card (not a bare "image" link). The card body is normal
      // block flow now (no line-clamp), so the image sits inline at its natural size.
      body.innerHTML = formatMessage(msg.content, null, state.emojis, { embedImages: true, channels: state.channels, users: state.users });
    }
    card.append(body);
    card.addEventListener("click", (e) => { e.preventDefault(); jumpToMessage(channelId, messageId); });
    return card;
  }

  function renderYouTubeEmbed(videoID) {
    return el("a", {
      class: "yt-thumb",
      href: `https://www.youtube.com/watch?v=${videoID}`,
      target: "_blank",
      rel: "noopener noreferrer",
    },
      el("img", { src: `https://i.ytimg.com/vi/${videoID}/hqdefault.jpg`, alt: "YouTube video", loading: "lazy" }),
      el("span", { class: "yt-play" }, "▶"),
    );
  }

  // buildLinkPreview returns a same-origin message-embed card, a YouTube embed,
  // or an external og: link-preview card for the first matching bare URL in
  // content, or null if there is none / not ready.
  function buildLinkPreview(content) {
    // Same-origin message permalink: render an inline embed card.
    const pl = extractMessagePermalinkURL(content, location.origin);
    if (pl) {
      const out = msgPreviews.outcome(pl.messageId);
      if (out === "fetch") { fetchMsgPreview(pl.messageId); return null; }
      if (out === "wait") return null;
      return renderMsgEmbedCard(msgPreviews.get(pl.messageId), pl.channelId, pl.messageId);
    }

    // YouTube embed is purely client-side — no async fetch needed.
    const ytID = extractYouTubeVideoID(content);
    if (ytID) return renderYouTubeEmbed(ytID);

    // External link preview (og: meta-tag card from allowlisted domains).
    const extURL = extractFirstBareURL(content);
    if (extURL) {
      const out = extPreviews.outcome(extURL);
      if (out === "fetch") { fetchExtPreview(extURL); return null; }
      if (out === "wait") return null;
      return renderExtPreviewCard(extPreviews.get(extURL), extURL);
    }

    return null;
  }

  return { buildLinkPreview };
}
