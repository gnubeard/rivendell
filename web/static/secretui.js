// secretui.js — the DOM/UX layer over secret.js (the search.js feature-module
// method). secret.js owns the crypto and session state machine; this module owns
// what the user sees and clicks: the request banner (incoming accept/decline,
// outgoing waiting/cancel), the 🔒 DM-header button that offers/opens a session,
// and the safety-number modal (compute, verify, end).
//
// It owns one piece of shared state — secretRequestState, the pending *incoming*
// request — which moves in here from app.js; app.js reads it only through
// getSecretRequest (the DM list shows a marker for a channel with a pending
// request). Everything else it does is drive renders, which are injected as
// callbacks; the secret.js primitives and otherDMParticipant are imported directly.
//
// Deps: $ (querySelector helper), getState (() => state, read fresh), api
// (publishIdentityKey), and the render/navigation hooks renderChannelHeader,
// renderMessages, renderDMs, selectChannel, ensureDMOpen.

import {
  getSession,
  initiateSecret,
  acceptSecret,
  declineSecret,
  endSecret,
  clearEndedSession,
  getPendingOffer,
  getMyPubKeyB64,
  markVerified,
  computeSafetyNumber,
} from "./secret.js?v=__RIVENDELL_VERSION__";
import { otherDMParticipant } from "./state.js?v=__RIVENDELL_VERSION__";

