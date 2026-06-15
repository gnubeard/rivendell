// videogrid.js — the in-call video grid (#video-grid). Paints the live call's
// tiles for the active channel: the 2-tile phone layout for DMs (remote tile +
// local PiP) and the N-tile gallery for group voice channels, plus the show/hide
// teardown, the corner ⛶ fullscreen control, and the body.video-active takeover
// of the conversation pane.
//
// What it owns: building/showing/hiding #video-grid and toggling body.video-active.
// What stays in app.js: ownership of videoViewHidden (header label, channel
// selection, and call lifecycle all read/write it directly — the grid only gets a
// get/set pair), the call strip (renderCallStrip reads the PTT flags and is more
// coupled), and the speaking-ring live toggle in onSpeaking (it mutates a tile's
// .speaking class without repainting). The grid reads `speakingIds` at paint time
// to seed the initial highlight; onSpeaking keeps it live between paints.
//
// Convention (see docs/decomposition.md): a DOM-carrying feature module takes the
// element builder `el` and `$` as deps and reads reassigned module state through
// getters (`getState`, `getVoiceCallState` — both are reassigned on every update,
// so capturing the value would go stale). Already-modular helpers are imported
// directly: the video elements from voice.js, otherDMParticipant from state.js,
// initials from util.js.
//
// Tested by web/e2e/video-grid.spec.js (grid show/hide, fullscreen control, the
// mobile chat↔video toggle) plus the live-tile assertions in dm-call/group-call.

import { getVideoEl, getLocalVideoEl } from "./voice.js";
import { otherDMParticipant, anyVideoPresent } from "./state.js";
import { initials } from "./util.js";

