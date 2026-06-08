package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"rivendell/internal/auth"
	"rivendell/internal/config"
	"rivendell/internal/push"
	"rivendell/internal/store"
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

// --- auth ----------------------------------------------------------------

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))

	// Generic failure message to avoid user enumeration.
	const failMsg = "invalid username or password"

	u, err := s.st.GetUserByUsername(r.Context(), req.Username)
	if err != nil {
		// Run a dummy verify to keep timing roughly constant.
		_ = auth.VerifyPassword("pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", req.Password)
		writeErr(w, http.StatusUnauthorized, failMsg)
		return
	}
	if !u.IsActive {
		writeErr(w, http.StatusForbidden, "account is disabled")
		return
	}
	hash, err := s.st.GetPasswordHash(r.Context(), u.ID)
	if err != nil || hash == "" {
		writeErr(w, http.StatusUnauthorized, failMsg)
		return
	}
	if err := auth.VerifyPassword(hash, req.Password); err != nil {
		writeErr(w, http.StatusUnauthorized, failMsg)
		return
	}
	if err := s.startSession(w, r, u.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create session")
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
		_ = s.st.DeleteSession(r.Context(), auth.HashToken(c.Value))
	}
	s.clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleCheckMagic lets the client see whether a token is valid and what it's
// for, without consuming it.
func (s *Server) handleCheckMagic(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	purpose, err := s.st.PeekMagicLink(r.Context(), auth.HashToken(token))
	if err != nil {
		writeErr(w, http.StatusNotFound, "link is invalid or expired")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"purpose": purpose})
}

func (s *Server) handleSetPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Password) < 10 {
		writeErr(w, http.StatusBadRequest, "password must be at least 10 characters")
		return
	}
	userID, _, err := s.st.ConsumeMagicLink(r.Context(), auth.HashToken(req.Token))
	if err != nil {
		writeErr(w, http.StatusNotFound, "link is invalid or expired")
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not set password")
		return
	}
	if err := s.st.SetPassword(r.Context(), userID, hash); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not set password")
		return
	}
	// Log the user in immediately after they set a password.
	if err := s.startSession(w, r, userID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create session")
		return
	}
	u, err := s.st.GetUserByID(r.Context(), userID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load user")
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, userID int64) error {
	token, err := auth.NewToken()
	if err != nil {
		return err
	}
	expires := time.Now().Add(s.cfg.SessionTTL)
	if err := s.st.CreateSession(r.Context(), userID, auth.HashToken(token), r.UserAgent(), expires); err != nil {
		return err
	}
	s.setSessionCookie(w, token)
	return nil
}

// --- self ----------------------------------------------------------------

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, userFrom(r.Context()))
}

func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var req struct {
		DisplayName *string `json:"display_name"`
		StatusText  *string `json:"status_text"`
		Theme       *string `json:"theme"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	displayName := u.DisplayName
	if req.DisplayName != nil {
		displayName = strings.TrimSpace(*req.DisplayName)
		if l := len(displayName); l < 1 || l > 64 {
			writeErr(w, http.StatusBadRequest, "display name must be 1-64 characters")
			return
		}
	}
	statusText := u.StatusText
	if req.StatusText != nil {
		statusText = strings.TrimSpace(*req.StatusText)
		if len(statusText) > 128 {
			writeErr(w, http.StatusBadRequest, "status text must be at most 128 characters")
			return
		}
	}
	theme := u.Theme
	if req.Theme != nil {
		theme = *req.Theme
		if !validThemes[theme] {
			writeErr(w, http.StatusBadRequest, "invalid theme")
			return
		}
	}
	if err := s.st.UpdateProfile(r.Context(), u.ID, displayName, statusText, theme); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update profile")
		return
	}
	updated, err := s.st.GetUserByID(r.Context(), u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load user")
		return
	}
	s.broadcast("user.update", updated, nil)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleSetStatus(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var req struct {
		Status string `json:"status"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !validStatus[req.Status] {
		writeErr(w, http.StatusBadRequest, "invalid status")
		return
	}
	if err := s.st.SetStatus(r.Context(), u.ID, req.Status); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not set status")
		return
	}
	s.broadcast("presence.update", map[string]any{
		"user_id": u.ID,
		"online":  req.Status != "offline",
		"status":  req.Status,
	}, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": req.Status})
}

