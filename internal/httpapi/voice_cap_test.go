package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"rivendell/internal/store"
)

// TestVoiceJoinPrivateChannelVisibility pins that the voice WS path gates access
// through the SAME visibility predicate as everything else (channelVisibleTo):
// admins get the private-channel override, moderators do NOT. The regression had
// the voice canAccess closure use RoleModerator while the canonical predicate uses
// RoleAdmin, letting a non-member moderator sit in a private channel's call they
// couldn't otherwise see.
func TestVoiceJoinPrivateChannelVisibility(t *testing.T) {
	ts, st, _, srv := newTestServerSrv(t)
	ctx := context.Background()

	adminC, admin := seedAdmin(t, ts, st)                                     // RoleAdmin, NOT a member
	modC, mod := seedMember(t, ts, st, "molly", "Molly", store.RoleModerator) // NOT a member
	_, owner := seedMember(t, ts, st, "sam", "Sam", store.RoleMember)         // the channel's member

	priv, err := st.CreateChannel(ctx, "secret-room", "", true, owner.ID)
	if err != nil {
		t.Fatalf("create private channel: %v", err)
	}
	if err := st.AddChannelMember(ctx, priv.ID, owner.ID); err != nil {
		t.Fatalf("add member: %v", err)
	}
	pub, err := st.CreateChannel(ctx, "lobby", "", false, owner.ID)
	if err != nil {
		t.Fatalf("create public channel: %v", err)
	}

	adminConn, _ := wsDial(t, ts, adminC)
	defer adminConn.Close()
	modConn, _ := wsDial(t, ts, modC)
	defer modConn.Close()

	// An admin who is NOT a member IS admitted to the private channel's voice.
	wsSend(t, adminConn, map[string]any{"type": "voice.join", "channel_id": priv.ID})
	waitVoiceRoster(t, srv, priv.ID, 1)

	// A moderator who is NOT a member must be denied. A denied voice.join returns
	// before the join commits (and before VoiceLeaveAll), so the moderator must
	// never appear in the roster — under the regression it would, within ms.
	wsSend(t, modConn, map[string]any{"type": "voice.join", "channel_id": priv.ID})
	assertNotInVoice(t, srv, priv.ID, mod.ID, 300*time.Millisecond)

	// Liveness: prove the moderator's frames are actually processed (so the
	// negative assertion above can't be a false pass from a dropped frame) — a
	// public-channel join IS allowed and shows up in the roster.
	wsSend(t, modConn, map[string]any{"type": "voice.join", "channel_id": pub.ID})
	waitVoiceRoster(t, srv, pub.ID, 1)

	// The private roster still holds exactly the admin.
	if parts := srv.hub.VoiceParticipants(priv.ID); len(parts) != 1 || parts[0].UserID != admin.ID {
		t.Fatalf("private voice roster should be [admin %d], got %+v", admin.ID, parts)
	}
}

