package httpapi

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"rivendell/internal/auth"
	"rivendell/internal/store"
)

// --- auth ----------------------------------------------------------------

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &req) {
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
	if !decodeBody(w, r, &req) {
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

// --- admin ---------------------------------------------------------------

// handleCheckInvitation reports whether a signup invitation token is still
// redeemable, without consuming it, so the signup form can validate the link
// before the user fills it in. Unauthenticated (the whole point is onboarding a
// user who has no account yet).
func (s *Server) handleCheckInvitation(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if err := s.st.PeekInvitation(r.Context(), auth.HashToken(token)); err != nil {
		writeErr(w, http.StatusNotFound, "invitation is invalid or expired")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"valid": true})
}

// handleSignup redeems an invitation: the new user picks their own username and
// password, the display name defaults to the username, and the account is always
// created as a member. The invitation is consumed atomically with the account
// creation (store.RedeemInvitation). On success the user is logged in immediately.
// Unauthenticated.
func (s *Server) handleSignup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token    string `json:"token"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	if !reUsername.MatchString(username) {
		writeErr(w, http.StatusBadRequest, "username must be 2-32 chars of a-z, 0-9, or underscore")
		return
	}
	if len(req.Password) < 10 {
		writeErr(w, http.StatusBadRequest, "password must be at least 10 characters")
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create account")
		return
	}
	// Display name seeds from the username; the user can change it later.
	u, err := s.st.RedeemInvitation(r.Context(), auth.HashToken(req.Token), username, username, hash)
	if err != nil {
		if store.IsUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "username already taken")
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "invitation is invalid or expired")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not create account")
		return
	}
	// Start the new user caught up on existing public channels, so their first
	// login isn't a wall of unread history.
	if err := s.st.SeedPublicReadCursors(r.Context(), u.ID); err != nil {
		log.Printf("signup: seed public read cursors: %v", err)
	}
	// Log the user in immediately, mirroring the set-password flow.
	if err := s.startSession(w, r, u.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create session")
		return
	}
	// Tell everyone already online about the new account so their rosters and
	// message-author lookups resolve without a refresh. state.js's user.update
	// case upserts a previously-unknown id, so this is an insert for them.
	s.broadcast("user.update", u, nil)
	writeJSON(w, http.StatusCreated, u)
}

func (s *Server) handleCreateMagicLink(w http.ResponseWriter, r *http.Request) {
	admin := userFrom(r.Context())
	id, ok := requirePathInt(w, r, "id", "invalid user id")
	if !ok {
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