func (s *Server) handlePublishIdentityKey(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var req struct {
		Key string `json:"key"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Key) == 0 {
		writeErr(w, http.StatusBadRequest, "key is required")
		return
	}
	if _, err := base64.StdEncoding.DecodeString(req.Key); err != nil {
		writeErr(w, http.StatusBadRequest, "key must be valid base64")
		return
	}
	if err := s.st.SetIdentityKey(r.Context(), u.ID, req.Key); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not store identity key")
		return
	}
	updated, err := s.st.GetUserByID(r.Context(), u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load user")
		return
	}
	s.broadcast("user.update", updated, nil)
	writeJSON(w, http.StatusOK, map[string]string{"key": req.Key})
}

func (s *Server) handleUploadAvatar(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	ct := r.Header.Get("Content-Type")
	if ct != "image/png" && ct != "image/jpeg" && ct != "image/webp" && ct != "image/gif" {
		writeErr(w, http.StatusUnsupportedMediaType, "avatar must be png, jpeg, webp, or gif")
		return
	}
	body := http.MaxBytesReader(w, r.Body, int64(s.cfg.MaxAvatarBytes))
	data, err := io.ReadAll(body)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "avatar too large")
		return
	}
	if len(data) == 0 {
		writeErr(w, http.StatusBadRequest, "empty avatar")
		return
	}
	if err := s.st.SetAvatar(r.Context(), u.ID, ct, data); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save avatar")
		return
	}
	updated, _ := s.st.GetUserByID(r.Context(), u.ID)
	s.broadcast("user.update", updated, nil)
	writeJSON(w, http.StatusOK, map[string]bool{"has_avatar": true})
}

// --- users ---------------------------------------------------------------

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.st.ListUsers(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list users")
		return
	}
	online := make(map[int64]bool)
	for _, id := range s.hub.OnlineUserIDs() {
		online[id] = true
	}
	// Ordinary users don't see disabled accounts; admins see everyone since the
	// admin panel reuses this endpoint. Bots are visible to all authenticated
	// users so they appear in private-channel rosters for their members.
	showDisabled := roleRank(userFrom(r.Context()).Role) >= roleRank(store.RoleAdmin)
	type userWithPresence struct {
		store.User
		Online bool `json:"online"`
		Idle   bool `json:"idle"`
	}
	out := make([]userWithPresence, 0, len(users))
	for _, u := range users {
		if !u.IsActive && !showDisabled {
			continue
		}
		// Bots authenticate via tokens and hold no hub connection; derive their
		// online status from the stored status column rather than hub presence.
		// Regular users: invisible (status "offline") appears offline even while
		// connected — matching the presence.update broadcasts.
		var isOnline bool
		if u.IsBot {
			isOnline = u.Status == "online"
		} else {
			isOnline = online[u.ID] && u.Status != "offline"
		}
		out = append(out, userWithPresence{
			User:   u,
			Online: isOnline,
			Idle:   s.hub.IsIdle(u.ID),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleInstance reports public, unauthenticated instance metadata (the display
// name) so the web client can brand itself before login.
func (s *Server) handleInstance(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"name":    s.cfg.InstanceName,
		"version": config.Version,
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
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "access denied")
		return
	}
	writeJSON(w, http.StatusOK, s.hub.VoiceParticipants(id))
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

func (s *Server) handleGetAvatar(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	mime, data, err := s.st.GetAvatar(r.Context(), id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// --- custom emojis -------------------------------------------------------

// isImageContentType reports whether ct is one of the image formats we accept
// for user-supplied images (avatars and custom emojis).
func isImageContentType(ct string) bool {
	switch ct {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return true
	}
	return false
}

func (s *Server) handleListEmojis(w http.ResponseWriter, r *http.Request) {
	emojis, err := s.st.ListEmojis(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list emojis")
		return
	}
	writeJSON(w, http.StatusOK, emojis)
}

// handleCreateEmoji stores a custom emoji (admin only). The shortcode arrives as
// a query param and the image as the raw request body — the same upload shape as
// avatars, reusing MaxAvatarBytes as the size ceiling.
func (s *Server) handleCreateEmoji(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	shortcode := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("shortcode")))
	if !reShortcode.MatchString(shortcode) {
		writeErr(w, http.StatusBadRequest, "shortcode must be 2-32 chars of a-z, 0-9, or underscore")
		return
	}
	ct := r.Header.Get("Content-Type")
	if !isImageContentType(ct) {
		writeErr(w, http.StatusUnsupportedMediaType, "emoji must be png, jpeg, webp, or gif")
		return
	}
	body := http.MaxBytesReader(w, r.Body, int64(s.cfg.MaxAvatarBytes))
	data, err := io.ReadAll(body)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "emoji too large")
		return
	}
	if len(data) == 0 {
		writeErr(w, http.StatusBadRequest, "empty emoji")
		return
	}
	emoji, err := s.st.CreateEmoji(r.Context(), shortcode, ct, data, u.ID)
	if err != nil {
		if store.IsUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "an emoji with that shortcode already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not save emoji")
		return
	}
	// Emojis are instance-wide; everyone learns of the new shortcode in realtime
	// so it renders in messages without a refresh.
	s.broadcast("emoji.add", emoji, nil)
	writeJSON(w, http.StatusCreated, emoji)
}

func (s *Server) handleDeleteEmoji(w http.ResponseWriter, r *http.Request) {
	shortcode := strings.ToLower(r.PathValue("shortcode"))
	if err := s.st.DeleteEmoji(r.Context(), shortcode); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "emoji not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not delete emoji")
		return
	}
	s.broadcast("emoji.delete", map[string]string{"shortcode": shortcode}, nil)
	writeJSON(w, http.StatusOK, map[string]string{"shortcode": shortcode})
}

func (s *Server) handleGetEmojiImage(w http.ResponseWriter, r *http.Request) {
	shortcode := strings.ToLower(r.PathValue("shortcode"))
	mime, data, err := s.st.GetEmojiImage(r.Context(), shortcode)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mime)
	// Emojis are immutable for a given shortcode (delete + re-add to change the
	// image), so they cache well; longer than avatars since there's no per-id
	// version bust on the client.
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// --- channels ------------------------------------------------------------

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	channels, err := s.st.ListChannels(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list channels")
		return
	}
	// Which DMs this user has open is server-authoritative (the dm_open table),
	// so a new device shows only the DMs they've actually kept open, not every
	// DM they've ever started.
	openDMs, err := s.st.OpenDMChannelIDs(r.Context(), u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list channels")
		return
	}
	// Filter private channels the user can't see. Fresh non-nil slice so an
	// empty result serializes as [] (JSON null breaks the client's iteration).
	visible := make([]store.Channel, 0, len(channels))
	for _, ch := range channels {
		if !ch.IsPrivate {
			visible = append(visible, ch)
			continue
		}
		member, err := s.st.IsChannelMember(r.Context(), ch.ID, u.ID)
		isMember := err == nil && member
		// DMs are visible only to their two participants — a moderator/admin
		// must NOT see other people's DMs — and only when the participant has
		// the DM open in their sidebar.
		if ch.IsDM {
			if isMember && openDMs[ch.ID] {
				visible = append(visible, ch)
			}
			continue
		}
		if isMember || roleRank(u.Role) >= roleRank(store.RoleModerator) {
			visible = append(visible, ch)
		}
	}
	writeJSON(w, http.StatusOK, visible)
}

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var req struct {
		Name      string `json:"name"`
		Topic     string `json:"topic"`
		IsPrivate bool   `json:"is_private"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.ToLower(strings.TrimSpace(req.Name))
	if !reChannel.MatchString(req.Name) {
		writeErr(w, http.StatusBadRequest, "channel name must be 1-48 chars of a-z, 0-9, or hyphen")
		return
	}
	if len(req.Topic) > 256 {
		writeErr(w, http.StatusBadRequest, "topic must be at most 256 characters")
		return
	}
	ch, err := s.st.CreateChannel(r.Context(), req.Name, req.Topic, req.IsPrivate, u.ID)
	if err != nil {
		if store.IsUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "a channel with that name already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not create channel")
		return
	}
	// Creator joins private channels they make.
	if ch.IsPrivate {
		_ = s.st.AddChannelMember(r.Context(), ch.ID, u.ID)
	}
	s.broadcast("channel.new", ch, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusCreated, ch)
}

