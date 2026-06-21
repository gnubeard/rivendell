package httpapi

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"rivendell/internal/store"
	"rivendell/internal/ws"
)

// broadcastVoiceState fans a voice.state out to a channel's audience, stamped
// with the hub's monotonic seq so receivers can drop a reordered (stale) snapshot
// — the broadcasts originate from per-connection goroutines and a snapshot taken
// under lock is sent after release, so logically-older state can arrive last (see
// Hub.voiceSeq / docs/testing/call-ui-video-staleness.md). Every voice.state
// broadcast MUST go through here so the seq is always present.
func (s *Server) broadcastVoiceState(channelID int64, participants any, seq uint64, aud map[int64]bool) {
	s.broadcast("voice.state", map[string]any{
		"channel_id":   channelID,
		"participants": participants,
		"seq":          seq,
	}, aud)
}

// voiceReconnectGrace is how long a DM call is held open after a participant's WS
// drops before it's torn down. A network change (e.g. wifi↔cellular) kills the
// signaling WebSocket — which can't migrate across the path change — while the
// WebRTC media survives via ICE restart; without a grace window the WS death
// alone would drop an otherwise-healthy call (see
// docs/history/call-drop-investigation.md). A var, not a const, so tests can
// shorten it.
var voiceReconnectGrace = 20 * time.Second

// cleanupVoiceForUser handles a user's voice membership when their last WS
// connection drops. A DM call with the other party still present is NOT ended on
// the spot: the user is left in the roster and given a reconnection grace window
// (scheduleDMTeardown), because a dropped WS is usually a transient network
// change the peer-to-peer media rides out via ICE restart. A group channel — or a
// solo DM (a ringer who never connected) — drops the user immediately, since
// losing one participant doesn't strand anyone in a one-person call.
func (s *Server) cleanupVoiceForUser(ctx context.Context, userID int64) {
	// Snapshot WITHOUT removing: the grace path needs the user kept in the roster.
	for chID, participants := range s.hub.VoiceChannelsForUser(userID) {
		ch, err := s.st.GetChannel(ctx, chID)
		if err != nil {
			continue
		}
		if ch.IsDM && len(participants) > 1 {
			// The other party is still here — defer the teardown.
			s.scheduleDMTeardown(ch, userID)
			continue
		}
		remaining, seq := s.hub.VoiceLeave(chID, userID)
		s.broadcastVoiceState(chID, remaining, seq, s.audienceForChannel(ctx, ch))
	}
}

// scheduleDMTeardown arms (or re-arms) the reconnection grace timer for a user
// whose WS dropped mid-DM-call. The user stays in the voice roster so the call
// keeps running for the other party meanwhile; if the user reconnects and
// re-announces voice membership within voiceReconnectGrace, cancelDMTeardown
// stops the timer and the call continues seamlessly. Otherwise the timer ends
// the call for both parties (and removes the absent user via VoiceClear).
func (s *Server) scheduleDMTeardown(ch store.Channel, userID int64) {
	key := voiceGraceKey{ch.ID, userID}
	s.voiceGraceMu.Lock()
	defer s.voiceGraceMu.Unlock()
	if t, ok := s.voiceGraceTimers[key]; ok {
		t.Stop() // a fresh drop restarts the clock
	}
	s.voiceGraceTimers[key] = time.AfterFunc(voiceReconnectGrace, func() {
		s.voiceGraceMu.Lock()
		delete(s.voiceGraceTimers, key)
		s.voiceGraceMu.Unlock()
		// The window expired without a re-announce. End the call only if the user
		// is still listed — the other party may have hung up in the meantime, which
		// already cleared the channel (avoids a duplicate "Call ended").
		if s.hub.VoiceHasUser(ch.ID, userID) {
			s.endDMVoiceCall(ch, userID, true)
		}
	})
}

// cancelDMTeardown stops a pending reconnection grace timer for (channelID,
// userID), if any. Called when the user re-announces voice membership after a
// reconnect: the call is alive and must not be torn down.
func (s *Server) cancelDMTeardown(channelID, userID int64) {
	key := voiceGraceKey{channelID, userID}
	s.voiceGraceMu.Lock()
	if t, ok := s.voiceGraceTimers[key]; ok {
		t.Stop()
		delete(s.voiceGraceTimers, key)
	}
	s.voiceGraceMu.Unlock()
}

