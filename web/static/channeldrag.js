// channeldrag.js — moderator drag-to-reorder for the sidebar channel list.
//
// A DOM-carrying feature module: it owns the live drag gesture (mouse press +
// move-threshold, touch long-press, live reordering among siblings by pointer
// midpoint) and persists the dropped order. The order *math* lives in
// channelorder.js (channelReorderPatches, unit-tested); this is the gesture
// controller around it. Behavior is pinned by web/e2e/channel-reorder.spec.js.
//
// deps:
//   $              — querySelector helper (app.js); $(sel) is scoped to document
//   getState       — () => current app state (read at call time; state is reassigned)
//   setChannels(updated) — fold a reordered channel map into app state (optimistic)
//   renderChannels — repaint the sidebar (used to revert a cancelled drag)
//   resync         — full resync (used to revert a failed PATCH)
import { api } from "./api.js";
import { channelReorderPatches } from "./channelorder.js";

// Replaces the old up/down arrow glyphs (too easy to mis-hit). Desktop: press
// and drag a channel row with the mouse. Mobile: long-press to "unstick" the
// row, then drag. A plain click/tap still selects the channel; a vertical
// touch-drag before the long-press fires still scrolls the sidebar.
export function createChannelDrag({ $, getState, setChannels, renderChannels, resync }) {
  const chDrag = {
    active: false,   // a drag is engaged — the row is "unstuck" and following the pointer
    li: null,        // the <li> being dragged
    id: null,        // its channel id
    lpTimer: null,   // touch long-press timer (null once fired/cancelled)
    startX: 0,
    startY: 0,
  };
  let chMousePending = null; // {li, id} captured on mousedown, before the move threshold
  let chMouseHoldTimer = null; // desktop press-and-hold-to-lift timer (null once fired/cancelled)

  // Desktop can engage the drag two ways: move the mouse past a small threshold
  // (a quick click-drag), OR press and hold in place this long — the deliberate
  // "pick it up" gesture. Either way beginDrag lifts the row (pronounced shadow).
  const HOLD_TO_LIFT_MS = 300;

  // beginDrag lifts a row out of the flow so it visibly follows the pointer.
  function beginDrag(li, id) {
    if (chDrag.active) return; // already lifted (move and hold-timer can both fire)
    chDrag.active = true;
    chDrag.li = li;
    chDrag.id = id;
    li.classList.add("dragging");
    document.body.classList.add("ch-dragging");
  }

  // updateDrag relocates the dragged row among its siblings: insert it before the
  // first row whose vertical midpoint is below the pointer, else append to the end.
  function updateDrag(clientY) {
    const li = chDrag.li;
    if (!li) return;
    const list = $("#channel-list");
    let before = null;
    for (const row of list.querySelectorAll(".channel")) {
      if (row === li) continue;
      const r = row.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { before = row; break; }
    }
    if (before) {
      if (before !== li.nextElementSibling) list.insertBefore(li, before);
    } else if (li !== list.lastElementChild) {
      list.append(li);
    }
  }

  // endDrag drops the row. On commit it persists whatever order the DOM now shows;
  // otherwise (cancel) it re-renders from the authoritative state.
  function endDrag(commit) {
    const li = chDrag.li;
    if (li) li.classList.remove("dragging");
    document.body.classList.remove("ch-dragging");
    chDrag.active = false;
    chDrag.li = null;
    chDrag.id = null;
    if (commit) {
      const ids = [...$("#channel-list").querySelectorAll(".channel")]
        .map((row) => Number(row.dataset.chId));
      persistChannelOrder(ids);
    } else {
      renderChannels();
    }
  }

  // persistChannelOrder renormalizes the regular channels to contiguous positions
  // and PATCHes only the ones whose stored position actually changed. Positions
  // default to 0 (channels then sort by name), so the first reorder on a fresh
  // install rewrites several. It optimistically folds the new order into local
  // state so a stray re-render before the channel.update broadcasts arrive can't
  // snap the row back; a failed PATCH reverts via resync().
  function persistChannelOrder(ids) {
    const { patches, updated } = channelReorderPatches(ids, getState().channels);
    if (!patches.length) return;
    setChannels(updated);
    Promise.all(patches.map((p) => api.updateChannel(p.cid, { position: p.idx })))
      .catch((ex) => { alert(ex.message); resync(); });
  }

  // wire attaches the press/long-press drag handlers to a mod's channel row. Touch
  // arms on a long-press (so taps and scrolls are unaffected); mouse arms once the
  // pointer moves past a small threshold (so plain clicks select).
  function wire(li, id) {
    li.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1 || e.target.closest(".ch-controls")) return;
      chDrag.startX = e.touches[0].clientX;
      chDrag.startY = e.touches[0].clientY;
      clearTimeout(chDrag.lpTimer);
      chDrag.lpTimer = setTimeout(() => {
        chDrag.lpTimer = null;
        if (!li.isConnected) return; // re-rendered out from under us
        beginDrag(li, id);
        if (navigator.vibrate) navigator.vibrate(15);
      }, 450);
    }, { passive: true });

    li.addEventListener("touchmove", (e) => {
      if (chDrag.active && chDrag.li === li) {
        e.preventDefault(); // we own the gesture now — suppress sidebar scroll
        updateDrag(e.touches[0].clientY);
        return;
      }
      if (chDrag.lpTimer) {
        const dx = e.touches[0].clientX - chDrag.startX;
        const dy = e.touches[0].clientY - chDrag.startY;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          clearTimeout(chDrag.lpTimer);
          chDrag.lpTimer = null;
        }
      }
    }, { passive: false });

    li.addEventListener("touchend", (e) => {
      clearTimeout(chDrag.lpTimer);
      chDrag.lpTimer = null;
      if (chDrag.active && chDrag.li === li) {
        e.preventDefault(); // suppress the trailing click that would select the row
        endDrag(true);
      }
    }, { passive: false });

    li.addEventListener("touchcancel", () => {
      clearTimeout(chDrag.lpTimer);
      chDrag.lpTimer = null;
      if (chDrag.active && chDrag.li === li) endDrag(false);
    });

    li.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest(".ch-controls")) return;
      chDrag.startX = e.clientX;
      chDrag.startY = e.clientY;
      chMousePending = { li, id };
      // Press-and-hold-to-lift: if the button is still down and hasn't moved past
      // the threshold by now, pick the row up in place (the move path clears this).
      clearTimeout(chMouseHoldTimer);
      chMouseHoldTimer = setTimeout(() => {
        chMouseHoldTimer = null;
        if (!chMousePending || !chMousePending.li.isConnected) return;
        beginDrag(chMousePending.li, chMousePending.id);
      }, HOLD_TO_LIFT_MS);
      document.addEventListener("mousemove", onChMouseMove);
      document.addEventListener("mouseup", onChMouseUp);
    });
  }

  function onChMouseMove(e) {
    if (chDrag.active) {
      updateDrag(e.clientY);
      return;
    }
    if (!chMousePending) return;
    if (Math.abs(e.clientX - chDrag.startX) > 5 || Math.abs(e.clientY - chDrag.startY) > 5) {
      clearTimeout(chMouseHoldTimer); // the move won the race — engage now, not on the timer
      chMouseHoldTimer = null;
      if (!chMousePending.li.isConnected) { chMousePending = null; return; }
      beginDrag(chMousePending.li, chMousePending.id);
      updateDrag(e.clientY);
    }
  }

  function onChMouseUp() {
    document.removeEventListener("mousemove", onChMouseMove);
    document.removeEventListener("mouseup", onChMouseUp);
    clearTimeout(chMouseHoldTimer);
    chMouseHoldTimer = null;
    chMousePending = null;
    if (chDrag.active) {
      endDrag(true);
      // Swallow the click that fires after mouseup so the drop doesn't also select.
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", swallow, true), 0);
    }
  }

  // isActive reports whether a drag is in progress, so renderChannels can skip a
  // repaint that would yank the row out from under the pointer.
  return { wire, isActive: () => chDrag.active };
}