func (s *Server) handleUpdateChannel(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	var req struct {
		Topic    *string `json:"topic"`
		Position *int    `json:"position"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	topic := ch.Topic
	if req.Topic != nil {
		topic = *req.Topic
		if len(topic) > 256 {
			writeErr(w, http.StatusBadRequest, "topic must be at most 256 characters")
			return
		}
	}
	position := ch.Position
	if req.Position != nil {
		position = *req.Position
	}
	if err := s.st.UpdateChannel(r.Context(), id, topic, position); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update channel")
		return
	}
	updated, _ := s.st.GetChannel(r.Context(), id)
	s.broadcast("channel.update", updated, s.audienceForChannel(r.Context(), updated))
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleArchiveChannel(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if err := s.st.ArchiveChannel(r.Context(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not archive channel")
		return
	}
	s.broadcast("channel.archive", map[string]int64{"id": id}, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, map[string]string{"status": "archived"})
}

// handleCreateDM create-or-finds the two-member private channel between the
// caller and another user. Available to any authenticated user (a DM is just a
// private channel with two people in it).
func (s *Server) handleCreateDM(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var req struct {
		UserID int64 `json:"user_id"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.UserID == u.ID {
		writeErr(w, http.StatusBadRequest, "cannot start a DM with yourself")
		return
	}
	other, err := s.st.GetUserByID(r.Context(), req.UserID)
	if err != nil || !other.IsActive {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	ch, created, err := s.st.GetOrCreateDM(r.Context(), u.ID, other.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not open DM")
		return
	}
	if created {
		// A brand-new DM opens for both participants (mirroring the channel.new
		// broadcast that surfaces it on each side immediately).
		if _, err := s.st.OpenDMForAllMembers(r.Context(), ch.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not open DM")
			return
		}
		// Only announce a freshly-created DM, and only to its two members (the
		// audience scoping); the caller gets the channel in the HTTP response.
		s.broadcast("channel.new", ch, s.audienceForChannel(r.Context(), ch))
	} else if err := s.st.OpenDM(r.Context(), u.ID, ch.ID); err != nil {
		// Re-opening an existing DM (e.g. clicking a name to resurrect a closed
		// one) opens it for the caller only; the other side reopens on a message.
		writeErr(w, http.StatusInternalServerError, "could not open DM")
		return
	}
	writeJSON(w, http.StatusOK, ch)
}

// handleCloseDM hides a DM from the caller's sidebar. It's server-authoritative
// and per-user: the channel, its membership, and its history are untouched (the
// other participant is unaffected), and the DM reopens for the caller on the
// next message. Only a participant may close their own DM.
func (s *Server) handleCloseDM(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil || !ch.IsDM {
		writeErr(w, http.StatusNotFound, "DM not found")
		return
	}
	member, err := s.st.IsChannelMember(r.Context(), ch.ID, u.ID)
	if err != nil || !member {
		writeErr(w, http.StatusForbidden, "not a participant in this DM")
		return
	}
	if err := s.st.CloseDM(r.Context(), u.ID, ch.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not close DM")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "closed"})
}

// handleGetChannel returns a single channel by id if the caller can access it.
// Used by the client to resolve closed DMs that are absent from the initial
// channel list (e.g. to label search results or reopen on a permalink click).
func (s *Server) handleGetChannel(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "no access to this channel")
		return
	}
	writeJSON(w, http.StatusOK, ch)
}

// handleListChannelMembers lists the members of a channel the caller can access.
func (s *Server) handleListChannelMembers(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "no access to this channel")
		return
	}
	members, err := s.st.ListChannelMembers(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list members")
		return
	}
	writeJSON(w, http.StatusOK, members)
}

