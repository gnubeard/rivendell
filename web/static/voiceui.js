// voiceui.js — the DOM/UX layer over voice.js (the secret.js / secretui.js
// method applied to calls). voice.js owns the WebRTC engine — peer connections,
// media, ICE, congestion control; this module owns what the user sees and clicks
// around a call: the bottom call strip, the incoming/outgoing ring banner,
// push-to-talk, the per-user volume slider, the mobile video/chat toggle, and the
// ring OS-notification. It also folds voice.js's state pushes (onVoiceStateChange/
// onSpeaking) and the server's voice.* events (onVoiceEvent) into the UI.
//
// It owns the live call/ring UI state — ringState, the latest voiceCallState, the
// on-call participant + speaking sets, the per-channel sidebar rosters,
// videoViewHidden, and the PTT flags — all inside the factory closure. app.js's
// own render functions (the channel header, members panel, channel list) read
// what they need through the small accessor methods this returns; the videogrid.js
// getters read voiceCallState/speakingIds/videoViewHidden the same way.
//
// Deps: $/el (DOM helpers), getState (() => state, read fresh), sendWS, prefs
// (PTT persistence), the render/navigation hooks (renderChannelHeader,
// renderMembers, renderChannels, renderVideoGrid, selectChannel, ensureDMOpen),
// displayNameOf, tabUnfocused, and getNotifEnabled/getTelemetry getters for the
// two app-owned values a call path still reads. The voice.js engine, tones.js,
// and notify.js primitives are imported directly.

import {
  setVoiceMuted,
  isVoiceMuted,
  setVoiceDeafened,
  isVoiceDeafened,
  setCameraEnabled,
  isCameraEnabled,
  joinVoiceChannel,
  leaveVoiceChannel,
  endCallLocally,
  isInCall,
  voiceChannelId,
  loadCameraPreference,
  handleVoiceSignal,
  setVolumeForUser,
  getVolumeForUser,
  pttShouldFire,
  pttKeyLabel,
  micErrorMessage,
} from "./voice.js";
import {
  startRingSound,
  stopRingSound,
  startPendingSound,
  stopPendingSound,
  greetTone,
  farewellTone,
} from "./tones.js";
import { otherDMParticipant, anyVideoPresent } from "./state.js";
import { dmDisplayName } from "./channelorder.js";
import {
  shouldNotify,
  showNotification,
  showViaServiceWorker,
  closeNotificationsByTag,
  currentPermission,
} from "./notify.js";
import { permalinkHash } from "./format.js";

