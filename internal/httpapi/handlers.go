package httpapi

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"rivendell/internal/config"
	"rivendell/internal/ws"
)

var (
	reUsername  = regexp.MustCompile(`^[a-z0-9_]{2,32}$`)
	reChannel   = regexp.MustCompile(`^[a-z0-9-]{1,48}$`)
	reShortcode = regexp.MustCompile(`^[a-z0-9_]{2,32}$`)
	validStatus = map[string]bool{
		"online": true, "away": true, "dnd": true, "offline": true,
	}
	// validThemes mirrors the theme set the web client knows how to paint
	// (web/static/style.css). 'default' is the built-in dark theme. Keep these
	// in sync when adding a theme; the DB column is unconstrained TEXT.
	validThemes = map[string]bool{
		"default": true, "light": true, "forest": true,
		"hotpink": true, "contrast": true, "vermillion": true,
		"cool-blue": true,
	}
)

// --- health --------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.st.Ping(r.Context()); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleInstance reports public, unauthenticated instance metadata (the display
// name) so the web client can brand itself before login.
func (s *Server) handleInstance(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"name":    s.cfg.InstanceName,
		"version": config.Version,
		// Upload size ceilings so the client can reject oversized files before
		// spending the upload bandwidth (the server still enforces these).
		"max_image_bytes":  s.cfg.MaxImageBytes,
		"max_avatar_bytes": s.cfg.MaxAvatarBytes,
		// When true, the client auto-enables WebRTC debug telemetry capture for
		// every call (no per-client ?rtcdebug flag needed) — lets the operator flip
		// on instrumentation for all participants during a debugging window.
		"debug_telemetry": s.cfg.DebugTelemetry,
	})
}

// --- voice / WebRTC -------------------------------------------------------

// handleGetVoiceState returns all accessible voice channels with their current
// participants. Called on client boot to seed the sidebar voice rosters.
func (s *Server) handleGetVoiceState(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	all := s.hub.VoiceAllChannels()
	type entry struct {
		ChannelID    int64                 `json:"channel_id"`
		Participants []ws.VoiceParticipant `json:"participants"`
	}
	out := []entry{}
	for chID, pts := range all {
		if len(pts) == 0 {
			continue
		}
		ch, err := s.st.GetChannel(r.Context(), chID)
		if err != nil {
			continue
		}
		if !s.canAccessChannel(r, ch, u) {
			continue
		}
		out = append(out, entry{ChannelID: chID, Participants: pts})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleGetVoiceParticipants lists who is currently in a voice channel.
func (s *Server) handleGetVoiceParticipants(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	ch, ok := s.requireChannelAccess(w, r, u)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, s.hub.VoiceParticipants(ch.ID))
}

// handleGetRTCCredentials returns a short-lived STUN/TURN credential pair for
// use in RTCPeerConnection iceServers config. The TURN credential uses coturn's
// time-limited "REST" model: username = "<expiry>:<user_id>", credential =
// base64(HMAC-SHA1(secret, username)). coturn computes the MAC with SHA1, so
// this must be SHA1 (not SHA256) or every credential is rejected.
// RIVENDELL_TURN_URL may list several URLs (comma-separated, e.g. a turn: and a
// turns: endpoint) — they all share the one credential. If TURN is not
// configured, only the STUN URL is returned.
func (s *Server) handleGetRTCCredentials(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	resp := map[string]any{
		"stun": s.cfg.StunURL,
	}
	if s.cfg.TurnURL != "" && s.cfg.TurnSecret != "" {
		expires := time.Now().Add(time.Hour).Unix()
		username := fmt.Sprintf("%d:%d", expires, u.ID)
		mac := hmac.New(sha1.New, []byte(s.cfg.TurnSecret))
		mac.Write([]byte(username))
		turn := []string{}
		for _, raw := range strings.Split(s.cfg.TurnURL, ",") {
			if v := strings.TrimSpace(raw); v != "" {
				turn = append(turn, v)
			}
		}
		resp["turn"] = turn
		resp["username"] = username
		resp["credential"] = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	}
	writeJSON(w, http.StatusOK, resp)
}

// --- websocket -----------------------------------------------------------

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	u, ok := s.currentUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	conn, err := ws.Accept(w, r)
	if err != nil {
		return // handshake failed; Accept wrote nothing usable
	}
	// Greet the connection with the server version so the client can notice it's
	// running an older build (e.g. after a deploy) and offer to reload.
	hello, _ := json.Marshal(event{Type: "hello", Payload: map[string]string{"version": config.Version}})
	// Replay any ring that's still pending for this user but was placed while they
	// had no socket — a callee who comes online mid-ring still gets the call.
	// These target only this fresh connection (welcome frames are per-connection),
	// so siblings already ringing aren't disturbed.
	welcome := append([][]byte{hello}, s.pendingRingFrames(u.ID)...)
	s.hub.Serve(conn, u.ID, welcome...)
}
