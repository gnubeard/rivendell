// Package httpapi wires the store and the websocket hub to an HTTP API and the
// static web client. Routing uses the standard library net/http ServeMux with
// Go 1.22 method+pattern matching — no third-party router.
package httpapi

import (
	"context"
	"encoding/json"
	"html"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"rivendell/internal/auth"
	"rivendell/internal/config"
	"rivendell/internal/store"
	"rivendell/internal/ws"
)

const sessionCookie = "rivendell_session"

type typingKey struct{ channelID, userID int64 }

type Server struct {
	cfg          config.Config
	st           *store.Store
	hub          *ws.Hub
	typingMu     sync.Mutex
	typingTimers map[typingKey]*time.Timer
}

func New(cfg config.Config, st *store.Store) *Server {
	s := &Server{
		cfg:          cfg,
		st:           st,
		typingTimers: make(map[typingKey]*time.Timer),
	}
	s.hub = ws.NewHub(s.onPresenceChange, s.onWSMessage)
	return s
}

// Handler returns the fully-routed http.Handler with global middleware applied.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Auth (unauthenticated).
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/auth/magic/{token}", s.handleCheckMagic)
	mux.HandleFunc("POST /api/auth/set-password", s.handleSetPassword)

	// Self.
	mux.HandleFunc("GET /api/me", s.auth(s.handleMe))
	mux.HandleFunc("PATCH /api/me", s.auth(s.handleUpdateMe))
	mux.HandleFunc("PUT /api/me/status", s.auth(s.handleSetStatus))
	mux.HandleFunc("PUT /api/me/idle", s.auth(s.handleSetIdle))
	mux.HandleFunc("DELETE /api/me/idle", s.auth(s.handleClearIdle))
	mux.HandleFunc("POST /api/me/avatar", s.auth(s.handleUploadAvatar))

	// Users + presence.
	mux.HandleFunc("GET /api/users", s.auth(s.handleListUsers))
	mux.HandleFunc("GET /api/users/{id}/avatar", s.auth(s.handleGetAvatar))

	// Channels.
	mux.HandleFunc("GET /api/channels", s.auth(s.handleListChannels))
	mux.HandleFunc("POST /api/channels", s.requireRole(store.RoleModerator, s.handleCreateChannel))
	mux.HandleFunc("PATCH /api/channels/{id}", s.requireRole(store.RoleModerator, s.handleUpdateChannel))
	mux.HandleFunc("DELETE /api/channels/{id}", s.requireRole(store.RoleModerator, s.handleArchiveChannel))

	// Channel membership (private channels; invites require membership/mod+).
	mux.HandleFunc("GET /api/channels/{id}/members", s.auth(s.handleListChannelMembers))
	mux.HandleFunc("POST /api/channels/{id}/members", s.auth(s.handleAddChannelMember))
	mux.HandleFunc("DELETE /api/channels/{id}/members/{userId}", s.auth(s.handleRemoveChannelMember))

	// Direct messages (a DM is a two-member private channel; any user may open one).
	mux.HandleFunc("POST /api/dms", s.auth(s.handleCreateDM))

	// Messages.
	mux.HandleFunc("GET /api/channels/{id}/messages", s.auth(s.handleListMessages))
	mux.HandleFunc("POST /api/channels/{id}/messages", s.auth(s.handleCreateMessage))
	mux.HandleFunc("GET /api/channels/{id}/pins", s.auth(s.handleListPinnedMessages))
	mux.HandleFunc("PATCH /api/messages/{id}", s.auth(s.handleEditMessage))
	mux.HandleFunc("DELETE /api/messages/{id}", s.auth(s.handleDeleteMessage))
	// Pin/unpin: moderator+ in normal channels, but either participant in a DM.
	// The per-channel rule lives in the handler, so the route only needs auth.
	mux.HandleFunc("PUT /api/messages/{id}/pin", s.auth(s.handlePinMessage))
	mux.HandleFunc("DELETE /api/messages/{id}/pin", s.auth(s.handleUnpinMessage))

	// Durable unread / notifications.
	mux.HandleFunc("GET /api/unread", s.auth(s.handleUnread))
	mux.HandleFunc("POST /api/channels/{id}/read", s.auth(s.handleMarkRead))
	mux.HandleFunc("PUT /api/channels/{id}/mute", s.auth(s.handleMuteChannel))
	mux.HandleFunc("DELETE /api/channels/{id}/mute", s.auth(s.handleUnmuteChannel))

	// Admin.
	mux.HandleFunc("GET /api/admin/stats", s.requireRole(store.RoleAdmin, s.handleAdminStats))
	mux.HandleFunc("POST /api/admin/users", s.requireRole(store.RoleAdmin, s.handleCreateUser))
	mux.HandleFunc("POST /api/admin/users/{id}/magic-link", s.requireRole(store.RoleAdmin, s.handleCreateMagicLink))
	mux.HandleFunc("PUT /api/admin/users/{id}/role", s.requireRole(store.RoleAdmin, s.handleSetRole))
	mux.HandleFunc("PUT /api/admin/users/{id}/active", s.requireRole(store.RoleAdmin, s.handleSetActive))
	mux.HandleFunc("GET /api/admin/channels/archived", s.requireRole(store.RoleAdmin, s.handleListArchivedChannels))
	mux.HandleFunc("POST /api/admin/channels/{id}/restore", s.requireRole(store.RoleAdmin, s.handleRestoreChannel))
	mux.HandleFunc("DELETE /api/admin/channels/{id}", s.requireRole(store.RoleAdmin, s.handlePurgeChannel))

	// Realtime.
	mux.HandleFunc("GET /api/ws", s.handleWS)

	// Instance metadata (public; used for branding before login).
	mux.HandleFunc("GET /api/instance", s.handleInstance)

	// Health.
	mux.HandleFunc("GET /api/health", s.handleHealth)

	// Static web client (SPA fallback for non-/api routes).
	mux.HandleFunc("GET /", s.handleStatic)

	return s.recoverMW(s.logMW(mux))
}