export function createVideoGrid({
  el,
  $,
  getState,
  getVoiceCallState,
  getSpeakingIds,
  avatarSrc,
  getVideoViewHidden,
  setVideoViewHidden,
}) {
  // setVideoActive toggles body.video-active (which hides the composer/message
  // list behind the video grid). The composer needs no re-size on reveal: it's a
  // contenteditable div that sizes itself from content (the old textarea needed
  // a JS autosize pass here to undo a height:0px written while it was hidden).
  function setVideoActive(on) {
    document.body.classList.toggle("video-active", on);
  }

  // appendFullscreenButton adds the corner ⛶ control that toggles fullscreen on
  // the grid (covers the mobile "replace chat with video" case too).
  function appendFullscreenButton(grid) {
    const fsBtn = el("button", { class: "video-fullscreen-btn", title: "Fullscreen" }, "⛶");
    fsBtn.onclick = () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        grid.requestFullscreen().catch(() => {});
      }
    };
    grid.appendChild(fsBtn);
  }

  // hideVideoGrid collapses #video-grid and clears the body video-active state — the
  // shared "no video to show" teardown across renderVideoGrid and both renderers.
  function hideVideoGrid(grid) {
    grid.classList.remove("group-grid");
    grid.hidden = true;
    setVideoActive(false);
  }

  // showVideoGrid reveals a freshly-built grid (with its fullscreen control) and
  // flips the body into video-active — the shared tail of both renderers.
  function showVideoGrid(grid) {
    appendFullscreenButton(grid);
    grid.hidden = false;
    setVideoActive(true);
  }

  // videoAvatarTile builds the dark camera-off placeholder for one participant:
  // their avatar (or initials) plus their name. Used by both the DM and group
  // layouts wherever a participant has no live video.
  function videoAvatarTile(userId, user) {
    const avatarDiv = el("div", { class: "video-avatar" });
    if (user && user.has_avatar) {
      avatarDiv.appendChild(el("img", { class: "video-avatar-img", src: avatarSrc(userId), alt: "" }));
    } else {
      avatarDiv.appendChild(el("div", { class: "video-avatar-initials" }, initials((user || {}).display_name)));
    }
    avatarDiv.appendChild(el("span", { class: "video-avatar-name" }, (user || {}).display_name || ""));
    return avatarDiv;
  }

  // renderDMVideoGrid is the original 2-tile DM layout: remote tile (video when
  // the camera is on, dark avatar tile when off) plus a local PiP when our camera
  // is on (decision: no self-preview when our camera is off).
  function renderDMVideoGrid(grid, ch) {
    const state = getState();
    const voiceCallState = getVoiceCallState();
    grid.classList.remove("group-grid");
    const otherId = otherDMParticipant(ch, state.me && state.me.id);
    const otherP = voiceCallState.participants.find(p => p.user_id === otherId);
    const remoteVideoMuted = !otherP || otherP.video_muted;

    // When both cameras are off there's no video to show; also clear any mobile
    // view-override so the toggle button disappears cleanly. Same predicate the
    // header toggle keys on (state.anyVideoPresent) so the two never disagree.
    if (!anyVideoPresent(voiceCallState, state.me && state.me.id)) {
      setVideoViewHidden(false);
      hideVideoGrid(grid);
      return;
    }

    // On mobile the user may have chosen to view chat instead of video.
    if (getVideoViewHidden()) {
      hideVideoGrid(grid);
      return;
    }
    const remoteVideo = otherId != null ? getVideoEl(otherId) : null;

    grid.innerHTML = "";

    const remoteTile = el("div", { class: "video-tile" });
    if (remoteVideo && !remoteVideoMuted) {
      remoteTile.appendChild(remoteVideo);
      remoteVideo.play().catch(() => {});
    } else {
      remoteTile.appendChild(videoAvatarTile(otherId, otherId != null ? state.users[otherId] : null));
    }
    grid.appendChild(remoteTile);

    // Local PiP only when camera is on
    if (!voiceCallState.videoMuted) {
      const localVid = getLocalVideoEl();
      if (localVid) {
        localVid.className = "video-tile-local";
        grid.appendChild(localVid);
        localVid.play().catch(() => {});
      }
    }

    showVideoGrid(grid);
  }

  // renderGroupVideoGrid is the 1.4.0 N-tile gallery: one tile per call
  // participant (self included), in join order. A participant with their camera
  // on shows live video; otherwise a dark avatar tile. The grid only appears once
  // at least one participant has a camera on — a camera-off voice call is
  // represented by the members roster, not a wall of avatar tiles. The active
  // speaker is highlighted live by onSpeaking toggling each tile's `.speaking`.
  function renderGroupVideoGrid(grid, ch) {
    const state = getState();
    const voiceCallState = getVoiceCallState();
    const speakingIds = getSpeakingIds();
    const meId = state.me && state.me.id;

    if (!anyVideoPresent(voiceCallState, meId)) {
      setVideoViewHidden(false);
      hideVideoGrid(grid);
      return;
    }
    if (getVideoViewHidden()) {
      hideVideoGrid(grid);
      return;
    }

    grid.innerHTML = "";
    grid.classList.add("group-grid");

    for (const p of voiceCallState.participants) {
      const isSelf = p.user_id === meId;
      const videoOn = isSelf ? !voiceCallState.videoMuted : !p.video_muted;
      const videoEl = videoOn ? (isSelf ? getLocalVideoEl() : getVideoEl(p.user_id)) : null;

      const tile = el("div", { class: "video-tile", "data-user-id": String(p.user_id) });
      if (speakingIds.has(p.user_id)) tile.classList.add("speaking");
      if (videoEl) {
        videoEl.className = ""; // shed any PiP styling from a prior DM render
        tile.appendChild(videoEl);
        videoEl.play().catch(() => {});
      } else {
        const user = isSelf ? (state.users[meId] || state.me) : state.users[p.user_id];
        tile.appendChild(videoAvatarTile(p.user_id, user));
      }
      grid.appendChild(tile);
    }

    showVideoGrid(grid);
  }

  // renderVideoGrid paints #video-grid for the active call when we're viewing its
  // channel. DMs use the 2-tile phone layout (remote tile + local PiP); group
  // voice channels use an N-tile gallery (one tile per participant). Hidden when
  // not in a call, viewing a different channel, or nobody has a camera on.
  function renderVideoGrid() {
    const state = getState();
    const voiceCallState = getVoiceCallState();
    const grid = $("#video-grid");
    const ch = voiceCallState.inCall && voiceCallState.channelId !== null
      ? state.channels[voiceCallState.channelId]
      : null;

    if (!ch || voiceCallState.channelId !== state.activeChannelId) {
      hideVideoGrid(grid);
      return;
    }
    if (ch.is_dm) renderDMVideoGrid(grid, ch);
    else renderGroupVideoGrid(grid, ch);
  }

  return { renderVideoGrid };
}
