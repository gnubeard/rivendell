package httpapi

import (
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"snug/internal/auth"
	"snug/internal/store"
	"snug/internal/ws"
)

var (
	reUsername  = regexp.MustCompile(`^[a-z0-9_]{2,32}$`)
	reChannel   = regexp.MustCompile(`^[a-z0-9-]{1,48}$`)
	validStatus = map[string]bool{
		"online": true, "away": true, "dnd": true, "offline": true,
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
	if err := s.st.UpdateProfile(r.Context(), u.ID, displayName, statusText); err != nil {
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
	type userWithPresence struct {
		store.User
		Online bool `json:"online"`
	}
	out := make([]userWithPresence, len(users))
	for i, u := range users {
		// Invisible users (chosen status "offline") read as offline even while
		// they hold a connection — matching the presence.update broadcasts.
		out[i] = userWithPresence{User: u, Online: online[u.ID] && u.Status != "offline"}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleInstance reports public, unauthenticated instance metadata (the display
// name) so the web client can brand itself before login.
func (s *Server) handleInstance(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"name": s.cfg.InstanceName})
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

// --- channels ------------------------------------------------------------

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	channels, err := s.st.ListChannels(r.Context())
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
		// must NOT see other people's DMs. Regular private channels keep the
		// moderator+ bypass.
		if ch.IsDM {
			if isMember {
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
	// Only announce a freshly-created DM, and only to its two members (the
	// audience scoping); the caller gets the channel in the HTTP response.
	if created {
		s.broadcast("channel.new", ch, s.audienceForChannel(r.Context(), ch))
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

// handleAddChannelMember invites a user to a private channel. Only members of
// the channel (or moderators+) may invite, and only into a real private channel
// — DMs are fixed at two participants and public channels have no membership.
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
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "only members can invite to this channel")
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
	// Re-broadcast the channel to the (now-larger) audience so the newly-added
	// member's client learns the channel exists in realtime.
	s.broadcast("channel.new", ch, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, target)
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
	beforeID := int64(0)
	if v := r.URL.Query().Get("before"); v != "" {
		beforeID, _ = strconv.ParseInt(v, 10, 64)
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	msgs, err := s.st.ListMessages(r.Context(), id, beforeID, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list messages")
		return
	}
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
	msg, err := s.st.CreateMessage(r.Context(), id, u.ID, req.Content, req.ReplyTo)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not send message")
		return
	}
	s.broadcast("message.new", msg, s.audienceForChannel(r.Context(), ch))
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
	s.hub.Serve(conn, u.ID)
}