// Hub exposes the websocket hub (used in tests).
func (s *Server) Hub() *ws.Hub { return s.hub }

// --- middleware ----------------------------------------------------------

func (s *Server) recoverMW(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic: %v\n%s", rec, debug.Stack())
				writeErr(w, http.StatusInternalServerError, "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(c int) { r.status = c; r.ResponseWriter.WriteHeader(c) }

func (s *Server) logMW(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		// Don't wrap the writer for websocket upgrades (need the Hijacker).
		if r.URL.Path == "/api/ws" {
			next.ServeHTTP(w, r)
			return
		}
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

// --- auth context --------------------------------------------------------

type ctxKey int

const userKey ctxKey = 0

func userFrom(ctx context.Context) store.User {
	u, _ := ctx.Value(userKey).(store.User)
	return u
}

// auth wraps a handler requiring a valid session.
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.currentUser(r)
		if !ok {
			writeErr(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey, u)))
	}
}

// requireRole wraps a handler requiring at least the given role
// (admin > moderator > member).
func (s *Server) requireRole(min store.Role, next http.HandlerFunc) http.HandlerFunc {
	return s.auth(func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if roleRank(u.Role) < roleRank(min) {
			writeErr(w, http.StatusForbidden, "insufficient privileges")
			return
		}
		next(w, r)
	})
}

func roleRank(r store.Role) int {
	switch r {
	case store.RoleAdmin:
		return 3
	case store.RoleModerator:
		return 2
	default:
		return 1
	}
}

func (s *Server) currentUser(r *http.Request) (store.User, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return store.User{}, false
	}
	u, err := s.st.UserForSession(r.Context(), auth.HashToken(c.Value))
	if err != nil {
		return store.User{}, false
	}
	return u, true
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cfg.Secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(s.cfg.SessionTTL),
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/",
		HttpOnly: true, Secure: s.cfg.Secure, SameSite: http.SameSiteLaxMode,
		MaxAge: -1,
	})
}

// --- realtime events -----------------------------------------------------

type event struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