export function createSecretUI({ $, getState, api, renderChannelHeader, renderMessages, renderDMs, selectChannel, ensureDMOpen }) {
  // secretRequestState is set when a peer sends a secret.offer (an incoming
  // request awaiting our accept/decline), null otherwise. Outgoing offers live in
  // secret.js's session (phase "offered") — this is only the inbound prompt.
  let secretRequestState = null; // { dmChannelId, fromUserId } | null

  // publishMyKeyIfNeeded ensures our identity key is on the server. Idempotent —
  // it no-ops when the stored key already matches, so it's safe to call at boot
  // (so any peer can offer us a secret chat without a prior handshake) and again
  // before each handshake. Best-effort: a failure is logged, not fatal.
  async function publishMyKeyIfNeeded() {
    const state = getState();
    try {
      const myKeyB64 = await getMyPubKeyB64();
      if (state.me && state.me.identity_key !== myKeyB64) {
        await api.publishIdentityKey(myKeyB64);
      }
    } catch (e) {
      console.warn("secret: could not publish identity key:", e && e.message);
    }
  }

  // onSecretEvent is the callback from secret.js for all session lifecycle events.
  async function onSecretEvent(evt) {
    const { dmChannelId } = evt;
    const state = getState();

    if (evt.type === "secret-request") {
      // Peer sent a secret.offer. Show the accept/decline banner.
      secretRequestState = { dmChannelId, fromUserId: evt.fromUserId };
      renderSecretBanner();
      return;
    }

    if (evt.type === "session-active") {
      secretRequestState = null;
      renderSecretBanner();
      renderChannelHeader(state.channels[state.activeChannelId]);
      if (state.activeChannelId === dmChannelId) renderMessages(true);
      // Ensure our identity key is published so future handshakes can use it.
      await publishMyKeyIfNeeded();
      return;
    }

    if (evt.type === "session-ended") {
      if (secretRequestState && secretRequestState.dmChannelId === dmChannelId) {
        secretRequestState = null;
      }
      renderSecretBanner();
      renderChannelHeader(state.channels[state.activeChannelId]);
      if (state.activeChannelId === dmChannelId) renderMessages(true);
      return;
    }

    if (evt.type === "message-received") {
      if (state.activeChannelId === dmChannelId) {
        renderMessages(false);
      }
      return;
    }

    if (evt.type === "dismiss") {
      // Another of our tabs accepted/declined; clear the banner here too.
      if (secretRequestState && secretRequestState.dmChannelId === dmChannelId) {
        secretRequestState = null;
        renderSecretBanner();
      }
      return;
    }
  }

  function renderSecretBanner() {
    const state = getState();
    const banner = $("#secret-banner");
    if (secretRequestState) {
      // Incoming request from peer.
      const { fromUserId } = secretRequestState;
      const sender = state.users[fromUserId];
      const name = sender ? (sender.display_name || sender.username) : "Someone";
      $("#secret-banner-text").textContent = name + " wants to start a secret chat";
      $("#secret-accept-btn").hidden = false;
      $("#secret-decline-btn").textContent = "Decline";
      banner.hidden = false;
    } else {
      // Outgoing offer: we sent a request and are waiting for acceptance.
      const activeCh = state.channels[state.activeChannelId];
      const sess = activeCh && activeCh.is_dm ? getSession(state.activeChannelId) : null;
      if (sess && sess.phase === "offered") {
        $("#secret-banner-text").textContent = "Secret chat request sent — waiting for the other person to accept…";
        $("#secret-accept-btn").hidden = true;
        $("#secret-decline-btn").textContent = "Cancel";
        banner.hidden = false;
      } else {
        banner.hidden = true;
      }
    }
    renderDMs();
  }

  // wireSecretControls attaches click handlers to secret-related UI elements.
  function wireSecretControls() {
    // Accept button on the secret request banner.
    $("#secret-accept-btn").addEventListener("click", async () => {
      if (!secretRequestState) return;
      const { dmChannelId, fromUserId } = secretRequestState;
      const offer = getPendingOffer(dmChannelId);
      if (!offer) return;
      secretRequestState = null;
      renderSecretBanner();
      // Ensure our identity key is published before accepting.
      await publishMyKeyIfNeeded();
      try {
        await ensureDMOpen(dmChannelId, fromUserId);
        await acceptSecret(dmChannelId, fromUserId, offer);
        selectChannel(dmChannelId);
      } catch (e) {
        alert("Secret chat setup failed: " + (e && e.message));
      }
    });

    // Decline (incoming) / Cancel (outgoing) button on the secret request banner.
    $("#secret-decline-btn").addEventListener("click", () => {
      if (secretRequestState) {
        // Declining an incoming request.
        const { dmChannelId } = secretRequestState;
        secretRequestState = null;
        renderSecretBanner();
        declineSecret(dmChannelId);
        return;
      }
      // Canceling our own outgoing offer.
      const state = getState();
      const activeCh = state.channels[state.activeChannelId];
      if (!activeCh || !activeCh.is_dm) return;
      const sess = getSession(activeCh.id);
      if (!sess || sess.phase !== "offered") return;
      declineSecret(activeCh.id);
      renderSecretBanner();
      renderChannelHeader(activeCh);
    });

    // The 🔒 button in the DM header.
    $("#secret-btn").addEventListener("click", async () => {
      const state = getState();
      const ch = state.channels[state.activeChannelId];
      if (!ch || !ch.is_dm) return;
      const sess = getSession(ch.id);

      if (sess && sess.phase === "active") {
        // Session active → show safety number modal.
        openSafetyModal(ch.id, sess);
        return;
      }

      // No active session → initiate one.
      if (sess && sess.phase === "offered") return; // already pending, wait
      if (sess && sess.phase === "ended") clearEndedSession(ch.id); // stale view — clear it first

      const otherId = otherDMParticipant(ch, state.me && state.me.id);
      const peer = otherId && state.users[otherId];
      const peerKey = peer && peer.identity_key;

      // Ensure our own key is published before offering.
      await publishMyKeyIfNeeded();

      try {
        await initiateSecret(ch.id, otherId, peerKey);
        renderSecretBanner();
      } catch (e) {
        alert("Secret chat: " + (e && e.message));
      }
    });

    // Safety number modal.
    $("#safety-close").addEventListener("click", () => { $("#safety-modal").hidden = true; });
    $("#safety-modal").addEventListener("click", (e) => {
      if (e.target === $("#safety-modal")) $("#safety-modal").hidden = true;
    });

    // End session button inside the safety number modal.
    $("#safety-end-btn").addEventListener("click", () => {
      const state = getState();
      const ch = state.channels[state.activeChannelId];
      if (!ch || !ch.is_dm) return;
      $("#safety-modal").hidden = true;
      endSecret(ch.id);
    });

    // Mark-as-verified button inside the safety number modal.
    $("#safety-verify-btn").addEventListener("click", async () => {
      const state = getState();
      const ch = state.channels[state.activeChannelId];
      if (!ch || !ch.is_dm) return;
      const sess = getSession(ch.id);
      if (!sess) return;
      const otherId = otherDMParticipant(ch, state.me && state.me.id);
      await markVerified(otherId, sess.peerIdKeyB64);
      sess.verified = true;
      renderChannelHeader(ch);
      renderMessages();
      // Update modal display.
      const statusEl = $("#safety-status");
      statusEl.textContent = "Verified";
      statusEl.className = "safety-status verified";
      $("#safety-verify-btn").hidden = true;
    });
  }

  async function openSafetyModal(dmChannelId, sess) {
    const state = getState();
    const ch = state.channels[dmChannelId];
    const otherId = otherDMParticipant(ch, state.me && state.me.id);
    const peer = otherId && state.users[otherId];
    const peerName = peer ? (peer.display_name || peer.username) : "them";
    $("#safety-title").textContent = "Safety number with " + peerName;
    $("#safety-peer-name").textContent = peerName;
    $("#safety-number").textContent = "Computing…";
    const modal = $("#safety-modal");
    modal.hidden = false;
    try {
      const myKeyB64 = await getMyPubKeyB64();
      const number = await computeSafetyNumber(state.me.id, myKeyB64, otherId, sess.peerIdKeyB64);
      $("#safety-number").textContent = number;
    } catch (e) {
      $("#safety-number").textContent = "(unavailable)";
    }
    const statusEl = $("#safety-status");
    if (sess.verified) {
      statusEl.textContent = "Verified";
      statusEl.className = "safety-status verified";
      $("#safety-verify-btn").hidden = true;
    } else {
      statusEl.textContent = "Not verified";
      statusEl.className = "safety-status";
      $("#safety-verify-btn").hidden = false;
    }
  }

  // getSecretRequest exposes the pending incoming request (or null) so the DM list
  // can mark the channel it's on. Read-only — the banner owns all transitions.
  function getSecretRequest() {
    return secretRequestState;
  }

  return { onSecretEvent, renderSecretBanner, wireSecretControls, getSecretRequest, publishMyKey: publishMyKeyIfNeeded };
}