// assertNotInVoice fails if userID appears in chID's voice roster within d.
func assertNotInVoice(t *testing.T, srv *Server, chID, userID int64, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		for _, p := range srv.hub.VoiceParticipants(chID) {
			if p.UserID == userID {
				t.Fatalf("user %d must not be in voice for channel %d (join should be denied)", userID, chID)
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// TestVoiceJoinDeniedWhenFull guards the group-call audio cap: a non-DM voice
// channel admits at most cfg.MaxVoiceAudio participants; the next joiner gets a
// voice.join_denied{reason:"full"} frame instead of joining.
func TestVoiceJoinDeniedWhenFull(t *testing.T) {
	ts, st, _, srv := newTestServerSrv(t)
	srv.cfg.MaxVoiceAudio = 2 // shrink the cap so two joiners fill the channel

	adminC, _ := seedAdmin(t, ts, st)
	c2, _ := seedMember(t, ts, st, "frodo", "Frodo", store.RoleMember)
	c3, _ := seedMember(t, ts, st, "sam", "Sam", store.RoleMember)

	// A public channel — everyone may access, so the cap (not membership) is
	// what's under test.
	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "voice"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create channel: %d %s", resp.StatusCode, body)
	}
	var ch store.Channel
	json.Unmarshal(body, &ch)

	conn1, _ := wsDial(t, ts, adminC)
	defer conn1.Close()
	conn2, _ := wsDial(t, ts, c2)
	defer conn2.Close()
	conn3, r3 := wsDial(t, ts, c3)
	defer conn3.Close()

	// First two joins fill the channel. Gate on the hub roster — not on the
	// joiner's own voice.state frame, which is ambiguous: every join broadcasts to
	// the whole channel audience, so conn2's queue already holds conn1's-join
	// voice.state and a wsExpect would match that before conn2's own join commits,
	// racing the over-cap join ahead of a full roster. See waitVoiceRoster.
	wsSend(t, conn1, map[string]any{"type": "voice.join", "channel_id": ch.ID})
	waitVoiceRoster(t, srv, ch.ID, 1)
	wsSend(t, conn2, map[string]any{"type": "voice.join", "channel_id": ch.ID})
	waitVoiceRoster(t, srv, ch.ID, 2)

	// The third join is over the cap — denied, not admitted.
	wsSend(t, conn3, map[string]any{"type": "voice.join", "channel_id": ch.ID})
	wsExpect(t, conn3, r3, "voice.join_denied")

	if got := len(srv.hub.VoiceParticipants(ch.ID)); got != 2 {
		t.Fatalf("channel should hold 2 participants after a denied join, got %d", got)
	}
}

// TestVoiceVideoSubCap guards the camera sub-cap: when MaxVoiceVideo cameras are
// already on, the next user turning a camera on is forced back to video-muted
// and told via voice.join_denied{reason:"video_full"} (audio-only fallback).
func TestVoiceVideoSubCap(t *testing.T) {
	ts, st, _, srv := newTestServerSrv(t)
	srv.cfg.MaxVoiceVideo = 1 // only one camera allowed at a time

	adminC, u1 := seedAdmin(t, ts, st)
	c2, u2 := seedMember(t, ts, st, "frodo", "Frodo", store.RoleMember)

	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "voice"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create channel: %d %s", resp.StatusCode, body)
	}
	var ch store.Channel
	json.Unmarshal(body, &ch)

	conn1, _ := wsDial(t, ts, adminC)
	defer conn1.Close()
	conn2, r2 := wsDial(t, ts, c2)
	defer conn2.Close()

	// Gate each step on committed hub state, not on broadcast frames — see
	// waitVoiceRoster for why a witnessed voice.state can't confirm a given step.
	wsSend(t, conn1, map[string]any{"type": "voice.join", "channel_id": ch.ID})
	waitVoiceRoster(t, srv, ch.ID, 1)
	wsSend(t, conn2, map[string]any{"type": "voice.join", "channel_id": ch.ID})
	waitVoiceRoster(t, srv, ch.ID, 2)

	// First camera-on succeeds; wait until it's committed so the sub-cap check
	// below actually sees a camera already on.
	wsSend(t, conn1, map[string]any{"type": "voice.mute", "channel_id": ch.ID, "video_muted": false})
	waitVoiceVideo(t, srv, ch.ID, u1.ID, true)

	// Second camera-on is over the sub-cap: denied, and the participant stays
	// video-muted server-side.
	wsSend(t, conn2, map[string]any{"type": "voice.mute", "channel_id": ch.ID, "video_muted": false})
	wsExpect(t, conn2, r2, "voice.join_denied")

	for _, p := range srv.hub.VoiceParticipants(ch.ID) {
		if p.UserID == u2.ID && !p.VideoMuted {
			t.Fatalf("user %d should remain video-muted after video_full denial", u2.ID)
		}
	}
}