func (s *Server) broadcast(typ string, payload any, audience map[int64]bool) {
	data, err := json.Marshal(event{Type: typ, Payload: payload})
	if err != nil {
		log.Printf("broadcast marshal: %v", err)
		return
	}
	s.hub.Broadcast(data, audience)
}

// audienceForChannel returns nil (everyone) for public channels, or the member
// set for private channels.
func (s *Server) audienceForChannel(ctx context.Context, ch store.Channel) map[int64]bool {
	if !ch.IsPrivate {
		return nil
	}
	ids, err := s.st.ListChannelMemberIDs(ctx, ch.ID)
	if err != nil {
		log.Printf("audienceForChannel: %v", err)
		return map[int64]bool{} // fail closed
	}
	set := make(map[int64]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	return set
}

// onPresenceChange is invoked by the hub when a user connects/disconnects.
// Connectivity is transient and lives in the hub; we deliberately do NOT write
// it back to users.status, which is the user's *chosen* presence (online/away/
// dnd/offline) and must survive reconnects. The broadcast reports effective
// online = connected AND the user isn't invisible (status "offline"), carrying
// the chosen status so clients can colour the dot.
func (s *Server) onPresenceChange(userID int64, online bool) {
	ctx := context.Background()
	u, err := s.st.GetUserByID(ctx, userID)
	if err != nil {
		log.Printf("presence lookup: %v", err)
		return
	}
	_ = s.st.TouchLastSeen(ctx, userID)
	s.broadcast("presence.update", map[string]any{
		"user_id": userID,
		"online":  online && u.Status != "offline",
		"status":  u.Status,
		"idle":    s.hub.IsIdle(userID),
	}, nil)
}

// onWSMessage is called by the hub for each inbound client frame. Currently
// handles only "typing" frames; anything else is silently ignored.
func (s *Server) onWSMessage(userID int64, data []byte) {
	var msg struct {
		Type      string `json:"type"`
		ChannelID int64  `json:"channel_id"`
	}
	if err := json.Unmarshal(data, &msg); err != nil || msg.Type != "typing" || msg.ChannelID == 0 {
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
	s.typingTimers[key] = time.AfterFunc(5*time.Second, func() {
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

// --- static files --------------------------------------------------------

// instanceNamePlaceholder is the token in index.html replaced with the
// configured instance name at serve time (so non-JS scrapers see the brand).
const instanceNamePlaceholder = "__RIVENDELL_INSTANCE__"

// versionPlaceholder is replaced with the running version in index.html and
// app.js so that a version bump busts the browser cache for all JS modules.
const versionPlaceholder = "__RIVENDELL_VERSION__"

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	clean := filepath.Clean(r.URL.Path)
	if clean == "/" {
		clean = "/index.html"
	}
	full := filepath.Join(s.cfg.WebDir, clean)
	// Prevent path traversal outside WebDir.
	if !strings.HasPrefix(full, filepath.Clean(s.cfg.WebDir)) {
		http.NotFound(w, r)
		return
	}
	base := filepath.Base(full)
	// index.html and app.js are templated; all other assets are served as-is.
	if base == "app.js" {
		s.serveTemplated(w, full, "application/javascript; charset=utf-8")
		return
	}
	if info, err := os.Stat(full); err == nil && !info.IsDir() && base != "index.html" {
		http.ServeFile(w, r, full)
		return
	}
	s.serveIndex(w, r)
}

func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	s.serveTemplated(w, filepath.Join(s.cfg.WebDir, "index.html"), "text/html; charset=utf-8")
}

func (s *Server) serveTemplated(w http.ResponseWriter, path, contentType string) {
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	out := strings.ReplaceAll(string(data), instanceNamePlaceholder, html.EscapeString(s.cfg.InstanceName))
	out = strings.ReplaceAll(out, versionPlaceholder, config.Version)
	w.Header().Set("Content-Type", contentType)
	_, _ = w.Write([]byte(out))
}

// --- JSON helpers --------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func pathInt(r *http.Request, name string) (int64, error) {
	return strconv.ParseInt(r.PathValue(name), 10, 64)
}