// endDMVoiceCall evicts everyone from a DM voice channel and tells every former
// participant other than leaverID to tear down their side (voice.end). DM calls
// are 2-party and phone-call style: either party hanging up — or dropping — ends
// the call for both, so nobody is left alone in a one-person "call". The leaver
// has already torn down locally, so they're skipped. wasActive is true when both
// parties were connected (the call was fully established), which gates the "Call
// ended" log entry so solo rings don't produce an orphaned "ended" line.
//
// Belt-and-suspenders: we also broadcast voice.state with an empty participants
// list. If voice.end is lost in transit (e.g. the recipient's WS connection
// drops between the targeted send and reconnect), the state broadcast gives the
// surviving client a second chance to detect the call ended — onVoiceState
// treats an empty roster as a server-side teardown and calls endCallLocally.
func (s *Server) endDMVoiceCall(ch store.Channel, leaverID int64, wasActive bool) {
	// A DM call ending here is now one of: an explicit hangup (voice.leave), or a
	// reconnection grace window that expired without the dropped party coming back
	// (scheduleDMTeardown). A transient WS drop on a network change no longer ends
	// the call on the spot — that earlier behavior killed otherwise-healthy calls
	// when a phone switched networks (media survived via ICE restart but the WS
	// couldn't migrate; the WS death alone tore the call down). leaverStillConnected
	// distinguishes a clean hangup (true) from a drop that outlived its grace (false).
	log.Printf("endDMVoiceCall: ch=%d leaver=%d wasActive=%v leaverStillConnected=%v", ch.ID, leaverID, wasActive, s.hub.IsConnected(leaverID))
	ids, seq := s.hub.VoiceClear(ch.ID)
	endMsg, err := json.Marshal(event{Type: "voice.end", Payload: map[string]int64{"channel_id": ch.ID}})
	if err != nil {
		return
	}
	for _, id := range ids {
		if id == leaverID {
			continue
		}
		s.hub.SendToUser(id, endMsg)
	}
	s.broadcastVoiceState(ch.ID, []ws.VoiceParticipant{}, seq, s.audienceForChannel(context.Background(), ch))
	if wasActive {
		s.postSystemMessage(context.Background(), ch, "Call ended")
	}
}

// postSystemMessage creates a system message in a channel and broadcasts it to
// the channel's audience. Used for server-generated log entries (e.g. call
// started / call ended in DMs).
func (s *Server) postSystemMessage(ctx context.Context, ch store.Channel, content string) {
	msg, err := s.st.CreateSystemMessage(ctx, ch.ID, content)
	if err != nil {
		log.Printf("postSystemMessage: %v", err)
		return
	}
	s.broadcast("message.new", msg, s.audienceForChannel(ctx, ch))
}