// handleAddChannelMember invites a user to a private channel. Only moderators+
// may invite, and only into a real private channel — DMs are fixed at two
// participants and public channels have no membership.
func (s *Server) handleAddChannelMember(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !ch.IsPrivate {
		writeErr(w, http.StatusBadRequest, "public channels have no membership to manage")
		return
	}
	if ch.IsDM {
		writeErr(w, http.StatusForbidden, "a DM is limited to its two participants")
		return
	}
	if roleRank(u.Role) < roleRank(store.RoleModerator) {
		writeErr(w, http.StatusForbidden, "only moderators can invite to this channel")
		return
	}
	var req struct {
		UserID int64 `json:"user_id"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	target, err := s.st.GetUserByID(r.Context(), req.UserID)
	if err != nil || !target.IsActive {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	if err := s.st.AddChannelMember(r.Context(), ch.ID, target.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not add member")
		return
	}
	// Start the invitee caught up on this channel's backlog rather than facing it
	// all as unread.
	if err := s.st.SeedReadCursor(r.Context(), target.ID, ch.ID); err != nil {
		log.Printf("addChannelMember: seed read cursor: %v", err)
	}
	// Re-broadcast the channel to the (now-larger) audience so the newly-added
	// member's client learns the channel exists in realtime.
	s.broadcast("channel.new", ch, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, target)
}

// handleRemoveChannelMember removes a user from a private channel. A user may
// always remove themselves (leave); removing someone else requires moderator+.
// Public channels have no membership and DMs are fixed at two participants, so
// both are refused.
func (s *Server) handleRemoveChannelMember(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	target, err := pathInt(r, "userId")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !ch.IsPrivate {
		writeErr(w, http.StatusBadRequest, "public channels have no membership to manage")
		return
	}
	if ch.IsDM {
		writeErr(w, http.StatusForbidden, "a DM is fixed at its two participants")
		return
	}
	// Self-removal (leave) is always allowed; removing others needs moderator+.
	if target != u.ID && roleRank(u.Role) < roleRank(store.RoleModerator) {
		writeErr(w, http.StatusForbidden, "you can only remove yourself from this channel")
		return
	}
	// Capture the audience (current members, INCLUDING the one leaving) before the
	// removal, so one event reaches both the departing user and everyone who
	// stays. (A moderator viewing via bypass isn't a member and so isn't notified
	// live — consistent with how other private-channel events are scoped; they'll
	// see the change on next open.)
	audience := s.audienceForChannel(r.Context(), ch)
	if err := s.st.RemoveChannelMember(r.Context(), id, target); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not a member of this channel")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not remove member")
		return
	}
	// One event does both jobs: the departing user's clients drop the channel,
	// and remaining members drop them from the roster — no re-fetch needed.
	s.broadcast("member.remove", map[string]int64{"channel_id": id, "user_id": target}, audience)
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

// --- messages ------------------------------------------------------------

func (s *Server) canAccessChannel(r *http.Request, ch store.Channel, u store.User) bool {
	if !ch.IsPrivate {
		return true
	}
	member, err := s.st.IsChannelMember(r.Context(), ch.ID, u.ID)
	isMember := err == nil && member
	// A DM is readable only by its two participants — moderators/admins have no
	// access to others' DMs. Regular private channels keep the moderator+ bypass.
	if ch.IsDM {
		return isMember
	}
	return isMember || roleRank(u.Role) >= roleRank(store.RoleModerator)
}

// accessibleChannelIDs returns the ids of every channel the user may read —
// the same visibility canAccessChannel enforces per-channel, applied across the
// whole channel list. Used to scope full-text search so a caller can never match
// a message in a private channel or DM they aren't part of.
func (s *Server) accessibleChannelIDs(r *http.Request, u store.User) ([]int64, error) {
	channels, err := s.st.ListChannels(r.Context())
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(channels))
	for _, ch := range channels {
		if s.canAccessChannel(r, ch, u) {
			ids = append(ids, ch.ID)
		}
	}
	return ids, nil
}

// pingRecipients returns the user ids a message should ping (notify durably).
// A DM pings every member except the author. Any other channel pings the
// @-mentioned users who can see it (members, for a private channel) plus — when
// the message is a reply — the author of the message being replied to: replying
// to someone is itself a ping, no explicit @-mention required. The author is
// never pinged for their own message, and the result is deduplicated so a reply
// that also @-mentions the parent author counts once. Best-effort: lookup
// failures are logged and yield no pings rather than failing the send.
func (s *Server) pingRecipients(ctx context.Context, ch store.Channel, msg store.Message) []int64 {
	authorID := msg.UserID
	out := make([]int64, 0, 4)
	seen := make(map[int64]bool)
	add := func(id int64) {
		if id == authorID || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, id)
	}

	if ch.IsDM {
		ids, err := s.st.ListChannelMemberIDs(ctx, ch.ID)
		if err != nil {
			log.Printf("pingRecipients: dm members: %v", err)
			return out
		}
		for _, id := range ids {
			add(id)
		}
		return out // a reply ping is redundant in a DM — both parties ping already
	}

	// For a private channel, only members can be pinged.
	var members map[int64]bool
	if ch.IsPrivate {
		ids, err := s.st.ListChannelMemberIDs(ctx, ch.ID)
		if err != nil {
			log.Printf("pingRecipients: channel members: %v", err)
			return out
		}
		members = make(map[int64]bool, len(ids))
		for _, id := range ids {
			members[id] = true
		}
	}
	pingable := func(id int64) bool { return members == nil || members[id] }

	// @-mentions.
	if names := parseMentions(msg.Content); len(names) > 0 {
		byName, err := s.st.UsersByUsernames(ctx, names)
		if err != nil {
			log.Printf("pingRecipients: resolve usernames: %v", err)
		} else {
			for _, id := range byName {
				if pingable(id) {
					add(id)
				}
			}
		}
	}

	// Reply target: pinging the author you're replying to. The parent posted in
	// this channel, so it had access; still honour the member filter for a private
	// channel to stay consistent with the mention path (fail-closed).
	if msg.ReplyToID != nil {
		if parent, err := s.st.GetMessage(ctx, *msg.ReplyToID); err != nil {
			log.Printf("pingRecipients: reply target: %v", err)
		} else if pingable(parent.UserID) {
			add(parent.UserID)
		}
	}

	return out
}

// recordPings computes and stores the ping rows for a message (used on create
// and, after clearing the old rows, on edit) and returns the recipient ids so a
// caller can drive push delivery from the same list. Best-effort: a failure is
// logged but does not fail the request — the message itself is already persisted.
func (s *Server) recordPings(ctx context.Context, ch store.Channel, msg store.Message) []int64 {
	recipients := s.pingRecipients(ctx, ch, msg)
	if len(recipients) == 0 {
		return recipients
	}
	if err := s.st.RecordMentions(ctx, msg.ID, ch.ID, recipients); err != nil {
		log.Printf("recordPings: %v", err)
	}
	return recipients
}

// sendPushNotifications delivers a Web Push for a new message to every ping
// recipient who is *not* currently connected (a connected user gets the
// foreground WS notification instead) and hasn't muted the channel. Runs in its
// own goroutine off the request path; all delivery is best-effort, and a push
// service reporting a subscription gone (404/410) prunes it.
func (s *Server) sendPushNotifications(ch store.Channel, msg store.Message, recipients []int64) {
	if s.pusher == nil || len(recipients) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	author, _ := s.st.GetUserByID(ctx, msg.UserID)
	who := author.DisplayName
	if who == "" {
		who = "Someone"
	}
	title := who
	if !ch.IsDM {
		title = who + " in #" + ch.Name
	}
	payload, err := json.Marshal(map[string]any{
		"title":     title,
		"body":      truncateForPush(msg.Content, 180),
		"channelId": ch.ID,
		"url":       fmt.Sprintf("/#c%d/m%d", ch.ID, msg.ID),
		"tag":       fmt.Sprintf("rivendell-ch-%d", ch.ID),
	})
	if err != nil {
		log.Printf("push: marshal payload: %v", err)
		return
	}

	for _, uid := range recipients {
		if s.hub.IsConnected(uid) {
			continue
		}
		if muted, err := s.st.IsChannelMuted(ctx, uid, ch.ID); err == nil && muted {
			continue
		}
		subs, err := s.st.ListPushSubscriptions(ctx, uid)
		if err != nil {
			log.Printf("push: list subscriptions for user %d: %v", uid, err)
			continue
		}
		for _, sub := range subs {
			err := s.pusher.Send(ctx, push.Subscription{
				Endpoint: sub.Endpoint, P256dh: sub.P256dh, Auth: sub.Auth,
			}, payload)
			switch {
			case errors.Is(err, push.ErrSubscriptionGone):
				_ = s.st.DeletePushSubscriptionByEndpoint(ctx, sub.Endpoint)
			case err != nil:
				log.Printf("push: send to user %d: %v", uid, err)
			}
		}
	}
}

// truncateForPush bounds a notification body to n runes, appending an ellipsis if
// it was cut. Rune-aware so a multibyte character is never split.
func truncateForPush(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// handlePushKey returns whether Web Push is available on this server and, if so,
// the VAPID application server key the browser needs for pushManager.subscribe.
func (s *Server) handlePushKey(w http.ResponseWriter, r *http.Request) {
	if s.pusher == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "key": s.pusher.PublicKey()})
}

// handlePushSubscribe registers (or refreshes) the caller's browser push
// subscription. The body is the trimmed PushSubscription shape
// {endpoint, keys:{p256dh, auth}}.
func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var req struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !strings.HasPrefix(req.Endpoint, "https://") || req.Keys.P256dh == "" || req.Keys.Auth == "" {
		writeErr(w, http.StatusBadRequest, "invalid subscription")
		return
	}
	if err := s.st.AddPushSubscription(r.Context(), u.ID, req.Endpoint, req.Keys.P256dh, req.Keys.Auth); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save subscription")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handlePushUnsubscribe removes a push subscription by endpoint (called when the
// user turns notifications off or the browser rotates the subscription).
func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if err := readJSON(r, &req); err != nil || req.Endpoint == "" {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.st.DeletePushSubscriptionByEndpoint(r.Context(), req.Endpoint); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not remove subscription")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "no access to this channel")
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	if v := r.URL.Query().Get("around"); v != "" {
		aroundID, _ := strconv.ParseInt(v, 10, 64)
		if aroundID > 0 {
			msgs, err := s.st.GetMessagesAround(r.Context(), id, aroundID, 25)
			if errors.Is(err, store.ErrNotFound) {
				writeErr(w, http.StatusNotFound, "message not found")
				return
			}
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "could not load messages")
				return
			}
			s.attachReactions(r.Context(), msgs)
			writeJSON(w, http.StatusOK, msgs)
			return
		}
	}
	// `after` pages forward (newer) from a cursor — the counterpart to `before` —
	// used when scrolling down through a history window toward the present.
	if v := r.URL.Query().Get("after"); v != "" {
		afterID, _ := strconv.ParseInt(v, 10, 64)
		if afterID > 0 {
			msgs, err := s.st.ListMessagesAfter(r.Context(), id, afterID, limit)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "could not list messages")
				return
			}
			s.attachReactions(r.Context(), msgs)
			writeJSON(w, http.StatusOK, msgs)
			return
		}
	}
	beforeID := int64(0)
	if v := r.URL.Query().Get("before"); v != "" {
		beforeID, _ = strconv.ParseInt(v, 10, 64)
	}
	msgs, err := s.st.ListMessages(r.Context(), id, beforeID, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list messages")
		return
	}
	s.attachReactions(r.Context(), msgs)
	writeJSON(w, http.StatusOK, msgs)
}

// handleSearch runs a full-text search over the caller's accessible channels,
// newest match first. Paginates by keyset (`before` = exclusive upper-bound id),
// matching the message-history endpoint. A blank query returns [] rather than an
// error so the client can clear results by emptying the box.
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, []store.Message{})
		return
	}
	limit := 25
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}
	beforeID := int64(0)
	if v := r.URL.Query().Get("before"); v != "" {
		beforeID, _ = strconv.ParseInt(v, 10, 64)
	}
	ids, err := s.accessibleChannelIDs(r, u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not search")
		return
	}
	msgs, err := s.st.SearchMessages(r.Context(), ids, q, beforeID, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not search")
		return
	}
	s.attachReactions(r.Context(), msgs)
	writeJSON(w, http.StatusOK, msgs)
}

func (s *Server) handleCreateMessage(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "no access to this channel")
		return
	}
	var req struct {
		Content string `json:"content"`
		ReplyTo *int64 `json:"reply_to_id"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Content = strings.TrimRight(req.Content, " \t\r\n")
	if strings.TrimSpace(req.Content) == "" {
		writeErr(w, http.StatusBadRequest, "message is empty")
		return
	}
	if len(req.Content) > s.cfg.MaxMessageBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "message too long")
		return
	}
	// A reply must point at a live message in this same channel. Validate here so a
	// stray/forged reply_to_id can't dangle (or leak that a message exists in another
	// channel). The DB's ON DELETE SET NULL only covers hard-deletes, not soft ones.
	var replyToUserID *int64
	if req.ReplyTo != nil {
		parent, err := s.st.GetMessage(r.Context(), *req.ReplyTo)
		if err != nil || parent.ChannelID != id || parent.DeletedAt != nil {
			writeErr(w, http.StatusBadRequest, "reply target not found in this channel")
			return
		}
		replyToUserID = &parent.UserID
	}
	msg, err := s.st.CreateMessage(r.Context(), id, u.ID, req.Content, req.ReplyTo)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not send message")
		return
	}
	msg.ReplyToUserID = replyToUserID
	// A message in a DM reopens it for every participant who had closed it
	// (server-authoritative open state). If anyone was reopened, re-announce the
	// channel first so a client that no longer has it in its list gains the
	// channel object before the message.new it precedes.
	if ch.IsDM {
		if reopened, err := s.st.OpenDMForAllMembers(r.Context(), ch.ID); err != nil {
			log.Printf("reopen DM on message: %v", err)
		} else if reopened > 0 {
			s.broadcast("channel.new", ch, s.audienceForChannel(r.Context(), ch))
		}
	}
	// Record durable pings (DM recipients / @-mentions) before broadcasting, so a
	// client that reacts to message.new by re-fetching unread sees them.
	recipients := s.recordPings(r.Context(), ch, msg)
	s.broadcast("message.new", msg, s.audienceForChannel(r.Context(), ch))
	// Offline notifications: push to pinged recipients who aren't connected. Off
	// the request path — push services must never slow a send.
	go s.sendPushNotifications(ch, msg, recipients)
	writeJSON(w, http.StatusCreated, msg)
}

