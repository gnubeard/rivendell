// history.js — the message pane's history/paging + scroll-geometry sub-system.
//
// The blessed message-pane carve (docs/decomposition.md, "Message pane — NOT a
// single lift"): a self-contained sub-system with a clean seam. It owns the
// back/forward paging state machine (the loading guards, the history-window
// flags, the IntersectionObserver sentinels) behind a createHistoryPaging(deps)
// factory, plus the pure-ish scroll-geometry helpers as free exports.
//
// The channel-open / jump orchestrators (loadChannel, jumpToMessage) stay in
// app.js — they're app-shell work (header, affordances, member refresh) — and
// drive this module through its accessors rather than poking its flags directly.
//
// The pure export (isNearBottom) is unit-tested in web/test/history.test.js; the
// stateful paging + DOM scroll behaviour is covered by web/e2e/history.spec.js.

// PAGE is the message page size: how many messages each fetch (initial load and
// every older/newer page) pulls, and the "< PAGE means we hit the end" sentinel.
export const PAGE = 50;

// Distance-from-bottom (px) within which the reader counts as "pinned to the live
// tail" — the threshold that decides whether a new message auto-follows or holds
// position. The single source of truth so every scroll-geometry check (viewport
// resize, incoming message, re-render) agrees on what "at the bottom" means.
export const NEAR_BOTTOM_PX = 80;

