// videogrid.js — the in-call video grid (#video-grid). Paints the live call's
// tiles for the active channel: the 2-tile phone layout for DMs (remote tile +
// local PiP) and the N-tile gallery for group voice channels, plus the show/hide
// teardown, the corner ⛶ fullscreen control, the in-app spotlight view, and the
// body.video-active takeover of the conversation pane.
//
// What it owns: building/showing/hiding #video-grid, toggling body.video-active,
// and the spotlight state (opt-in; auto-follows the active speaker / screen-share
// and pins on click).
// What stays in app.js: ownership of videoViewHidden (header label, channel
// selection, and call lifecycle all read/write it directly — the grid only gets a
// get/set pair), the call strip (renderCallStrip reads the PTT flags and is more
// coupled), and the speaking-ring live toggle in onSpeaking (it mutates a tile's
// .speaking class without repainting). The grid reads `speakingIds` at paint time
// to seed the initial highlight; onSpeaking keeps it live between paints — and in
// auto-follow spotlight it calls reflowSpotlightForSpeaker so the big tile tracks
// the talker.
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
  // Spotlight state (group calls only, opt-in). spotlightOn flips the gallery into
  // one-big-tile + filmstrip; pinnedUserId locks the big tile onto a user the
  // viewer clicked (null = auto-follow the active speaker / a screen-sharer).
  // lastFeaturedId is the subject of the last spotlight paint, so a speaker flip
  // only repaints when the featured user would actually change (onSpeaking fires
  // far too often for a blind repaint).
  let spotlightOn = false;
  let pinnedUserId = null;
  let lastFeaturedId = null;

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

  // appendSpotlightButton adds the corner control that toggles the spotlight view.
  // Group calls only (the DM layout is already a single remote tile). Turning it
  // off also releases any pin so the next enable starts in auto-follow.
  function appendSpotlightButton(grid) {
    const btn = el("button", {
      class: "video-spotlight-btn",
      title: spotlightOn ? "Back to grid" : "Spotlight one stream",
    }, spotlightOn ? "▦" : "▣");
    btn.onclick = () => {
      spotlightOn = !spotlightOn;
      if (!spotlightOn) pinnedUserId = null;
      renderVideoGrid();
    };
    grid.appendChild(btn);
  }

  // hideVideoGrid collapses #video-grid and clears the body video-active state — the
  // shared "no video to show" teardown across renderVideoGrid and both renderers.
  function hideVideoGrid(grid) {
    grid.classList.remove("group-grid", "spotlight");
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
    grid.classList.remove("group-grid", "spotlight");
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
        // Sharing the screen flips the PiP to object-fit:contain so the whole
        // shared surface shows (a camera self-view crops to fill; a screen mustn't).
        localVid.className = "video-tile-local" + (voiceCallState.sharing ? " sharing" : "");
        grid.appendChild(localVid);
        localVid.play().catch(() => {});
      }
    }

    showVideoGrid(grid);
  }

  // shownParticipants is the group-call participant list minus our OWN tile when
  // our camera is off: we don't need to watch our own avatar take a slot (mirrors
  // the DM layout's no-self-preview rule). Other participants' camera-off avatar
  // tiles stay, so you still see who's present.
  function shownParticipants(voiceCallState, meId) {
    return voiceCallState.participants.filter(p =>
      !(p.user_id === meId && voiceCallState.videoMuted));
  }

  // buildParticipantTile renders one group-call tile: live video when that
  // participant's camera/screen is on, else a dark avatar tile. `speakingIds`
  // seeds the initial speaking ring (onSpeaking keeps it live between paints).
  function buildParticipantTile(p, meId, state, voiceCallState, speakingIds) {
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
    return tile;
  }

  // pickFeatured chooses the spotlight subject from the shown participants, in
  // priority order: an explicit pin (while that user is still present) → a screen
  // sharer → the active speaker → anyone with video on → the first participant.
  function pickFeatured(shown, meId, voiceCallState, speakingIds) {
    if (!shown.length) return null;
    const present = (id) => shown.some(p => p.user_id === id);
    if (pinnedUserId != null && present(pinnedUserId)) return pinnedUserId;
    const sharer = shown.find(p => p.sharing);
    if (sharer) return sharer.user_id;
    // Prefer a REMOTE speaker (watching yourself talk is pointless), else any speaker.
    const speaker = shown.find(p => p.user_id !== meId && speakingIds.has(p.user_id)) ||
                    shown.find(p => speakingIds.has(p.user_id));
    if (speaker) return speaker.user_id;
    const withVideo = shown.find(p =>
      p.user_id === meId ? !voiceCallState.videoMuted : !p.video_muted);
    if (withVideo) return withVideo.user_id;
    return shown[0].user_id;
  }

  // renderGroupSpotlight paints the spotlight layout: one big tile (the featured
  // subject) over a filmstrip of everyone else. Clicking a filmstrip tile pins it;
  // clicking the big tile releases the pin back to auto-follow.
  function renderGroupSpotlight(grid, shown, meId, state, voiceCallState, speakingIds) {
    grid.classList.add("spotlight");
    const featuredId = pickFeatured(shown, meId, voiceCallState, speakingIds);
    lastFeaturedId = featuredId;
    const featured = shown.find(p => p.user_id === featuredId) || shown[0];

    const stage = el("div", { class: "spotlight-stage" });
    const stageTile = buildParticipantTile(featured, meId, state, voiceCallState, speakingIds);
    stageTile.onclick = () => { pinnedUserId = null; renderVideoGrid(); };
    stage.appendChild(stageTile);
    grid.appendChild(stage);

    const strip = el("div", { class: "spotlight-strip" });
    for (const p of shown) {
      if (p.user_id === featured.user_id) continue;
      const tile = buildParticipantTile(p, meId, state, voiceCallState, speakingIds);
      tile.onclick = () => { pinnedUserId = p.user_id; renderVideoGrid(); };
      strip.appendChild(tile);
    }
    if (strip.children.length) grid.appendChild(strip);

    appendSpotlightButton(grid);
  }

  // renderGroupVideoGrid is the N-tile gallery (group voice channels). One tile
  // per participant (self included, unless our camera is off — see
  // shownParticipants), in join order; live video or a dark avatar tile. The grid
  // only appears once at least one participant has a camera on. The active speaker
  // is highlighted live by onSpeaking toggling each tile's `.speaking`. An opt-in
  // spotlight view (the ▣ control) collapses the gallery to one big tile + filmstrip.
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
    grid.classList.remove("spotlight");

    const shown = shownParticipants(voiceCallState, meId);

    if (spotlightOn && shown.length) {
      renderGroupSpotlight(grid, shown, meId, state, voiceCallState, speakingIds);
    } else {
      lastFeaturedId = null;
      for (const p of shown) {
        grid.appendChild(buildParticipantTile(p, meId, state, voiceCallState, speakingIds));
      }
      appendSpotlightButton(grid);
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
      // Reset spotlight when the call is fully over (a channel switch mid-call
      // keeps it, so switching back restores your view).
      if (!voiceCallState.inCall) { spotlightOn = false; pinnedUserId = null; lastFeaturedId = null; }
      hideVideoGrid(grid);
      return;
    }
    if (ch.is_dm) renderDMVideoGrid(grid, ch);
    else renderGroupVideoGrid(grid, ch);
  }

  // reflowSpotlightForSpeaker is called from voiceui.onSpeaking when the active
  // speaker set changes. In auto-follow spotlight (on, not pinned) it repaints
  // ONLY when the featured subject would actually change — onSpeaking fires per
  // metering flip, far too often to repaint blindly. No-op otherwise.
  function reflowSpotlightForSpeaker() {
    if (!spotlightOn || pinnedUserId != null) return;
    const state = getState();
    const voiceCallState = getVoiceCallState();
    if (!voiceCallState.inCall || voiceCallState.channelId !== state.activeChannelId) return;
    const meId = state.me && state.me.id;
    const shown = shownParticipants(voiceCallState, meId);
    if (pickFeatured(shown, meId, voiceCallState, getSpeakingIds()) !== lastFeaturedId) renderVideoGrid();
  }

  return { renderVideoGrid, reflowSpotlightForSpeaker };
}