func (s *Server) handleEditMessage(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Content) == "" {
		writeErr(w, http.StatusBadRequest, "message is empty")
		return
	}
	if len(req.Content) > s.cfg.MaxMessageBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "message too long")
		return
	}
	msg, err := s.st.EditMessage(r.Context(), id, u.ID, req.Content)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "message not found or not yours")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not edit message")
		return
	}
	ch, _ := s.st.GetChannel(r.Context(), msg.ChannelID)
	// An edit may add or remove an @-mention; recompute the ping rows from the
	// new content so durable counts stay accurate.
	if err := s.st.DeleteMentionsForMessage(r.Context(), msg.ID); err != nil {
		log.Printf("editMessage: clear mentions: %v", err)
	}
	s.recordPings(r.Context(), ch, msg)
	s.broadcast("message.update", msg, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, msg)
}

func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	modOverride := roleRank(u.Role) >= roleRank(store.RoleModerator)
	msg, err := s.st.SoftDeleteMessage(r.Context(), id, u.ID, modOverride)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "message not found or not yours")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not delete message")
		return
	}
	// A deleted message should stop pinging anyone.
	if err := s.st.DeleteMentionsForMessage(r.Context(), msg.ID); err != nil {
		log.Printf("deleteMessage: clear mentions: %v", err)
	}
	// ...and shed its reactions (a deleted message renders none).
	if err := s.st.DeleteReactionsForMessage(r.Context(), msg.ID); err != nil {
		log.Printf("deleteMessage: clear reactions: %v", err)
	}
	ch, _ := s.st.GetChannel(r.Context(), msg.ChannelID)
	s.broadcast("message.delete", map[string]int64{
		"id":         msg.ID,
		"channel_id": msg.ChannelID,
	}, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// handleListPinnedMessages lists a channel's pinned messages (any member who can
// access the channel may view them).
func (s *Server) handleListPinnedMessages(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "no access to this channel")
		return
	}
	msgs, err := s.st.ListPinnedMessages(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list pinned messages")
		return
	}
	s.attachReactions(r.Context(), msgs)
	writeJSON(w, http.StatusOK, msgs)
}