export function createVoiceUI({
  $, el, getState, api, sendWS, prefs,
  renderChannelHeader, renderMembers, renderChannels, renderVideoGrid,
  selectChannel, ensureDMOpen, displayNameOf, tabUnfocused,
  getNotifEnabled, getTelemetry,
}) {
  // --- live call/ring UI state (was app.js module state) ---------------------
  let ringState = null; // in-progress ring: { channelId, direction: "outgoing"|"incoming", fromUserId }
  let voiceCallState = { inCall: false, channelId: null, muted: false, deafened: false, videoMuted: true, participants: [] }; // live from voice.js (via callback)
  let videoViewHidden = false; // mobile user tapped 💬 to view chat mid video call; cleared on end / channel switch / both-cameras-off
  let voiceRosters = {};       // channelId → [{user_id, joined_at, muted}] for sidebar display
  let callParticipantIds = new Set(); // user ids on our active call (self incl.), from voiceCallState; drives the on-call cue + greet/farewell tones
  let speakingIds = new Set(); // user ids currently speaking (voice.js metering via onSpeaking); pulses a ring on roster rows

  // Push-to-talk: when enabled the mic stays muted in a call until the bound key
  // is held (see wirePushToTalk). pttKeyCode is a layout-independent
  // KeyboardEvent.code (default backtick); pttTransmitting is true only while
  // held; pttCapturing is true while the profile-modal rebind UI awaits a keypress.
  let pttEnabled = prefs.loadPttEnabled();
  let pttKeyCode = prefs.loadPttKeyCode();
  let pttTransmitting = false;
  let pttCapturing = false;

  // --- voice control wiring --------------------------------------------------

  function wireVoiceControls() {
    // Call strip (active call controls at the bottom of the sidebar).
    $("#call-mute-btn").onclick = () => {
      setVoiceMuted(!isVoiceMuted());
      renderCallStrip();
    };
    $("#call-deafen-btn").onclick = () => {
      setVoiceDeafened(!isVoiceDeafened());
      renderCallStrip();
    };
    $("#call-leave-btn").onclick = () => leaveVoiceChannel();

    // Camera toggle (DM calls only — button is hidden in regular voice channels).
    $("#call-camera-btn").onclick = async () => {
      await setCameraEnabled(!isCameraEnabled());
      renderCallStrip();
      renderVideoGrid();
    };
    // Mobile video/chat toggle: switches between watching video and reading chat.
    $("#header-camera-btn").onclick = () => {
      videoViewHidden = !videoViewHidden;
      applyHeaderCamLabel($("#header-camera-btn"));
      renderVideoGrid();
    };

    // Accept the current incoming ring: signal the caller, clear the banner, and
    // join the call. Shared by the ring banner's accept button and the channel
    // header call button (which doubles as "Answer" while a ring is incoming).
    const acceptRing = async () => {
      if (!ringState) return;
      const chId = ringState.channelId;
      const fromUserId = ringState.fromUserId;
      stopRingSound();
      clearRingNotification();
      // Send acceptance before joining so the caller gets the signal promptly.
      sendWS({ type: "voice.ring_response", dm_channel_id: chId, accept: true });
      ringState = null;
      renderRingBanner();
      try {
        await ensureDMOpen(chId, fromUserId);
        await joinVoiceChannel(chId, { enableVideo: loadCameraPreference(chId) });
        selectChannel(chId);
      } catch (e) {
        alert(micErrorMessage(e));
      }
    };

    // Ring banner (incoming call).
    $("#ring-accept-btn").onclick = acceptRing;
    $("#ring-decline-btn").onclick = () => {
      if (!ringState) return;
      const chId = ringState.channelId;
      stopRingSound();
      stopPendingSound();
      clearRingNotification();
      sendWS({ type: "voice.ring_response", dm_channel_id: chId, accept: false });
      ringState = null;
      renderRingBanner();
      const state = getState();
      renderChannelHeader(state.channels[state.activeChannelId]);
    };

    // Call button in the channel header (DMs and regular channels).
    $("#call-btn").onclick = async () => {
      const state = getState();
      const ch = state.channels[state.activeChannelId];
      if (!ch) return;
      if (!ch.is_dm) {
        // Regular voice channel: toggle join/leave.
        if (isInCall() && voiceCallState.channelId === ch.id) {
          await leaveVoiceChannel();
        } else {
          try {
            await joinVoiceChannel(ch.id);
          } catch (e) {
            alert(micErrorMessage(e));
          }
        }
        return;
      }
      if (ringState && ringState.channelId === ch.id && ringState.direction === "incoming") {
        // Answer the incoming call (same path as the ring banner's accept button).
        await acceptRing();
        return;
      }
      if (ringState) {
        // Cancel the outgoing ring.
        const chId = ringState.channelId;
        stopPendingSound();
        sendWS({ type: "voice.ring_response", dm_channel_id: chId, accept: false });
        ringState = null;
        renderRingBanner();
        renderChannelHeader(ch);
        return;
      }
      if (isInCall()) {
        await leaveVoiceChannel();
        return;
      }
      sendWS({ type: "voice.ring", dm_channel_id: ch.id });
      ringState = { channelId: ch.id, direction: "outgoing", fromUserId: state.me.id };
      renderChannelHeader(ch);
      renderRingBanner();
      startPendingSound(); // caller-side "waiting for pickup" tone
    };

    wirePushToTalk();
  }

  // --- push-to-talk ----------------------------------------------------------
  //
  // When PTT is enabled, the mic is held muted in a call (set on join, see
  // onVoiceStateChange) and only opens while the bound key is held. We listen in
  // the capture phase so the rebind UI can intercept a keypress before anything
  // else, and so a held PTT key is seen even when focus is elsewhere. The bound
  // key still types normally inside a text field — pttShouldFire's editable guard
  // is what makes the default backtick usable for code in the composer.
  function wirePushToTalk() {
    window.addEventListener("keydown", onPttKeyDown, true);
    window.addEventListener("keyup", onPttKeyUp, true);
    // A held key whose keyup we'd otherwise miss (tab/window blur) must not leave
    // the mic stuck open — release PTT defensively when we lose focus.
    window.addEventListener("blur", () => { if (pttTransmitting) releasePtt(); });

    // Profile-modal controls: the enable checkbox and the key-rebind button.
    const cb = $("#ptt-enable");
    if (cb) {
      cb.onchange = () => {
        pttEnabled = cb.checked;
        pttCapturing = false;
        prefs.savePtt(pttEnabled, pttKeyCode);
        // Apply immediately if we're already in a call: enabling holds the mic
        // muted at rest; disabling opens it back up.
        if (isInCall()) { pttTransmitting = false; setVoiceMuted(pttEnabled); }
        renderPttControl();
        renderCallStrip();
      };
    }
    const keyBtn = $("#ptt-key-btn");
    if (keyBtn) {
      keyBtn.onclick = () => { pttCapturing = true; renderPttControl(); };
    }
  }

  function isEditableTarget(t) {
    if (!t) return false;
    const tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
  }

  function onPttKeyDown(e) {
    // Rebind capture: the next keypress (Escape cancels) becomes the PTT key. We
    // swallow it so it neither toggles PTT nor closes the open profile modal.
    if (pttCapturing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code !== "Escape") { pttKeyCode = e.code; prefs.savePtt(pttEnabled, pttKeyCode); }
      pttCapturing = false;
      renderPttControl();
      renderCallStrip();
      return;
    }
    if (e.repeat) return; // auto-repeat while the key is held — already transmitting
    if (pttTransmitting) return;
    if (!pttShouldFire({ enabled: pttEnabled, inCall: isInCall(), code: e.code, boundCode: pttKeyCode, editable: isEditableTarget(e.target) })) return;
    pttTransmitting = true;
    setVoiceMuted(false);
    renderCallStrip();
  }

  function onPttKeyUp(e) {
    if (!pttTransmitting || e.code !== pttKeyCode) return;
    releasePtt();
  }

  // releasePtt closes the PTT mic gate (re-mutes) and repaints the strip.
  function releasePtt() {
    pttTransmitting = false;
    if (isInCall()) setVoiceMuted(true);
    renderCallStrip();
  }

  // renderPttControl reflects the push-to-talk preference into the profile modal:
  // the enable checkbox, the (only-when-enabled) key-rebind button, and a hint.
  // While rebinding, the button reads "press a key…" until the next keypress.
  function renderPttControl() {
    const cb = $("#ptt-enable");
    if (!cb) return;
    cb.checked = pttEnabled;
    const keyrow = $("#ptt-keyrow");
    const keyBtn = $("#ptt-key-btn");
    const status = $("#ptt-status");
    if (keyrow) keyrow.hidden = !pttEnabled;
    if (keyBtn) keyBtn.textContent = pttCapturing ? "press a key…" : pttKeyLabel(pttKeyCode);
    if (status) status.textContent = pttEnabled
      ? "Your mic stays muted in a call until you hold the key. It still types normally in the message box."
      : "Off — your mic is open the whole time you're in a call.";
  }

  // onProfileOpen refreshes the PTT sub-control when the profile modal opens
  // (clearing any half-finished rebind). app.js's modals.onProfileOpen calls it
  // alongside its own renderNotifControl.
  function onProfileOpen() {
    pttCapturing = false;
    renderPttControl();
  }

  // --- voice + ring event handling -------------------------------------------

  // onVoiceEvent handles incoming voice.* events from the server.
  async function onVoiceEvent(evt) {
    const p = evt.payload || {};
    const state = getState();

    if (evt.type === "voice.ring") {
      // Incoming ring from another user.
      if (ringState) return; // already in a ring — ignore (shouldn't happen in practice)
      ringState = { channelId: p.dm_channel_id, direction: "incoming", fromUserId: p.from_user_id };
      renderRingBanner();
      // Repaint the header so the active DM's call button flips to the "answer"
      // icon — the banner alone doesn't drive the header.
      renderChannelHeader(state.channels[state.activeChannelId]);
      startRingSound();
      fireRingNotification(p.from_user_id, p.dm_channel_id);
      return;
    }

    if (evt.type === "voice.ring_response") {
      // Response to a ring we sent, or the other side cancelling their ring.
      if (!ringState) return;
      stopRingSound();
      stopPendingSound();
      clearRingNotification();
      const accepted = p.accept;
      const chId = ringState.channelId;
      ringState = null;
      renderRingBanner();
      renderChannelHeader(state.channels[state.activeChannelId]);
      if (accepted) {
        try {
          await joinVoiceChannel(chId, { enableVideo: loadCameraPreference(chId) });
        } catch (e) {
          alert(micErrorMessage(e));
        }
      }
      return;
    }

    if (evt.type === "voice.ring_timeout") {
      if (ringState && ringState.channelId === p.dm_channel_id) {
        stopRingSound();
        stopPendingSound();
        clearRingNotification();
        ringState = null;
        renderRingBanner();
        renderChannelHeader(state.channels[state.activeChannelId]);
      }
      return;
    }

    if (evt.type === "voice.ring_dismissed") {
      // Another of our own sessions (tab/device) answered or declined this ring.
      // Stop ringing here too, but do NOT join — that session handles the call.
      if (ringState && ringState.channelId === p.dm_channel_id) {
        stopRingSound();
        stopPendingSound();
        clearRingNotification();
        ringState = null;
        renderRingBanner();
        renderChannelHeader(state.channels[state.activeChannelId]);
      }
      return;
    }

    if (evt.type === "voice.end") {
      // The other party in a DM hung up (or dropped): the call ends for both.
      // Tear down our side without echoing a voice.leave (the server already
      // removed us). endCallLocally fires the farewell tone (in steady-state
      // capture) then tears down — async, fire-and-forget here.
      if (isInCall() && voiceChannelId() === p.channel_id) {
        endCallLocally();
      }
      return;
    }

    if (evt.type === "voice.join_denied") {
      // The server refused our join (group caps). "full": the channel is at its
      // participant limit — abort the optimistic local join. "video_full": only
      // the camera slots are exhausted, so stay in the call but drop back to
      // audio-only (the server already forced us video-muted).
      const telemetry = getTelemetry();
      if (telemetry) { try { telemetry.event(0, "join-denied", { reason: p.reason, limit: p.limit }); } catch { /* telemetry never throws */ } }
      if (p.reason === "video_full") {
        await setCameraEnabled(false);
        alert(`This call already has the maximum ${p.limit} cameras on — staying audio-only.`);
      } else {
        if (isInCall() && voiceChannelId() === p.channel_id) await endCallLocally();
        alert(`That call is full (max ${p.limit}).`);
      }
      return;
    }

    // voice.state — update sidebar rosters for any channel, then pass to voice.js.
    if (evt.type === "voice.state") {
      voiceRosters[evt.payload.channel_id] = evt.payload.participants || [];
      renderChannels();
    }
    // voice.state / offer / answer / ice — pass to voice.js machinery.
    await handleVoiceSignal(evt);
  }

  function renderRingBanner() {
    const banner = $("#ring-banner");
    if (!ringState) {
      banner.hidden = true;
      return;
    }
    const { direction, fromUserId, channelId } = ringState;
    const bannerText = $("#ring-banner-text");
    if (direction === "incoming") {
      bannerText.textContent = displayNameOf(fromUserId) + " is calling…";
      $("#ring-accept-btn").hidden = false;
      $("#ring-decline-btn").textContent = "Decline";
    } else {
      // outgoing ring
      const state = getState();
      const ch = state.channels[channelId];
      const otherName = ch ? dmDisplayName(state, ch) : "…";
      bannerText.textContent = "Calling " + otherName + "…";
      $("#ring-accept-btn").hidden = true;
      $("#ring-decline-btn").textContent = "Cancel";
    }
    banner.hidden = false;
  }

  // --- ring OS notification --------------------------------------------------

  // Stable tag so repeat rings for the same incoming call coalesce into one
  // notification instead of stacking; `ringNotification` holds the page-context
  // Notification (the SW path is dismissed by tag) so clearRingNotification can
  // auto-dismiss it once the ring is answered/declined/times out.
  const RING_NOTIF_TAG = "rivendell-ring";
  let ringNotification = null;

  // fireRingNotification raises an OS notification for an incoming call when the
  // user has opted in and isn't looking at this tab — a backgrounded tab's audible
  // ring alone is easy to miss. Foreground only (a live tab): a ring is ephemeral
  // WS state, not a persisted message, so there's no Web Push path to a fully
  // closed app. Clicking it focuses the tab and opens the DM, mirroring firePing.
  function fireRingNotification(fromUserId, dmChannelId) {
    if (!shouldNotify({ permission: currentPermission(), enabled: getNotifEnabled(), focused: !tabUnfocused() })) {
      return;
    }
    const state = getState();
    const caller = state.users[fromUserId];
    const title = "📞 Call from " + displayNameOf(fromUserId);
    const icon = caller && caller.has_avatar ? api.avatarURL(caller.id) : undefined;
    // messageId 0 = "just open the channel" (real ids start at 1); the SW click
    // routing in initPushRouting treats it as selectChannel rather than a jump.
    const url = "/" + permalinkHash(dmChannelId, 0);
    showViaServiceWorker(title, { tag: RING_NOTIF_TAG, icon, url }).then((shown) => {
      if (!shown) {
        ringNotification = showNotification(title, { tag: RING_NOTIF_TAG, icon, onclick: () => selectChannel(dmChannelId) });
      }
    });
  }

  // clearRingNotification dismisses the incoming-call notification (both paths)
  // once the ring resolves, so a stale "Call from …" doesn't linger after
  // accept/decline/timeout/sibling-dismiss.
  function clearRingNotification() {
    if (ringNotification) {
      try { ringNotification.close(); } catch (e) { /* best-effort */ }
      ringNotification = null;
    }
    closeNotificationsByTag(RING_NOTIF_TAG);
  }

  // --- voice state callbacks -------------------------------------------------

  // onVoiceStateChange folds a fresh state push from voice.js into the UI: it
  // chimes a greet/farewell tone for each remote peer that joined/left since the
  // last push, refreshes the on-call cue set, and repaints the call strip, header,
  // and member roster. Our OWN join/leave tones are NOT fired here — they're
  // driven by voice.js lifecycle hooks (greetTone just after the mic is live and
  // settled, farewellTone just before teardown) so they land in the same
  // steady-state capture window where these remote-peer tones play loud, not in
  // the capture start/stop device transition. See initVoice / joinVoiceChannel.
  function onVoiceStateChange(vs) {
    const state = getState();
    const prevInCall = voiceCallState.inCall;
    const prevRemote = new Set([...callParticipantIds].filter((id) => id !== state.me.id));
    voiceCallState = vs;
    callParticipantIds = new Set((vs.participants || []).map((p) => p.user_id));
    // Entering a call with push-to-talk on: hold the mic muted at rest (the key
    // opens it). The !prevInCall guard fires this only on the join transition;
    // setVoiceMuted re-enters here with prevInCall now true, so it won't recurse.
    if (!prevInCall && vs.inCall && pttEnabled && !pttTransmitting && !isVoiceMuted()) setVoiceMuted(true);
    if (!vs.inCall) pttTransmitting = false; // call ended: drop any stuck PTT gate
    if (prevInCall && vs.inCall) {
      // Already in call: chime for remote peers joining/leaving. (Self join/leave
      // tones are handled by the voice.js lifecycle hooks, not here.)
      const nowRemote = new Set([...callParticipantIds].filter((id) => id !== state.me.id));
      for (const id of nowRemote) if (!prevRemote.has(id)) greetTone();
      for (const id of prevRemote) if (!nowRemote.has(id)) farewellTone();
    }
    if (!vs.inCall && speakingIds.size) speakingIds.clear(); // call ended: drop stale rings
    if (!vs.inCall) videoViewHidden = false; // call ended: clear any mobile chat-override
    renderCallStrip();
    renderVideoGrid();
    renderChannelHeader(state.channels[state.activeChannelId]);
    renderMembers();
  }

  // onSpeaking folds a speaking-state flip from voice.js into the roster: it
  // toggles a pulsing ring on that user's member row without re-rendering the
  // whole list (the flip fires every ~80ms of metering, far too often to repaint).
  function onSpeaking(userId, speaking) {
    const had = speakingIds.has(userId);
    if (speaking === had) return;
    if (speaking) speakingIds.add(userId);
    else speakingIds.delete(userId);
    const li = document.querySelector(`#member-list li[data-user-id="${userId}"]`);
    if (li) li.classList.toggle("speaking", speaking);
    // In a group video gallery, promote the active speaker by highlighting their
    // tile — without repainting the grid (the flip fires far too often for that).
    const tile = document.querySelector(`#video-grid .video-tile[data-user-id="${userId}"]`);
    if (tile) tile.classList.toggle("speaking", speaking);
  }

  // --- call strip ------------------------------------------------------------
  // The video grid itself lives in videogrid.js (createVideoGrid in app.js); the
  // call strip stays here because it reads the PTT flags this module owns.

  function renderCallStrip() {
    const state = getState();
    const strip = $("#call-strip");
    if (!voiceCallState.inCall) {
      strip.hidden = true;
      return;
    }
    const ch = voiceCallState.channelId !== null ? state.channels[voiceCallState.channelId] : null;
    const label = ch ? (ch.is_dm ? "📞 " + dmDisplayName(state, ch) : "🔊 #" + ch.name) : "In call";
    $("#call-strip-label").textContent = label;
    // In PTT mode the mic is key-driven, so the mute toggle is replaced by a PTT
    // pill that lights up while you're holding the key (transmitting).
    const muteBtn = $("#call-mute-btn");
    const pttPill = $("#call-ptt");
    if (pttEnabled) {
      muteBtn.hidden = true;
      pttPill.hidden = false;
      pttPill.textContent = "PTT " + pttKeyLabel(pttKeyCode);
      pttPill.title = "Push-to-talk — hold " + pttKeyLabel(pttKeyCode) + " to talk";
      pttPill.classList.toggle("active", pttTransmitting);
    } else {
      pttPill.hidden = true;
      muteBtn.hidden = false;
      muteBtn.textContent = voiceCallState.muted ? "🔇" : "🎙";
      muteBtn.title = voiceCallState.muted ? "Unmute" : "Mute";
      muteBtn.classList.toggle("active", voiceCallState.muted);
    }
    const deafBtn = $("#call-deafen-btn");
    deafBtn.textContent = voiceCallState.deafened ? "🔈" : "🔊";
    deafBtn.title = voiceCallState.deafened ? "Undeafen" : "Deafen";
    deafBtn.classList.toggle("active", voiceCallState.deafened);
    // Camera button: available in any call — DMs and group voice channels alike
    // (group video is the 1.4.0 feature). Hidden only when there's no active call.
    const camBtn = $("#call-camera-btn");
    if (ch) {
      camBtn.hidden = false;
      camBtn.textContent = voiceCallState.videoMuted ? "📷" : "🎥";
      camBtn.title = voiceCallState.videoMuted ? "Turn camera on" : "Turn camera off";
      camBtn.classList.toggle("active", voiceCallState.videoMuted);
    } else {
      camBtn.hidden = true;
    }
    strip.hidden = false;
  }

  // --- per-user volume slider (rendered into the members panel by app.js) ----

  // volumeSlider builds the per-user playout-volume control shown under an on-call
  // remote member's name. Clicks are kept off the row (which would open a DM); the
  // title tracks the live percentage. The value is applied + persisted by voice.js.
  function volumeSlider(u) {
    const pct = (v) => `Volume — ${Math.round(v * 100)}%`;
    return el("input", {
      type: "range", min: "0", max: "1", step: "0.05",
      value: String(getVolumeForUser(u.id)),
      class: "member-volume",
      title: pct(getVolumeForUser(u.id)),
      "aria-label": `Volume for ${u.display_name}`,
      onclick: (e) => e.stopPropagation(),
      oninput: (e) => {
        const v = Number(e.target.value);
        setVolumeForUser(u.id, v);
        e.target.title = pct(v);
      },
    });
  }

  // --- mobile video/chat toggle label ----------------------------------------

  // applyHeaderCamLabel sets the mobile video/chat toggle button's glyph + title
  // from videoViewHidden — 📺/"Show video" while chat is showing, 💬/"Show chat"
  // while video is. Single source of truth for that mapping (both header branches
  // and the button's own click handler route through it).
  function applyHeaderCamLabel(btn) {
    btn.textContent = videoViewHidden ? "📺" : "💬";
    btn.title = videoViewHidden ? "Show video" : "Show chat";
  }

  // resetVideoView clears the mobile chat-override (used on channel switch) and
  // repaints the grid.
  function resetVideoView() {
    videoViewHidden = false;
    renderVideoGrid();
  }

  return {
    // lifecycle / event entry points
    wireVoiceControls,
    onVoiceEvent,
    onVoiceStateChange,
    onSpeaking,
    onProfileOpen,
    // shared renders app.js needs
    volumeSlider,
    applyHeaderCamLabel,
    resetVideoView,
    // accessors for app.js render functions (header / members / channel list)
    getRingState: () => ringState,
    inCallOn: (channelId) => voiceCallState.inCall && voiceCallState.channelId === channelId,
    isParticipant: (userId) => callParticipantIds.has(userId),
    anyVideoPresent: () => {
      const state = getState();
      return anyVideoPresent(voiceCallState, state.me && state.me.id);
    },
    isVideoViewHidden: () => videoViewHidden,
    rosterFor: (channelId) => voiceRosters[channelId] || [],
    // on-call cue set for the active channel, or null (drives renderMembers)
    callCueIds: (activeChannelId) =>
      (voiceCallState.inCall && voiceCallState.channelId === activeChannelId) ? callParticipantIds : null,
    isSpeaking: (userId) => speakingIds.has(userId),
    // getters read by the videogrid.js create call in app.js
    getVoiceCallState: () => voiceCallState,
    getSpeakingIds: () => speakingIds,
    getVideoViewHidden: () => videoViewHidden,
    setVideoViewHidden: (v) => { videoViewHidden = v; },
    // seed voice rosters at boot (enterApp pulls /api/voice-state)
    seedRoster: (channelId, participants) => { voiceRosters[channelId] = participants; },
  };
}
