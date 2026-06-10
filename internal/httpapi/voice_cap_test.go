package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	"rivendell/internal/store"
)

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

	conn1, r1 := wsDial(t, ts, adminC)
	defer conn1.Close()
	conn2, r2 := wsDial(t, ts, c2)
	defer conn2.Close()
	conn3, r3 := wsDial(t, ts, c3)
	defer conn3.Close()

	// First two joins fill the channel; each joiner sees its own voice.state.
	wsSend(t, conn1, map[string]any{"type": "voice.join", "channel_id": ch.ID})
	wsExpect(t, conn1, r1, "voice.state")
	wsSend(t, conn2, map[string]any{"type": "voice.join", "channel_id": ch.ID})
	wsExpect(t, conn2, r2, "voice.state")

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

	adminC, _ := seedAdmin(t, ts, st)
	c2, u2 := seedMember(t, ts, st, "frodo", "Frodo", store.RoleMember)

	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "voice"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create channel: %d %s", resp.StatusCode, body)
	}
	var ch store.Channel
	json.Unmarshal(body, &ch)

	conn1, r1 := wsDial(t, ts, adminC)
	defer conn1.Close()
	conn2, r2 := wsDial(t, ts, c2)
	defer conn2.Close()

	wsSend(t, conn1, map[string]any{"type": "voice.join", "channel_id": ch.ID})
	wsExpect(t, conn1, r1, "voice.state")
	wsSend(t, conn2, map[string]any{"type": "voice.join", "channel_id": ch.ID})
	wsExpect(t, conn2, r2, "voice.state")

	// First camera-on succeeds.
	wsSend(t, conn1, map[string]any{"type": "voice.mute", "channel_id": ch.ID, "video_muted": false})
	wsExpect(t, conn1, r1, "voice.state")

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