// setMessagePinned is shared by the pin (PUT) and unpin (DELETE) handlers, both
// gated to moderator+ at the route. The pinned/unpinned message is broadcast as
// a message.update so clients fold the pinned_at change into their state.
func (s *Server) setMessagePinned(w http.ResponseWriter, r *http.Request, pinned bool) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	msg, err := s.st.GetMessage(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "message not found")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), msg.ChannelID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "no access to this channel")
		return
	}
	// In a DM, either participant may pin (canAccessChannel already proved
	// membership). Everywhere else pinning is a moderator+ action.
	if !ch.IsDM && roleRank(u.Role) < roleRank(store.RoleModerator) {
		writeErr(w, http.StatusForbidden, "only moderators can pin in this channel")
		return
	}
	updated, err := s.st.SetMessagePinned(r.Context(), id, u.ID, pinned)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "message not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not update pin")
		return
	}
	s.broadcast("message.update", updated, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handlePinMessage(w http.ResponseWriter, r *http.Request) {
	s.setMessagePinned(w, r, true)
}

func (s *Server) handleUnpinMessage(w http.ResponseWriter, r *http.Request) {
	s.setMessagePinned(w, r, false)
}

// --- reactions -----------------------------------------------------------

const maxReactionRunes = 12

// attachReactions decorates a page of messages with their reaction groups in a
// single batched query (no N+1). Messages with no reactions are left untouched
// (Reactions stays nil → omitted from JSON). Best-effort: a load failure just
// leaves reactions off rather than failing the whole list.
func (s *Server) attachReactions(ctx context.Context, msgs []store.Message) {
	if len(msgs) == 0 {
		return
	}
	ids := make([]int64, len(msgs))
	for i := range msgs {
		ids[i] = msgs[i].ID
	}
	byID, err := s.st.ReactionsForMessages(ctx, ids)
	if err != nil {
		log.Printf("attachReactions: %v", err)
		return
	}
	for i := range msgs {
		if r := byID[msgs[i].ID]; len(r) > 0 {
			msgs[i].Reactions = r
		}
	}
}

// validReactionEmoji reports whether v is an acceptable reaction value: either a
// known custom shortcode, or a short Unicode emoji grapheme.
func (s *Server) validReactionEmoji(ctx context.Context, v string) bool {
	if reShortcode.MatchString(v) {
		ok, err := s.st.EmojiExists(ctx, v)
		return err == nil && ok
	}
	return validUnicodeEmoji(v)
}

// validUnicodeEmoji is a pragmatic, stdlib-only check (no emoji library — the prime
// directive). Every rune must be a symbol or a recognised emoji connector/modifier,
// and at least one must contribute "emoji-ness" (a symbol or a keycap mark). This
// admits 👍 ❤️ 😂, flags, skin-tone and ZWJ sequences, and keycaps, while rejecting
// words and arbitrary text masquerading as a reaction.
func validUnicodeEmoji(v string) bool {
	if v == "" || len(v) > 64 {
		return false
	}
	n := 0
	sawEmoji := false
	for _, r := range v {
		n++
		if n > maxReactionRunes {
			return false
		}
		switch {
		case unicode.Is(unicode.S, r):
			// Any symbol: pictographs, dingbats, regional-indicator flags, and the
			// skin-tone modifiers (category Sk) all live here.
			sawEmoji = true
		case r == 0x20E3:
			// Combining enclosing keycap — turns a digit/#/* into a keycap emoji.
			sawEmoji = true
		case r == 0x200D, r == 0xFE0F, r == 0xFE0E:
			// Zero-width joiner and the emoji/text variation selectors.
		case (r >= '0' && r <= '9') || r == '#' || r == '*':
			// Keycap bases (paired with U+20E3 above).
		default:
			return false
		}
	}
	return sawEmoji
}

// setReaction is shared by the add (PUT) and remove (DELETE) handlers. Any member
// who can access the channel may react to a visible, non-deleted message; the emoji
// is carried in the body (not the path) so Unicode graphemes need no URL encoding.
// After the change it re-aggregates the message's reactions and broadcasts them as
// reaction.update to the channel audience, mirroring the pin flow.
func (s *Server) setReaction(w http.ResponseWriter, r *http.Request, add bool) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	var req struct {
		Emoji string `json:"emoji"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Emoji = strings.TrimSpace(req.Emoji)
	msg, err := s.st.GetMessage(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "message not found")
		return
	}
	if msg.DeletedAt != nil {
		writeErr(w, http.StatusConflict, "cannot react to a deleted message")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), msg.ChannelID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "no access to this channel")
		return
	}
	// Validate the emoji only on add. A removal must be allowed even when the
	// custom emoji was deleted after the reaction was placed — the DB row itself is
	// proof the value was valid when added, and blocking removal would strand
	// orphaned reactions permanently.
	if add && !s.validReactionEmoji(r.Context(), req.Emoji) {
		writeErr(w, http.StatusBadRequest, "invalid reaction emoji")
		return
	}
	if add {
		err = s.st.AddReaction(r.Context(), id, u.ID, req.Emoji)
	} else {
		err = s.st.RemoveReaction(r.Context(), id, u.ID, req.Emoji)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update reaction")
		return
	}
	groups, err := s.st.ReactionsForMessage(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load reactions")
		return
	}
	payload := map[string]any{
		"message_id": id,
		"channel_id": msg.ChannelID,
		"reactions":  groups,
	}
	s.broadcast("reaction.update", payload, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) handleAddReaction(w http.ResponseWriter, r *http.Request) {
	s.setReaction(w, r, true)
}

func (s *Server) handleRemoveReaction(w http.ResponseWriter, r *http.Request) {
	s.setReaction(w, r, false)
}

// --- read state / notifications ------------------------------------------

// handleUnread returns the caller's durable unread + mention (ping) counts per
// channel, plus the totals. The per-channel list always serializes as an array,
// never null (the client iterates it).
func (s *Server) handleUnread(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	channels, err := s.st.UnreadSummary(r.Context(), u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load unread")
		return
	}
	var totalUnread, totalMentions int
	for _, c := range channels {
		totalUnread += c.Unread
		totalMentions += c.Mentions
	}
	muted, err := s.st.ListMutedChannelIDs(r.Context(), u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load mutes")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"channels":       channels,
		"total_unread":   totalUnread,
		"total_mentions": totalMentions,
		"muted":          muted,
	})
}

// setChannelMuted mutes/unmutes a channel for the caller and echoes the change to
// their other connections (self-audience) so every tab/device stays in sync.
func (s *Server) setChannelMuted(w http.ResponseWriter, r *http.Request, muted bool) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "no access to this channel")
		return
	}
	if muted {
		err = s.st.MuteChannel(r.Context(), u.ID, id)
	} else {
		err = s.st.UnmuteChannel(r.Context(), u.ID, id)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update mute")
		return
	}
	s.broadcast("mute.update", map[string]any{"channel_id": id, "muted": muted}, map[int64]bool{u.ID: true})
	writeJSON(w, http.StatusOK, map[string]bool{"muted": muted})
}

func (s *Server) handleMuteChannel(w http.ResponseWriter, r *http.Request) {
	s.setChannelMuted(w, r, true)
}

func (s *Server) handleUnmuteChannel(w http.ResponseWriter, r *http.Request) {
	s.setChannelMuted(w, r, false)
}

// handleMarkRead advances the caller's read cursor for a channel and echoes the
// change to the caller's *other* connections (self-audience) so every tab/device
// clears the badge together.
func (s *Server) handleMarkRead(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "no access to this channel")
		return
	}
	var req struct {
		MessageID int64 `json:"message_id"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.st.MarkRead(r.Context(), u.ID, id, req.MessageID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not mark read")
		return
	}
	s.broadcast("read.update", map[string]int64{
		"channel_id":           id,
		"last_read_message_id": req.MessageID,
	}, map[int64]bool{u.ID: true})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// --- admin ---------------------------------------------------------------

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
		Role        string `json:"role"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if !reUsername.MatchString(req.Username) {
		writeErr(w, http.StatusBadRequest, "username must be 2-32 chars of a-z, 0-9, or underscore")
		return
	}
	if l := len(req.DisplayName); l < 1 || l > 64 {
		req.DisplayName = req.Username
	}
	role := store.Role(req.Role)
	if role != store.RoleAdmin && role != store.RoleModerator && role != store.RoleMember {
		role = store.RoleMember
	}
	u, err := s.st.CreateUser(r.Context(), req.Username, req.DisplayName, role)
	if err != nil {
		if store.IsUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "username already taken")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not create user")
		return
	}
	// Start the new user caught up on existing public channels, so their first
	// login isn't a wall of unread history.
	if err := s.st.SeedPublicReadCursors(r.Context(), u.ID); err != nil {
		log.Printf("createUser: seed public read cursors: %v", err)
	}
	writeJSON(w, http.StatusCreated, u)
}

func (s *Server) handleCreateMagicLink(w http.ResponseWriter, r *http.Request) {
	admin := userFrom(r.Context())
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	target, err := s.st.GetUserByID(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	purpose := "set_password"
	if target.HasPassword {
		purpose = "reset_password"
	}
	token, err := auth.NewToken()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create link")
		return
	}
	expires := time.Now().Add(s.cfg.MagicLinkTTL)
	if err := s.st.CreateMagicLink(r.Context(), id, auth.HashToken(token), purpose, admin.ID, expires); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create link")
		return
	}
	base := strings.TrimRight(s.cfg.PublicURL, "/")
	url := base + "/set-password#" + token
	writeJSON(w, http.StatusCreated, map[string]any{
		"url":        url,
		"token":      token,
		"purpose":    purpose,
		"expires_at": expires,
	})
}

func (s *Server) handleSetRole(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	var req struct {
		Role string `json:"role"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	role := store.Role(req.Role)
	if role != store.RoleAdmin && role != store.RoleModerator && role != store.RoleMember {
		writeErr(w, http.StatusBadRequest, "invalid role")
		return
	}
	target, err := s.st.GetUserByID(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	// Guard against demoting the last admin.
	if target.Role == store.RoleAdmin && role != store.RoleAdmin {
		count, err := s.st.CountAdmins(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not verify admin count")
			return
		}
		if count <= 1 {
			writeErr(w, http.StatusConflict, "cannot demote the last admin")
			return
		}
	}
	if err := s.st.SetRole(r.Context(), id, role); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not set role")
		return
	}
	updated, _ := s.st.GetUserByID(r.Context(), id)
	s.broadcast("user.update", updated, nil)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleSetActive(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	var req struct {
		Active bool `json:"active"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	target, err := s.st.GetUserByID(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	// Guard against disabling the last admin.
	if !req.Active && target.Role == store.RoleAdmin {
		count, err := s.st.CountAdmins(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not verify admin count")
			return
		}
		if count <= 1 {
			writeErr(w, http.StatusConflict, "cannot disable the last admin")
			return
		}
	}
	if err := s.st.SetActive(r.Context(), id, req.Active); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update user")
		return
	}
	updated, _ := s.st.GetUserByID(r.Context(), id)
	s.broadcast("user.update", updated, nil)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleSetBot(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	var req struct {
		Bot bool `json:"bot"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if _, err := s.st.GetUserByID(r.Context(), id); err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	if err := s.st.SetBot(r.Context(), id, req.Bot); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update user")
		return
	}
	updated, _ := s.st.GetUserByID(r.Context(), id)
	s.broadcast("user.update", updated, nil)
	writeJSON(w, http.StatusOK, updated)
}

// handleAdminSetAvatar lets an admin set the avatar for any user.
func (s *Server) handleAdminSetAvatar(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if _, err := s.st.GetUserByID(r.Context(), id); err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	ct := r.Header.Get("Content-Type")
	if ct != "image/png" && ct != "image/jpeg" && ct != "image/webp" && ct != "image/gif" {
		writeErr(w, http.StatusUnsupportedMediaType, "avatar must be png, jpeg, webp, or gif")
		return
	}
	body := http.MaxBytesReader(w, r.Body, int64(s.cfg.MaxAvatarBytes))
	data, err := io.ReadAll(body)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "avatar too large")
		return
	}
	if len(data) == 0 {
		writeErr(w, http.StatusBadRequest, "empty avatar")
		return
	}
	if err := s.st.SetAvatar(r.Context(), id, ct, data); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save avatar")
		return
	}
	updated, _ := s.st.GetUserByID(r.Context(), id)
	s.broadcast("user.update", updated, nil)
	writeJSON(w, http.StatusOK, map[string]bool{"has_avatar": true})
}

