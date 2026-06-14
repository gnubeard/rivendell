package httpapi

import (
	"encoding/base64"
	"io"
	"net/http"
	"strings"

	"rivendell/internal/store"
)

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
		Pronouns    *string `json:"pronouns"`
		Bio         *string `json:"bio"`
	}
	if !decodeBody(w, r, &req) {
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
	pronouns := u.Pronouns
	if req.Pronouns != nil {
		pronouns = strings.TrimSpace(*req.Pronouns)
		if len(pronouns) > 32 {
			writeErr(w, http.StatusBadRequest, "pronouns must be at most 32 characters")
			return
		}
	}
	bio := u.Bio
	if req.Bio != nil {
		bio = strings.TrimSpace(*req.Bio)
		if len(bio) > 1000 {
			writeErr(w, http.StatusBadRequest, "bio must be at most 1000 characters")
			return
		}
	}
	if err := s.st.UpdateProfile(r.Context(), u.ID, displayName, statusText, theme, pronouns, bio); err != nil {
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
	if !decodeBody(w, r, &req) {
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
	if !decodeBody(w, r, &req) {
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
	s.broadcastUserUpdate(r.Context(), u.ID)
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

// handleGetUserNote returns the caller's private note about user {id}.
func (s *Server) handleGetUserNote(w http.ResponseWriter, r *http.Request) {
	subjectID, ok := requirePathInt(w, r, "id", "invalid user id")
	if !ok {
		return
	}
	me := userFrom(r.Context())
	note, err := s.st.GetUserNote(r.Context(), me.ID, subjectID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not get note")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"note": note})
}

// handlePutUserNote saves the caller's private note about user {id}.
func (s *Server) handlePutUserNote(w http.ResponseWriter, r *http.Request) {
	subjectID, ok := requirePathInt(w, r, "id", "invalid user id")
	if !ok {
		return
	}
	var req struct {
		Note string `json:"note"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	me := userFrom(r.Context())
	if err := s.st.UpsertUserNote(r.Context(), me.ID, subjectID, req.Note); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save note")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"note": req.Note})
}

func (s *Server) handleGetAvatar(w http.ResponseWriter, r *http.Request) {
	id, ok := requirePathInt(w, r, "id", "invalid user id")
	if !ok {
		return
	}
	mime, data, err := s.st.GetAvatar(r.Context(), id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mime)
	// A versioned URL (?v=<avatar_updated_at>) is safe to cache indefinitely;
	// fall back to 1 hour for unversioned requests (direct links, old clients).
	if r.URL.Query().Has("v") {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "private, max-age=3600")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