// isNearBottom reports whether a scroll container is within `threshold` px of its
// bottom — i.e. the reader is pinned to the live tail. Pure: takes the three
// geometry numbers so it's testable without a DOM (callers pass el.scrollHeight,
// el.scrollTop, el.clientHeight). The boundary is exclusive on the far side:
// exactly `threshold` away counts as scrolled up, matching the prior inline `<`.
export function isNearBottom(scrollHeight, scrollTop, clientHeight, threshold = NEAR_BOTTOM_PX) {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

// scrollToBottom pins the message list to the newest message. It re-pins across
// the next couple of frames because layout can keep settling after the first
// assignment — text wrapping, and on mobile the visual viewport / URL bar — which
// would otherwise leave the view a few pixels short of the bottom.
export function scrollToBottom(wrap) {
  wrap.scrollTop = wrap.scrollHeight;
  requestAnimationFrame(() => {
    wrap.scrollTop = wrap.scrollHeight;
    requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
  });
  // Images load asynchronously and expand the container after the rAF pass.
  // Re-pin when each one finishes, but only if the reader hasn't manually
  // scrolled away since we pinned.
  // We capture the target scrollTop now (= scrollHeight − clientHeight, the max
  // possible value). After the pin, wrap.scrollTop == targetTop. When the image
  // loads, wrap.scrollHeight grows but scrollTop stays put — so checking
  // "scrollTop is still near targetTop" reliably tells us whether the user
  // scrolled away (vs. checking distance-from-new-bottom, which would be the
  // image height and could easily exceed any fixed pixel threshold).
  const targetTop = wrap.scrollHeight - wrap.clientHeight;
  wrap.querySelectorAll("img").forEach(media => {
    if (media.complete) return;
    media.addEventListener("load", () => {
      if (!wrap.contains(media)) return; // image is from a prior channel render
      if (wrap.scrollTop >= targetTop - 5)
        wrap.scrollTop = wrap.scrollHeight;
    }, { once: true });
  });
}

// createHistoryPaging wires the paging state machine to the app. Deps:
//   getState        — () => state (read fresh; state is reassigned on every update)
//   setState        — (state) => void (the module splices pages in via S.* reducers)
//   api             — for api.messages(cid, { before|after, limit })
//   S               — state.js reducers (oldest/newestMessageId, pre/appendMessages)
//   renderMessages  — (forceBottom, holdPosition) => void, app.js's message-pane render
//   messageList     — () => the #message-list scroll container element
//
// The flags (loadingOlder/Newer, historyComplete, viewingHistory) and the
// IntersectionObserver are closure-encapsulated; the orchestrators in app.js reach
// them only through the returned accessors (the decomposition spine's rule).
export function createHistoryPaging({ getState, setState, api, S, renderMessages, messageList }) {
  let loadingOlder = false;            // guards overlapping back-paging fetches
  let loadingNewer = false;            // guards overlapping forward-paging fetches
  const historyComplete = new Set();   // channelIds whose oldest message is loaded
  const viewingHistory = new Set();    // channelIds whose loaded bottom isn't the live tail
  let scrollObserver = null;

  // loadOlderMessages fetches the previous page when the user scrolls near the top
  // and splices it in, preserving the scroll position so the view doesn't jump.
  async function loadOlderMessages() {
    const cid = getState().activeChannelId;
    if (!cid || loadingOlder || historyComplete.has(cid)) return;
    const oldest = S.oldestMessageId(getState(), cid);
    if (oldest == null) return;
    loadingOlder = true;
    const wrap = messageList();
    const prevHeight = wrap.scrollHeight;
    const prevTop = wrap.scrollTop;
    try {
      const older = await api.messages(cid, { before: oldest, limit: PAGE });
      if (older.length < PAGE) historyComplete.add(cid); // reached the beginning
      if (older.length && cid === getState().activeChannelId) {
        setState(S.prependMessages(getState(), cid, older));
        renderMessages();
        // Keep the message that was under the viewport in place: the prepended
        // content grew the list above us by exactly this delta.
        wrap.scrollTop = prevTop + (wrap.scrollHeight - prevHeight);
      } else if (older.length) {
        // User switched channels mid-fetch; merge quietly, no re-render.
        setState(S.prependMessages(getState(), cid, older));
      }
    } catch (ex) {
      console.warn("rivendell: could not load older messages:", ex && ex.message);
    } finally {
      loadingOlder = false;
    }
  }

  // loadNewerMessages is the forward counterpart to loadOlderMessages: when the
  // user scrolls near the bottom while viewing a history window (below the live
  // tail), it fetches the next page forward and appends it. A short page means
  // we've caught up to the newest message — drop the history flag so normal
  // live-follow resumes.
  async function loadNewerMessages() {
    const cid = getState().activeChannelId;
    if (!cid || loadingNewer || !viewingHistory.has(cid)) return;
    const newest = S.newestMessageId(getState(), cid);
    if (newest == null) return;
    loadingNewer = true;
    try {
      const newer = await api.messages(cid, { after: newest, limit: PAGE });
      if (newer.length < PAGE) viewingHistory.delete(cid); // caught up to the live tail
      if (newer.length && cid === getState().activeChannelId) {
        // Hold position: the new messages land below the viewport, so the reader
        // stays put and scrolls down into them (rather than being snapped to the
        // new bottom, which on mobile left no room to trigger the next page).
        setState(S.appendMessages(getState(), cid, newer));
        renderMessages(false, true);
      }
      if (cid === getState().activeChannelId) renderHistoryBanner();
    } catch (ex) {
      console.warn("rivendell: could not load newer messages:", ex && ex.message);
    } finally {
      loadingNewer = false;
    }
  }

  // renderHistoryBanner shows the "you're viewing history" banner whenever the
  // active channel's loaded bottom isn't the live tail.
  function renderHistoryBanner() {
    const banner = document.getElementById("history-banner");
    if (!banner) return;
    banner.hidden = !viewingHistory.has(getState().activeChannelId);
  }

  // Infinite scroll is driven by two zero-height sentinels that renderMessages
  // places at the very top and bottom of the list. When a sentinel nears the
  // viewport the matching page loads. We use an IntersectionObserver rather than
  // scrollTop math because the latter fired unreliably on mobile (momentum
  // scrolling and the dynamic viewport) and could strand the reader at the end so
  // the next forward page never loaded. rootMargin "100%" prefetches ~a screen
  // early in both directions, so reading in either direction stays seamless.
  function observeScrollSentinels(topSentinel, bottomSentinel) {
    if (!scrollObserver) {
      scrollObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (e.target.dataset.sentinel === "top") loadOlderMessages();
          else loadNewerMessages();
        }
      }, { root: messageList(), rootMargin: "100% 0px" });
    }
    // Sentinels are fresh nodes each render (innerHTML is cleared), so rebind.
    scrollObserver.disconnect();
    scrollObserver.observe(topSentinel);
    scrollObserver.observe(bottomSentinel);
  }

  // --- accessors for the app.js orchestrators (loadChannel / jumpToMessage) -----

  // resetForChannel clears the paging guards + history window on channel open, so
  // stale in-flight state can't leak across a switch (sentinels are reset too).
  function resetForChannel(id) {
    loadingOlder = false;
    loadingNewer = false;
    viewingHistory.delete(id);
  }

  // noteLoadedPage records, from a channel's first page length, whether its oldest
  // message is already loaded (a short page means there's nothing older).
  function noteLoadedPage(id, pageLen) {
    if (pageLen < PAGE) historyComplete.add(id);
    else historyComplete.delete(id);
  }

  // jumpToMessage lands on an around-window, so the oldest isn't known (clear the
  // complete flag) and the live tail may be missing (flag a history window).
  function clearHistoryComplete(id) { historyComplete.delete(id); }
  function markViewingHistory(id) { viewingHistory.add(id); }
  function isViewingHistory(id) { return viewingHistory.has(id); }

  return {
    loadOlderMessages, loadNewerMessages, observeScrollSentinels, renderHistoryBanner,
    resetForChannel, noteLoadedPage, clearHistoryComplete, markViewingHistory, isViewingHistory,
  };
}