// handleAdminClearAvatar removes the avatar for any user.
func (s *Server) handleAdminClearAvatar(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if _, err := s.st.GetUserByID(r.Context(), id); err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	if err := s.st.ClearAvatar(r.Context(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not clear avatar")
		return
	}
	updated, _ := s.st.GetUserByID(r.Context(), id)
	s.broadcast("user.update", updated, nil)
	writeJSON(w, http.StatusOK, map[string]bool{"has_avatar": false})
}

// handleAdminStats returns at-a-glance server metrics for the admin panel.
func (s *Server) handleAdminStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.st.GetStats(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not fetch stats")
		return
	}
	out := struct {
		store.Stats
		Connected int `json:"connected"`
	}{stats, s.hub.ConnectedCount()}
	writeJSON(w, http.StatusOK, out)
}

// handleListArchivedChannels lists soft-deleted channels (admin only).
func (s *Server) handleListArchivedChannels(w http.ResponseWriter, r *http.Request) {
	chans, err := s.st.ListArchivedChannels(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list archived channels")
		return
	}
	writeJSON(w, http.StatusOK, chans)
}

// handleRestoreChannel un-archives a channel and re-announces it to its audience.
func (s *Server) handleRestoreChannel(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ch, err := s.st.RestoreChannel(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "channel not found or not archived")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not restore channel")
		return
	}
	s.broadcast("channel.new", ch, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, ch)
}

// handlePurgeChannel permanently deletes an archived channel (and, by cascade,
// its messages and memberships). Refuses live channels.
func (s *Server) handlePurgeChannel(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	if err := s.st.PurgeChannel(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "channel not found or not archived")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not delete channel")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "purged"})
}

// --- Bot tokens (admin) --------------------------------------------------

func (s *Server) handleListBotTokens(w http.ResponseWriter, r *http.Request) {
	tokens, err := s.st.ListBotTokens(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list bot tokens")
		return
	}
	writeJSON(w, http.StatusOK, tokens)
}

