// history.js — the message pane's history/paging + scroll-geometry sub-system.
//
// Phase 1 (this file's first tenants): the pure scroll-anchor decision. The
// stateful paging machine (older/newer paging, the history-window flags, the
// IntersectionObserver sentinels) carves in here next, behind a createX(deps)
// factory — see docs/decomposition.md, "Message pane — NOT a single lift".
//
// Pure exports are unit-tested in web/test/history.test.js.

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