// onWSMessage is called by the hub for each inbound client frame. Handles
// "typing", "idle", and "voice.*" frames; anything else is silently ignored.
// Idle is kept on the WS (not a REST call) so it's scoped to this connection.
func (s *Server) onWSMessage(c *ws.Client, data []byte) {
	var msg struct {
		Type        string `json:"type"`
		ChannelID   int64  `json:"channel_id"`
		DMChannelID int64  `json:"dm_channel_id"`
		ToUserID    int64  `json:"to_user_id"`
		Idle        bool   `json:"idle"`
		Muted       bool   `json:"muted"`
		VideoMuted  bool   `json:"video_muted"`
		Sharing     bool   `json:"sharing"`
		Accept      bool   `json:"accept"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}
	userID := c.UserID()
	if msg.Type == "idle" {
		if s.hub.SetClientIdle(c, msg.Idle) {
			s.onPresenceChange(userID, true)
		}
		return
	}
	if strings.HasPrefix(msg.Type, "voice.") {
		s.handleVoiceWSMessage(c, data, msg.Type, msg.ChannelID, msg.DMChannelID, msg.ToUserID, msg.Muted, msg.VideoMuted, msg.Sharing, msg.Accept)
		return
	}
	if strings.HasPrefix(msg.Type, "secret.") {
		s.handleSecretWSMessage(c, data, msg.Type, msg.DMChannelID)
		return
	}
	if msg.Type != "typing" || msg.ChannelID == 0 {
		return
	}
	ctx := context.Background()
	ch, err := s.st.GetChannel(ctx, msg.ChannelID)
	if err != nil {
		return
	}
	audience := s.audienceForChannel(ctx, ch)
	// For private channels/DMs, reject typing events from non-members.
	if ch.IsPrivate && !audience[userID] {
		return
	}
	s.broadcast("typing.update", map[string]any{
		"channel_id": ch.ID,
		"user_id":    userID,
		"active":     true,
	}, audience)
	key := typingKey{ch.ID, userID}
	s.typingMu.Lock()
	if t, ok := s.typingTimers[key]; ok {
		t.Stop()
	}
	s.typingTimers[key] = time.AfterFunc(2*time.Second, func() {
		s.typingMu.Lock()
		delete(s.typingTimers, key)
		s.typingMu.Unlock()
		s.broadcast("typing.update", map[string]any{
			"channel_id": ch.ID,
			"user_id":    userID,
			"active":     false,
		}, audience)
	})
	s.typingMu.Unlock()
}

// handleVoiceWSMessage routes voice.* frames from clients. Point-to-point
// frames (offer/answer/ice/ring/ring_response) are relayed with from_user_id
// injected; state-change frames (join/leave/mute) update in-memory voice state
// and fan out voice.state to the channel audience.
func (s *Server) handleVoiceWSMessage(c *ws.Client, raw []byte, msgType string, channelID, dmChannelID, toUserID int64, muted, videoMuted, sharing, accept bool) {
	userID := c.UserID()
	ctx := context.Background()

	// relayToUser re-encodes the client frame as a server event envelope, injects
	// from_user_id (plus any extra fields), and delivers it to a specific user.
	relayToUser := func(targetID int64, extra map[string]any) {
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(raw, &payload); err != nil {
			return
		}
		delete(payload, "type")
		fromBytes, _ := json.Marshal(userID)
		payload["from_user_id"] = fromBytes
		for k, v := range extra {
			if b, err := json.Marshal(v); err == nil {
				payload[k] = b
			}
		}
		out, err := json.Marshal(event{Type: msgType, Payload: payload})
		if err != nil {
			return
		}
		s.hub.SendToUser(targetID, out)
	}

	// canAccess checks whether a user may participate in the channel. It delegates
	// to channelVisibleTo so voice uses the SAME visibility predicate as message
	// read / audience / access — there's no second copy to drift (admins, not
	// moderators, see private non-DM channels; DMs stay members-only). The public
	// fast-path avoids a user lookup; a lookup error on a private channel fails
	// CLOSED (an auth check must never fall open).
	canAccess := func(ch store.Channel, uid int64) bool {
		if !ch.IsPrivate {
			return true
		}
		u, err := s.st.GetUserByID(ctx, uid)
		if err != nil {
			return false
		}
		return s.channelVisibleTo(ctx, ch, u)
	}

	// denyJoin tells the joiner the channel (or its video slots) is full. The
	// client aborts the join, or — for "video_full" — falls back to audio-only.
	denyJoin := func(reason string, limit int) {
		out, err := json.Marshal(event{Type: "voice.join_denied", Payload: map[string]any{
			"channel_id": channelID, "reason": reason, "limit": limit,
		}})
		if err == nil {
			s.hub.SendToUser(userID, out)
		}
	}

	switch msgType {
	case "voice.join":
		if channelID == 0 {
			return
		}
		ch, err := s.st.GetChannel(ctx, channelID)
		if err != nil || !canAccess(ch, userID) {
			return
		}
		// A re-announce after a reconnect cancels any pending teardown the user's
		// earlier WS drop armed (see scheduleDMTeardown) — the call is alive.
		s.cancelDMTeardown(channelID, userID)
		// Group cap: a non-DM voice channel holds at most MaxVoiceAudio users.
		// DMs are exempt (strictly two parties, gated by the ring flow). Exclude
		// the joiner so an idempotent re-join of a channel they're already in
		// isn't denied at the boundary.
		if !ch.IsDM && s.cfg.MaxVoiceAudio > 0 {
			if total, _ := s.hub.VoiceCounts(channelID, userID); total >= s.cfg.MaxVoiceAudio {
				denyJoin("full", s.cfg.MaxVoiceAudio)
				return
			}
		}
		// Auto-leave any other voice channels first.
		leftAll, leftSeq := s.hub.VoiceLeaveAll(userID)
		for chID, pts := range leftAll {
			if chID == channelID {
				continue
			}
			oldCh, err := s.st.GetChannel(ctx, chID)
			if err != nil {
				continue
			}
			s.broadcastVoiceState(chID, pts, leftSeq, s.audienceForChannel(ctx, oldCh))
		}
		participants, seq := s.hub.VoiceJoin(channelID, userID)
		aud := s.audienceForChannel(ctx, ch)
		s.broadcastVoiceState(channelID, participants, seq, aud)
		if ch.IsDM && len(participants) == 2 {
			s.postSystemMessage(ctx, ch, "Call started")
		}

	case "voice.leave":
		if channelID == 0 {
			return
		}
		ch, err := s.st.GetChannel(ctx, channelID)
		if err != nil {
			return
		}
		if ch.IsDM {
			// Phone-call semantics: hanging up ends the DM call for both parties.
			// wasActive is true when the leaver is still in the hub (not yet cleared),
			// meaning both parties were connected.
			wasActive := len(s.hub.VoiceParticipants(channelID)) >= 2
			s.endDMVoiceCall(ch, userID, wasActive)
			return
		}
		participants, seq := s.hub.VoiceLeave(channelID, userID)
		aud := s.audienceForChannel(ctx, ch)
		s.broadcastVoiceState(channelID, participants, seq, aud)

	case "voice.offer", "voice.answer", "voice.ice":
		if channelID == 0 || toUserID == 0 {
			return
		}
		ch, err := s.st.GetChannel(ctx, channelID)
		if err != nil || !canAccess(ch, userID) || !canAccess(ch, toUserID) {
			return
		}
		relayToUser(toUserID, nil)

	case "voice.mute":
		if channelID == 0 {
			return
		}
		ch, err := s.st.GetChannel(ctx, channelID)
		if err != nil || !canAccess(ch, userID) {
			return
		}
		// Video sub-cap: in a group channel only MaxVoiceVideo cameras may be on
		// at once. If turning a camera on would exceed it, force this user back to
		// video-muted and tell them (the client reverts the toggle, audio-only).
		// DMs are exempt. videoOn excludes the requester so re-asserting an
		// already-on camera is never denied.
		if !ch.IsDM && !videoMuted && s.cfg.MaxVoiceVideo > 0 {
			if _, videoOn := s.hub.VoiceCounts(channelID, userID); videoOn >= s.cfg.MaxVoiceVideo {
				videoMuted = true
				denyJoin("video_full", s.cfg.MaxVoiceVideo)
			}
		}
		// A forced video-mute (sub-cap) also drops the sharing flag — you can't be
		// sharing a screen if your video slot was just denied.
		if videoMuted {
			sharing = false
		}
		participants, seq := s.hub.VoiceSetMute(channelID, userID, muted, videoMuted, sharing)
		aud := s.audienceForChannel(ctx, ch)
		s.broadcastVoiceState(channelID, participants, seq, aud)

	case "voice.ring":
		if dmChannelID == 0 {
			return
		}
		ch, err := s.st.GetChannel(ctx, dmChannelID)
		if err != nil || !ch.IsDM {
			return
		}
		ids, err := s.st.ListChannelMemberIDs(ctx, ch.ID)
		if err != nil || len(ids) != 2 {
			return
		}
		var calleeID int64
		callerOK := false
		for _, id := range ids {
			if id == userID {
				callerOK = true
			} else {
				calleeID = id
			}
		}
		if !callerOK || calleeID == 0 {
			return
		}
		// Cancel any existing ring for this DM and start a new one.
		s.ringMu.Lock()
		if r, ok := s.rings[dmChannelID]; ok {
			r.timer.Stop()
		}
		ring := &activeRing{callerID: userID, calleeID: calleeID}
		chIDCopy := dmChannelID
		ring.timer = time.AfterFunc(30*time.Second, func() {
			s.ringMu.Lock()
			if r, ok := s.rings[chIDCopy]; ok && r == ring {
				delete(s.rings, chIDCopy)
			}
			s.ringMu.Unlock()
			tout, _ := json.Marshal(event{Type: "voice.ring_timeout", Payload: map[string]int64{"dm_channel_id": chIDCopy}})
			s.hub.SendToUser(userID, tout)
			s.hub.SendToUser(calleeID, tout)
		})
		s.rings[dmChannelID] = ring
		s.ringMu.Unlock()
		// Embed the caller's name so the callee's ring banner/OS notification can
		// always name them, even when their client hasn't loaded the caller into
		// its roster yet (e.g. a ring replayed onto a freshly-opened socket before
		// the user list finishes loading) — otherwise it falls back to "Someone".
		relayToUser(calleeID, map[string]any{"from_display_name": s.callerName(ctx, userID)})

	case "voice.ring_response":
		if dmChannelID == 0 {
			return
		}
		ch, err := s.st.GetChannel(ctx, dmChannelID)
		if err != nil || !ch.IsDM {
			return
		}
		ids, err := s.st.ListChannelMemberIDs(ctx, ch.ID)
		if err != nil || len(ids) != 2 {
			return
		}
		var otherID int64
		selfOK := false
		for _, id := range ids {
			if id == userID {
				selfOK = true
			} else {
				otherID = id
			}
		}
		if !selfOK || otherID == 0 {
			return
		}
		s.ringMu.Lock()
		if r, ok := s.rings[dmChannelID]; ok {
			r.timer.Stop()
			delete(s.rings, dmChannelID)
		}
		s.ringMu.Unlock()
		relayToUser(otherID, nil)
		// Multi-login: every one of the responder's connections was rung
		// (SendToUser fans out), but only this one answered/declined. Tell the
		// others to stop ringing. This is a dismiss, NOT a relayed
		// ring_response — echoing accept:true would make a second tab also join
		// the call. The connection that answered already cleared its own ring
		// locally, so it treats this as a harmless no-op.
		dismiss, _ := json.Marshal(event{Type: "voice.ring_dismissed", Payload: map[string]int64{"dm_channel_id": dmChannelID}})
		s.hub.SendToUser(userID, dismiss)
	}
}

// pendingRingFrames returns voice.ring frames for every non-expired ring whose
// callee is userID. A one-shot voice.ring is dropped if the callee has no socket
// at that instant (relayToUser fans out to live connections only), so a caller
// could ring a friend who is about to connect and they'd never see it. handleWS
// replays these as welcome frames on each fresh connection, so a callee who comes
// online mid-ring still gets it. The per-ring timeout timer is left untouched, so
// the replay honours the original deadline (its residual TTL) — not a fresh 30s.
func (s *Server) pendingRingFrames(userID int64) [][]byte {
	s.ringMu.Lock()
	defer s.ringMu.Unlock()
	var frames [][]byte
	for chID, r := range s.rings {
		if r.calleeID != userID {
			continue
		}
		// Faithfully reconstruct what relayToUser would have delivered live:
		// {dm_channel_id, from_user_id, from_display_name} under a voice.ring
		// envelope. The name matters most here: a replayed ring lands on a socket
		// that has only just opened, before its user roster has loaded.
		frame, err := json.Marshal(event{Type: "voice.ring", Payload: map[string]any{
			"dm_channel_id":     chID,
			"from_user_id":      r.callerID,
			"from_display_name": s.callerName(context.Background(), r.callerID),
		}})
		if err != nil {
			continue
		}
		frames = append(frames, frame)
	}
	return frames
}

// callerName resolves a user's best display label (display name, falling back to
// username) for embedding in a ring frame, so the callee can always name the
// caller without depending on its own loaded roster. Best-effort: an empty string
// on lookup failure lets the client fall back to its roster / "Someone".
func (s *Server) callerName(ctx context.Context, userID int64) string {
	u, err := s.st.GetUserByID(ctx, userID)
	if err != nil {
		return ""
	}
	if u.DisplayName != "" {
		return u.DisplayName
	}
	return u.Username
}

// handleSecretWSMessage routes secret.* frames from clients. All frames are
// relayed opaquely between the two DM members — the server never sees plaintext
// or keys. secret.accept additionally dismisses the acceptor's sibling sessions
// (same pattern as voice.ring_response / voice.ring_dismissed).
func (s *Server) handleSecretWSMessage(c *ws.Client, raw []byte, msgType string, dmChannelID int64) {
	if dmChannelID == 0 {
		return
	}
	userID := c.UserID()
	ctx := context.Background()

	ch, err := s.st.GetChannel(ctx, dmChannelID)
	if err != nil || !ch.IsDM {
		return
	}
	ids, err := s.st.ListChannelMemberIDs(ctx, ch.ID)
	if err != nil || len(ids) != 2 {
		return
	}
	var otherID int64
	selfOK := false
	for _, id := range ids {
		if id == userID {
			selfOK = true
		} else {
			otherID = id
		}
	}
	if !selfOK || otherID == 0 {
		return
	}

	relayToUser := func(targetID int64) {
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(raw, &payload); err != nil {
			return
		}
		delete(payload, "type")
		fromBytes, _ := json.Marshal(userID)
		payload["from_user_id"] = fromBytes
		out, err := json.Marshal(event{Type: msgType, Payload: payload})
		if err != nil {
			return
		}
		s.hub.SendToUser(targetID, out)
	}

	switch msgType {
	case "secret.offer", "secret.msg", "secret.end":
		relayToUser(otherID)
	case "secret.accept":
		relayToUser(otherID)
		// Dismiss the acceptor's other open tabs so they don't stay in request state.
		dismiss, _ := json.Marshal(event{Type: "secret.dismiss", Payload: map[string]int64{"dm_channel_id": dmChannelID}})
		s.hub.SendToUser(userID, dismiss)
	}
}