// handleCreateBotToken mints a new permanent Bearer token. The raw token is
// returned only in this response — it is never stored and cannot be retrieved
// again. Pass user_id to create a token for a specific user; omit to use the
// requesting admin's own identity.
func (s *Server) handleCreateBotToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   string `json:"name"`
		UserID *int64 `json:"user_id"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "name is required")
		return
	}
	uid := userFrom(r.Context()).ID
	if req.UserID != nil {
		uid = *req.UserID
	}
	if _, err := s.st.GetUserByID(r.Context(), uid); err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	token, err := auth.NewToken()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not generate token")
		return
	}
	bt, err := s.st.CreateBotToken(r.Context(), uid, auth.HashToken(token), req.Name)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create token")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":         bt.ID,
		"user_id":    bt.UserID,
		"name":       bt.Name,
		"created_at": bt.CreatedAt,
		"token":      token,
	})
}

func (s *Server) handleDeleteBotToken(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid token id")
		return
	}
	if err := s.st.DeleteBotToken(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "token not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not delete token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

// --- link preview --------------------------------------------------------

type linkPreview struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Image       string `json:"image"`
}

var allowedPreviewHosts = map[string]bool{
	"bsky.app":    true,
	"twitter.com": true,
	"x.com":       true,
	"xcancel.com": true,
}

// previewClient is a dedicated http.Client for link preview fetches with a
// conservative timeout so a slow external host can't stall a handler.
var previewClient = &http.Client{
	Timeout: 8 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return nil
	},
}

const previewCacheTTL = time.Hour

func (s *Server) handleLinkPreview(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		writeErr(w, http.StatusBadRequest, "url parameter required")
		return
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" {
		writeErr(w, http.StatusBadRequest, "invalid url")
		return
	}
	if !allowedPreviewHosts[strings.ToLower(u.Hostname())] {
		writeErr(w, http.StatusBadRequest, "unsupported host")
		return
	}

	s.previewMu.Lock()
	if e, ok := s.previewCache[rawURL]; ok && time.Now().Before(e.exp) {
		p := e.preview
		s.previewMu.Unlock()
		w.Header().Set("Cache-Control", "private, max-age=3600")
		writeJSON(w, http.StatusOK, p)
		return
	}
	s.previewMu.Unlock()

	req, err := http.NewRequestWithContext(r.Context(), "GET", rawURL, nil)
	if err != nil {
		writeJSON(w, http.StatusOK, linkPreview{})
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; Rivendell link-preview/1.0)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

	resp, err := previewClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusOK, linkPreview{})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		writeJSON(w, http.StatusOK, linkPreview{})
		return
	}

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	p := parseOGTags(body)

	s.previewMu.Lock()
	s.previewCache[rawURL] = previewCacheEntry{preview: p, exp: time.Now().Add(previewCacheTTL)}
	s.previewMu.Unlock()

	w.Header().Set("Cache-Control", "private, max-age=3600")
	writeJSON(w, http.StatusOK, p)
}

// parseOGTags extracts Open Graph / Twitter card meta values from HTML.
func parseOGTags(rawHTML []byte) linkPreview {
	doc := string(rawHTML)
	docLow := strings.ToLower(doc)
	return linkPreview{
		Title:       firstMeta(doc, docLow, "og:title", "twitter:title"),
		Description: firstMeta(doc, docLow, "og:description", "twitter:description"),
		Image:       firstMeta(doc, docLow, "og:image", "twitter:image"),
	}
}

func firstMeta(doc, docLow string, keys ...string) string {
	for _, k := range keys {
		if v := metaContent(doc, docLow, k); v != "" {
			return v
		}
	}
	return ""
}

// metaContent returns the HTML-unescaped content attribute of the first <meta>
// tag whose property or name equals key (case-insensitive). Both attribute
// orderings and both quote styles are handled.
func metaContent(doc, docLow, key string) string {
	pos := 0
	for {
		idx := strings.Index(docLow[pos:], "<meta")
		if idx < 0 {
			return ""
		}
		start := pos + idx
		end := strings.IndexByte(docLow[start:], '>')
		if end < 0 {
			return ""
		}
		end = start + end + 1
		pos = end

		tagLow := docLow[start:end]
		if !(strings.Contains(tagLow, `property="`+key+`"`) ||
			strings.Contains(tagLow, `property='`+key+`'`) ||
			strings.Contains(tagLow, `name="`+key+`"`) ||
			strings.Contains(tagLow, `name='`+key+`'`)) {
			continue
		}
		raw := doc[start:end]
		if v := ogAttrVal(raw, "content"); v != "" {
			return html.UnescapeString(v)
		}
	}
}

// ogAttrVal extracts the value of a named attribute from a raw HTML tag string,
// handling both double- and single-quoted values.
func ogAttrVal(tag, attr string) string {
	low := strings.ToLower(tag)
	search := attr + `="`
	if idx := strings.Index(low, search); idx >= 0 {
		idx += len(search)
		if end := strings.IndexByte(tag[idx:], '"'); end >= 0 {
			return tag[idx : idx+end]
		}
	}
	search = attr + `='`
	if idx := strings.Index(low, search); idx >= 0 {
		idx += len(search)
		if end := strings.IndexByte(tag[idx:], '\''); end >= 0 {
			return tag[idx : idx+end]
		}
	}
	return ""
}

// --- blobs ---------------------------------------------------------------

// handleUploadBlob accepts a raw image body, sniffs the content type, hashes it
// (SHA-256), stores it content-addressed on disk, and records metadata in Postgres.
// The upload is idempotent: uploading the same bytes twice returns the same hash.
func (s *Server) handleUploadBlob(w http.ResponseWriter, r *http.Request) {
	if s.blobStore == nil {
		writeErr(w, http.StatusServiceUnavailable, "file uploads not configured")
		return
	}
	u := userFrom(r.Context())
	body := http.MaxBytesReader(w, r.Body, int64(s.cfg.MaxImageBytes))
	data, err := io.ReadAll(body)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "image too large")
		return
	}
	if len(data) == 0 {
		writeErr(w, http.StatusBadRequest, "empty upload")
		return
	}
	ct := http.DetectContentType(data)
	if !isImageContentType(ct) {
		writeErr(w, http.StatusUnsupportedMediaType, "only png, jpeg, webp, and gif images are accepted")
		return
	}
	hash, size, err := s.blobStore.Put(r.Context(), bytes.NewReader(data))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not store image")
		return
	}
	if err := s.st.CreateBlob(r.Context(), hash, u.ID, ct, size); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not record image")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"hash":         hash,
		"url":          "/api/blobs/" + hash,
		"content_type": ct,
		"size":         size,
	})
}

// handleGetBlob serves a content-addressed image. Auth is required so images
// stay as private as the channels they're posted in. The hash is immutable, so
// a long-lived private cache header is safe.
func (s *Server) handleGetBlob(w http.ResponseWriter, r *http.Request) {
	if s.blobStore == nil {
		http.NotFound(w, r)
		return
	}
	hash := r.PathValue("hash")
	if !isValidBlobHash(hash) {
		http.NotFound(w, r)
		return
	}
	blob, err := s.st.GetBlob(r.Context(), hash)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	rc, err := s.blobStore.Open(r.Context(), hash)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer rc.Close()
	etag := `"` + hash + `"`
	if r.Header.Get("If-None-Match") == etag {
		rc.Close()
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", blob.ContentType)
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("ETag", etag)
	w.Header().Set("Content-Length", strconv.FormatInt(blob.Size, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, rc)
}

// isValidBlobHash reports whether s is a 64-char lowercase hex string (SHA-256).
func isValidBlobHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
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
	welcome, _ := json.Marshal(event{Type: "hello", Payload: map[string]string{"version": config.Version}})
	s.hub.Serve(conn, u.ID, welcome)
}
