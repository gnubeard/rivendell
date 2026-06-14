package httpapi

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"rivendell/internal/auth"
	"rivendell/internal/store"
)

// handleCreateInvitation mints a single-use signup link an admin shares with a
// new person. Admin-only.
func (s *Server) handleCreateInvitation(w http.ResponseWriter, r *http.Request) {
	admin := userFrom(r.Context())
	token, err := auth.NewToken()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create invitation")
		return
	}
	expires := time.Now().Add(s.cfg.MagicLinkTTL)
	inv, err := s.st.CreateInvitation(r.Context(), auth.HashToken(token), admin.ID, expires)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create invitation")
		return
	}
	base := strings.TrimRight(s.cfg.PublicURL, "/")
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":         inv.ID,
		"url":        base + "/invite#" + token,
		"token":      token,
		"expires_at": inv.ExpiresAt,
	})
}

// handleListInvitations lists every issued invitation for the admin panel.
func (s *Server) handleListInvitations(w http.ResponseWriter, r *http.Request) {
	invites, err := s.st.ListInvitations(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list invitations")
		return
	}
	writeJSON(w, http.StatusOK, invites)
}

// handleDeleteInvitation revokes/deletes an invitation by id. Admin-only.
func (s *Server) handleDeleteInvitation(w http.ResponseWriter, r *http.Request) {
	id, ok := requirePathInt(w, r, "id", "invalid invitation id")
	if !ok {
		return
	}
	if err := s.st.DeleteInvitation(r.Context(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not delete invitation")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSetRole(w http.ResponseWriter, r *http.Request) {
	id, ok := requirePathInt(w, r, "id", "invalid user id")
	if !ok {
		return
	}
	var req struct {
		Role string `json:"role"`
	}
	if !decodeBody(w, r, &req) {
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
	updated := s.broadcastUserUpdate(r.Context(), id)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleSetActive(w http.ResponseWriter, r *http.Request) {
	id, ok := requirePathInt(w, r, "id", "invalid user id")
	if !ok {
		return
	}
	var req struct {
		Active bool `json:"active"`
	}
	if !decodeBody(w, r, &req) {
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
	updated := s.broadcastUserUpdate(r.Context(), id)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleSetBot(w http.ResponseWriter, r *http.Request) {
	id, ok := requirePathInt(w, r, "id", "invalid user id")
	if !ok {
		return
	}
	var req struct {
		Bot bool `json:"bot"`
	}
	if !decodeBody(w, r, &req) {
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
	updated := s.broadcastUserUpdate(r.Context(), id)
	writeJSON(w, http.StatusOK, updated)
}

// handleAdminSetAvatar lets an admin set the avatar for any user.
func (s *Server) handleAdminSetAvatar(w http.ResponseWriter, r *http.Request) {
	id, ok := requirePathInt(w, r, "id", "invalid user id")
	if !ok {
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
	s.broadcastUserUpdate(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]bool{"has_avatar": true})
}

// handleAdminClearAvatar removes the avatar for any user.
func (s *Server) handleAdminClearAvatar(w http.ResponseWriter, r *http.Request) {
	id, ok := requirePathInt(w, r, "id", "invalid user id")
	if !ok {
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
	s.broadcastUserUpdate(r.Context(), id)
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
	id, ok := requirePathInt(w, r, "id", "invalid channel id")
	if !ok {
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
	id, ok := requirePathInt(w, r, "id", "invalid channel id")
	if !ok {
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
	if !decodeBody(w, r, &req) {
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
	id, ok := requirePathInt(w, r, "id", "invalid token id")
	if !ok {
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
