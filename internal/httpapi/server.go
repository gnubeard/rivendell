// Package httpapi wires the store and the websocket hub to an HTTP API and the
// static web client. Routing uses the standard library net/http ServeMux with
// Go 1.22 method+pattern matching — no third-party router.
package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"rivendell/internal/auth"
	"rivendell/internal/blobs"
	"rivendell/internal/config"
	"rivendell/internal/push"
	"rivendell/internal/store"
	"rivendell/internal/ws"
)

// activeRing tracks a pending DM ring so the server can time it out.
type activeRing struct {
	callerID int64
	calleeID int64
	timer    *time.Timer
}

const sessionCookie = "rivendell_session"

type typingKey struct{ channelID, userID int64 }

type Server struct {
	cfg          config.Config
	st           *store.Store
	hub          *ws.Hub
	blobStore    *blobs.FSStore
	pusher       *push.Sender // nil if Web Push couldn't be initialised (push disabled)
	telemetryLog *slog.Logger // dedicated logfmt logger for WebRTC debug telemetry
	typingMu     sync.Mutex
	typingTimers map[typingKey]*time.Timer
	ringMu       sync.Mutex
	rings        map[int64]*activeRing // DM channelID → pending ring
	inFlight     sync.Map              // URL → struct{} for in-flight link-preview fetches
}

func New(cfg config.Config, st *store.Store) *Server {
	s := &Server{
		cfg:          cfg,
		st:           st,
		typingTimers: make(map[typingKey]*time.Timer),
		rings:        make(map[int64]*activeRing),
		// Telemetry goes to stdout as logfmt — greppable by eye and machine-parseable.
		// A test can swap this for a buffer-backed logger to capture emitted records.
		telemetryLog: slog.New(slog.NewTextHandler(os.Stdout, nil)),
	}
	s.hub = ws.NewHub(s.onPresenceChange, s.onWSMessage)
	if cfg.BlobsDir != "" {
		bs, err := blobs.NewFSStore(cfg.BlobsDir)
		if err != nil {
			log.Printf("blob store: %v; file uploads disabled", err)
		} else {
			s.blobStore = bs
		}
	}
	s.initPush()
	return s
}

// initPush loads (or, on first boot, generates and persists) this server's VAPID
// keypair and builds the push Sender. Any failure logs and leaves push disabled
// rather than blocking startup — offline notifications are a best-effort extra.
func (s *Server) initPush() {
	ctx := context.Background()
	privB64, pubB64, err := s.st.GetVAPIDKeys(ctx)
	if errors.Is(err, store.ErrNotFound) {
		priv, pub, gerr := push.GenerateVAPIDKeys()
		if gerr != nil {
			log.Printf("push: generate VAPID keys: %v; push disabled", gerr)
			return
		}
		if serr := s.st.SaveVAPIDKeys(ctx, priv, pub); serr != nil {
			log.Printf("push: persist VAPID keys: %v; push disabled", serr)
			return
		}
		// Re-read so a concurrent boot that won the INSERT race wins the keys too.
		privB64, pubB64, err = s.st.GetVAPIDKeys(ctx)
	}
	if err != nil {
		log.Printf("push: load VAPID keys: %v; push disabled", err)
		return
	}
	sender, err := push.NewSender(privB64, s.cfg.VapidSubject)
	if err != nil {
		log.Printf("push: %v; push disabled", err)
		return
	}
	s.pusher = sender
	log.Printf("push: web push enabled (VAPID public key %s)", pubB64)
}

// Handler returns the fully-routed http.Handler with global middleware applied.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Auth (unauthenticated).
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/auth/magic/{token}", s.handleCheckMagic)
	mux.HandleFunc("POST /api/auth/set-password", s.handleSetPassword)
	// Signup via an admin-issued invitation (new members create their own account).
	mux.HandleFunc("GET /api/auth/invitation/{token}", s.handleCheckInvitation)
	mux.HandleFunc("POST /api/auth/signup", s.handleSignup)

	// Self.
	mux.HandleFunc("GET /api/me", s.auth(s.handleMe))
	mux.HandleFunc("PATCH /api/me", s.auth(s.handleUpdateMe))
	mux.HandleFunc("PUT /api/me/status", s.auth(s.handleSetStatus))
	mux.HandleFunc("POST /api/me/avatar", s.auth(s.handleUploadAvatar))
	mux.HandleFunc("PUT /api/me/identity-key", s.auth(s.handlePublishIdentityKey))

	// Users + presence.
	mux.HandleFunc("GET /api/users", s.auth(s.handleListUsers))
	mux.HandleFunc("GET /api/users/{id}/avatar", s.auth(s.handleGetAvatar))
	mux.HandleFunc("GET /api/users/{id}/note", s.auth(s.handleGetUserNote))
	mux.HandleFunc("PUT /api/users/{id}/note", s.auth(s.handlePutUserNote))

	// Custom emojis (instance-wide). Listing/image are any authed user; create
	// and delete are moderator+ (managed from the emoji picker or admin panel).
	mux.HandleFunc("GET /api/emojis", s.auth(s.handleListEmojis))
	mux.HandleFunc("POST /api/emojis", s.requireRole(store.RoleModerator, s.handleCreateEmoji))
	mux.HandleFunc("DELETE /api/emojis/{shortcode}", s.requireRole(store.RoleModerator, s.handleDeleteEmoji))
	mux.HandleFunc("GET /api/emojis/{shortcode}/image", s.auth(s.handleGetEmojiImage))

	// Channels.
	mux.HandleFunc("GET /api/channels", s.auth(s.handleListChannels))
	mux.HandleFunc("POST /api/channels", s.requireRole(store.RoleModerator, s.handleCreateChannel))
	mux.HandleFunc("GET /api/channels/{id}", s.auth(s.handleGetChannel))
	mux.HandleFunc("PATCH /api/channels/{id}", s.requireRole(store.RoleModerator, s.handleUpdateChannel))
	mux.HandleFunc("DELETE /api/channels/{id}", s.requireRole(store.RoleModerator, s.handleArchiveChannel))

	// Channel membership (private channels; invites require membership/mod+).
	mux.HandleFunc("GET /api/channels/{id}/members", s.auth(s.handleListChannelMembers))
	mux.HandleFunc("POST /api/channels/{id}/members", s.auth(s.handleAddChannelMember))
	mux.HandleFunc("DELETE /api/channels/{id}/members/{userId}", s.auth(s.handleRemoveChannelMember))

	// Direct messages (a DM is a two-member private channel; any user may open one).
	// Open state is server-authoritative: POST opens/finds, DELETE hides it for
	// the caller (per-user; the channel and its history are untouched).
	mux.HandleFunc("POST /api/dms", s.auth(s.handleCreateDM))
	mux.HandleFunc("DELETE /api/dms/{id}", s.auth(s.handleCloseDM))

	// Messages.
	mux.HandleFunc("GET /api/search", s.auth(s.handleSearch))
	mux.HandleFunc("GET /api/channels/{id}/messages", s.auth(s.handleListMessages))
	mux.HandleFunc("POST /api/channels/{id}/messages", s.auth(s.handleCreateMessage))
	mux.HandleFunc("GET /api/channels/{id}/pins", s.auth(s.handleListPinnedMessages))
	mux.HandleFunc("GET /api/messages/{id}", s.auth(s.handleGetMessage))
	mux.HandleFunc("PATCH /api/messages/{id}", s.auth(s.handleEditMessage))
	mux.HandleFunc("DELETE /api/messages/{id}", s.auth(s.handleDeleteMessage))
	// Pin/unpin: moderator+ in normal channels, but either participant in a DM.
	// The per-channel rule lives in the handler, so the route only needs auth.
	mux.HandleFunc("PUT /api/messages/{id}/pin", s.auth(s.handlePinMessage))
	mux.HandleFunc("DELETE /api/messages/{id}/pin", s.auth(s.handleUnpinMessage))
	// Reactions: any member who can access the channel may add/remove their own.
	// The emoji is carried in the request body (handles Unicode without encoding).
	mux.HandleFunc("PUT /api/messages/{id}/reactions", s.auth(s.handleAddReaction))
	mux.HandleFunc("DELETE /api/messages/{id}/reactions", s.auth(s.handleRemoveReaction))

	// Durable unread / notifications.
	mux.HandleFunc("GET /api/unread", s.auth(s.handleUnread))
	mux.HandleFunc("POST /api/channels/{id}/read", s.auth(s.handleMarkRead))
	mux.HandleFunc("POST /api/channels/{id}/unread", s.auth(s.handleMarkUnread))
	mux.HandleFunc("PUT /api/channels/{id}/mute", s.auth(s.handleMuteChannel))
	mux.HandleFunc("DELETE /api/channels/{id}/mute", s.auth(s.handleUnmuteChannel))

	// File uploads (images only). POST returns {hash,url,content_type,size};
	// GET serves the blob gated behind session auth with a long-lived cache header.
	mux.HandleFunc("POST /api/uploads", s.auth(s.handleUploadBlob))
	mux.HandleFunc("GET /api/blobs/{hash}", s.auth(s.handleGetBlob))

	// Admin.
	mux.HandleFunc("GET /api/admin/stats", s.requireRole(store.RoleAdmin, s.handleAdminStats))
	// Signup invitations (new-user onboarding). Password set/reset for an
	// existing user stays on the magic-link endpoint below.
	mux.HandleFunc("GET /api/admin/invitations", s.requireRole(store.RoleAdmin, s.handleListInvitations))
	mux.HandleFunc("POST /api/admin/invitations", s.requireRole(store.RoleAdmin, s.handleCreateInvitation))
	mux.HandleFunc("DELETE /api/admin/invitations/{id}", s.requireRole(store.RoleAdmin, s.handleDeleteInvitation))
	mux.HandleFunc("POST /api/admin/users/{id}/magic-link", s.requireRole(store.RoleAdmin, s.handleCreateMagicLink))
	mux.HandleFunc("PUT /api/admin/users/{id}/role", s.requireRole(store.RoleAdmin, s.handleSetRole))
	mux.HandleFunc("PUT /api/admin/users/{id}/active", s.requireRole(store.RoleAdmin, s.handleSetActive))
	mux.HandleFunc("PUT /api/admin/users/{id}/bot", s.requireRole(store.RoleAdmin, s.handleSetBot))
	mux.HandleFunc("POST /api/admin/users/{id}/avatar", s.requireRole(store.RoleAdmin, s.handleAdminSetAvatar))
	mux.HandleFunc("DELETE /api/admin/users/{id}/avatar", s.requireRole(store.RoleAdmin, s.handleAdminClearAvatar))
	mux.HandleFunc("GET /api/admin/channels/archived", s.requireRole(store.RoleAdmin, s.handleListArchivedChannels))
	mux.HandleFunc("POST /api/admin/channels/{id}/restore", s.requireRole(store.RoleAdmin, s.handleRestoreChannel))
	mux.HandleFunc("DELETE /api/admin/channels/{id}", s.requireRole(store.RoleAdmin, s.handlePurgeChannel))

	// Bot tokens (permanent Bearer credentials for automated/bot access).
	mux.HandleFunc("GET /api/admin/bot-tokens", s.requireRole(store.RoleAdmin, s.handleListBotTokens))
	mux.HandleFunc("POST /api/admin/bot-tokens", s.requireRole(store.RoleAdmin, s.handleCreateBotToken))
	mux.HandleFunc("DELETE /api/admin/bot-tokens/{id}", s.requireRole(store.RoleAdmin, s.handleDeleteBotToken))

	// Web Push (offline notifications). The public key seeds pushManager.subscribe;
	// subscribe/unsubscribe register and clear a browser's subscription.
	mux.HandleFunc("GET /api/push/key", s.auth(s.handlePushKey))
	mux.HandleFunc("POST /api/push/subscribe", s.auth(s.handlePushSubscribe))
	mux.HandleFunc("POST /api/push/unsubscribe", s.auth(s.handlePushUnsubscribe))

	// Link preview proxy (og: meta-tag cache).
	mux.HandleFunc("GET /api/link-preview", s.auth(s.handleGetLinkPreview))

	// Voice / WebRTC.
	mux.HandleFunc("GET /api/voice/state", s.auth(s.handleGetVoiceState))
	mux.HandleFunc("GET /api/channels/{id}/voice", s.auth(s.handleGetVoiceParticipants))
	mux.HandleFunc("GET /api/rtc/credentials", s.auth(s.handleGetRTCCredentials))

	// WebRTC debug telemetry (gated by RIVENDELL_DEBUG_TELEMETRY; 404 when off).
	mux.HandleFunc("POST /api/debug/telemetry", s.auth(s.handleDebugTelemetry))

	// Realtime.
	mux.HandleFunc("GET /api/ws", s.handleWS)

	// Instance metadata (public; used for branding before login).
	mux.HandleFunc("GET /api/instance", s.handleInstance)

	// Health.
	mux.HandleFunc("GET /api/health", s.handleHealth)

	// Versioned static modules (/v/<version>/…) — path-based cache-busting for
	// the ES-module client. More specific than "GET /", so it wins for that
	// subtree. See handleVersionedStatic.
	mux.HandleFunc("GET /v/", s.handleVersionedStatic)

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
	// Session cookie (browser / normal login).
	if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
		if u, err := s.st.UserForSession(r.Context(), auth.HashToken(c.Value)); err == nil {
			return u, true
		}
	}
	// Bearer token (bot / API access; no cookie, no redirect).
	if hdr := r.Header.Get("Authorization"); strings.HasPrefix(hdr, "Bearer ") {
		if token := strings.TrimPrefix(hdr, "Bearer "); token != "" {
			if u, err := s.st.UserForBotToken(r.Context(), auth.HashToken(token)); err == nil {
				return u, true
			}
		}
	}
	return store.User{}, false
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

// broadcastUserUpdate reloads user id and fans out a user.update frame so all
// clients refresh their cached copy. The reload error is intentionally
// swallowed: callers invoke this right after writing the row in the same
// request, so a failure here is vanishingly unlikely and not worth failing an
// already-succeeded mutation over. Returns the (possibly zero) reloaded user
// for handlers that echo it in their response body.
func (s *Server) broadcastUserUpdate(ctx context.Context, id int64) store.User {
	updated, _ := s.st.GetUserByID(ctx, id)
	s.broadcast("user.update", updated, nil)
	return updated
}

// channelVisibleTo reports whether u may see ch, using the same logic as
// canAccessChannel but accepting a plain context so it can be called from
// non-HTTP paths (e.g. audienceForChannel).
func (s *Server) channelVisibleTo(ctx context.Context, ch store.Channel, u store.User) bool {
	if !ch.IsPrivate {
		return true
	}
	member, err := s.st.IsChannelMember(ctx, ch.ID, u.ID)
	isMember := err == nil && member
	if ch.IsDM {
		return isMember
	}
	return isMember || roleRank(u.Role) >= roleRank(store.RoleAdmin)
}

// audienceForChannel returns nil (everyone) for public channels, or the set of
// users who may receive a private channel's realtime events. It delegates to
// channelVisibleTo so the visibility predicate has exactly one implementation.
func (s *Server) audienceForChannel(ctx context.Context, ch store.Channel) map[int64]bool {
	if !ch.IsPrivate {
		return nil
	}
	users, err := s.st.ListUsers(ctx)
	if err != nil {
		log.Printf("audienceForChannel: %v", err)
		return map[int64]bool{} // fail closed
	}
	set := make(map[int64]bool, len(users))
	for _, u := range users {
		if s.channelVisibleTo(ctx, ch, u) {
			set[u.ID] = true
		}
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
	if !online {
		s.cleanupVoiceForUser(ctx, userID)
	}
}

// cleanupVoiceForUser removes the user from any voice channel they were in and
// broadcasts updated voice.state for each affected channel. DM calls are
// phone-call style: if the dropped user leaves the other party alone in a DM
// call, that call ends for them too (see endDMVoiceCall).
func (s *Server) cleanupVoiceForUser(ctx context.Context, userID int64) {
	affected := s.hub.VoiceLeaveAll(userID)
	for chID, participants := range affected {
		ch, err := s.st.GetChannel(ctx, chID)
		if err != nil {
			continue
		}
		if ch.IsDM && len(participants) > 0 {
			// At least one other participant remains, so the call was active.
			s.endDMVoiceCall(ch, userID, true)
			continue
		}
		aud := s.audienceForChannel(ctx, ch)
		s.broadcast("voice.state", map[string]any{
			"channel_id":   chID,
			"participants": participants,
		}, aud)
	}
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
	ids := s.hub.VoiceClear(ch.ID)
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
	aud := s.audienceForChannel(context.Background(), ch)
	s.broadcast("voice.state", map[string]any{
		"channel_id":   ch.ID,
		"participants": []ws.VoiceParticipant{},
	}, aud)
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
		s.handleVoiceWSMessage(c, data, msg.Type, msg.ChannelID, msg.DMChannelID, msg.ToUserID, msg.Muted, msg.VideoMuted, msg.Accept)
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
func (s *Server) handleVoiceWSMessage(c *ws.Client, raw []byte, msgType string, channelID, dmChannelID, toUserID int64, muted, videoMuted, accept bool) {
	userID := c.UserID()
	ctx := context.Background()

	// relayToUser re-encodes the client frame as a server event envelope, injects
	// from_user_id, and delivers it to a specific user.
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

	// canAccess checks whether a user may participate in the channel.
	canAccess := func(ch store.Channel, uid int64) bool {
		if !ch.IsPrivate {
			return true
		}
		member, err := s.st.IsChannelMember(ctx, ch.ID, uid)
		isMember := err == nil && member
		if ch.IsDM {
			return isMember
		}
		u, err := s.st.GetUserByID(ctx, uid)
		if err != nil {
			return isMember
		}
		return isMember || roleRank(u.Role) >= roleRank(store.RoleModerator)
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
		for chID, pts := range s.hub.VoiceLeaveAll(userID) {
			if chID == channelID {
				continue
			}
			oldCh, err := s.st.GetChannel(ctx, chID)
			if err != nil {
				continue
			}
			aud := s.audienceForChannel(ctx, oldCh)
			s.broadcast("voice.state", map[string]any{"channel_id": chID, "participants": pts}, aud)
		}
		participants := s.hub.VoiceJoin(channelID, userID)
		aud := s.audienceForChannel(ctx, ch)
		s.broadcast("voice.state", map[string]any{"channel_id": channelID, "participants": participants}, aud)
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
		participants := s.hub.VoiceLeave(channelID, userID)
		aud := s.audienceForChannel(ctx, ch)
		s.broadcast("voice.state", map[string]any{"channel_id": channelID, "participants": participants}, aud)

	case "voice.offer", "voice.answer", "voice.ice":
		if channelID == 0 || toUserID == 0 {
			return
		}
		ch, err := s.st.GetChannel(ctx, channelID)
		if err != nil || !canAccess(ch, userID) || !canAccess(ch, toUserID) {
			return
		}
		relayToUser(toUserID)

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
		participants := s.hub.VoiceSetMute(channelID, userID, muted, videoMuted)
		aud := s.audienceForChannel(ctx, ch)
		s.broadcast("voice.state", map[string]any{"channel_id": channelID, "participants": participants}, aud)

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
		relayToUser(calleeID)

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
		relayToUser(otherID)
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
		// {dm_channel_id, from_user_id} under a voice.ring envelope.
		frame, err := json.Marshal(event{Type: "voice.ring", Payload: map[string]int64{
			"dm_channel_id": chID,
			"from_user_id":  r.callerID,
		}})
		if err != nil {
			continue
		}
		frames = append(frames, frame)
	}
	return frames
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

// --- static files --------------------------------------------------------

// instanceNamePlaceholder is the token in index.html replaced with the
// configured instance name at serve time (so non-JS scrapers see the brand).
const instanceNamePlaceholder = "__RIVENDELL_INSTANCE__"

// versionPlaceholder is replaced with the running version at serve time. It
// now survives in only two templated files: index.html (the module entry's
// `/v/<version>/…` path + the style.css cache-bust) and sw.js (a comment whose
// bytes change so the browser re-installs the worker on a new build).
//
// The ES-module client is cache-busted by PATH, not by this token: the entry
// loads from `/v/<version>/static/app.js` and every relative import stays under
// that prefix, so one page load resolves each module to exactly one URL = one
// instance (the single-instance guarantee for stateful modules like secret.js).
// Module source files therefore carry no placeholder and are served raw — see
// handleVersionedStatic. A bumped version changes the prefix => all module URLs
// change at once => a clean cache miss.
const versionPlaceholder = "__RIVENDELL_VERSION__"

// handleVersionedStatic serves `/v/<version>/<path>` by stripping the version
// segment and serving the underlying static file raw, with an immutable cache.
// <version> is a pure cache key — its value is ignored, so an old in-flight page
// importing `/v/<old>/static/api.js` still gets the current file; consistency
// within a single page load is guaranteed because all of its imports share one
// prefix. Stripping the prefix yields the exact path handleStatic maps to disk,
// so this works identically in prod (`/v/X/static/app.js` → WebDir/static/app.js)
// and in tests (`/v/X/foo.js` → WebDir/foo.js).
func (s *Server) handleVersionedStatic(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v/")
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		http.NotFound(w, r)
		return
	}
	logical := filepath.Clean(rest[slash:]) // drop the version segment, keep the path
	full := filepath.Join(s.cfg.WebDir, logical)
	// Prevent path traversal outside WebDir (mirrors handleStatic).
	if !strings.HasPrefix(full, filepath.Clean(s.cfg.WebDir)) {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	// Versioned path => this exact response is immutable; a version bump changes
	// the URL. No templating: module sources carry no placeholder.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeFile(w, r, full)
}

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
	// .js served here is /sw.js (templated: its placeholder comment re-installs
	// the worker on a new build) — and, defensively, any unversioned legacy
	// module path, for which the rewrite is a harmless no-op. The real module
	// entry loads via /v/<version>/ (handleVersionedStatic), not here.
	if strings.HasSuffix(base, ".js") {
		s.serveTemplated(w, r, full, "application/javascript; charset=utf-8")
		return
	}
	if info, err := os.Stat(full); err == nil && !info.IsDir() && base != "index.html" {
		http.ServeFile(w, r, full)
		return
	}
	s.serveIndex(w, r)
}

func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	s.serveTemplated(w, r, filepath.Join(s.cfg.WebDir, "index.html"), "text/html; charset=utf-8")
}

func (s *Server) serveTemplated(w http.ResponseWriter, r *http.Request, path, contentType string) {
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	out := strings.ReplaceAll(string(data), instanceNamePlaceholder, html.EscapeString(s.cfg.InstanceName))
	out = strings.ReplaceAll(out, versionPlaceholder, config.Version)
	etag := fmt.Sprintf(`"%x"`, sha256.Sum256([]byte(out)))
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("ETag", etag)
	if r.URL.Query().Has("v") {
		// Versioned URL (?v=X) — module imports always carry it, so this exact
		// response is immutable; a version bump changes the URL.
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		// Unversioned (index.html, /sw.js) must revalidate to pick up new
		// references, but can short-circuit with a 304 via ETag.
		w.Header().Set("Cache-Control", "no-cache, private")
	}
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

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := readJSON(r, v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

func pathInt(r *http.Request, name string) (int64, error) {
	return strconv.ParseInt(r.PathValue(name), 10, 64)
}

// requirePathInt parses an integer path value, writing a 400 with msg and
// returning ok=false if it is missing or malformed. Mirrors decodeBody's
// "guard at the top of the handler" shape: `if !ok { return }`.
func requirePathInt(w http.ResponseWriter, r *http.Request, name, msg string) (int64, bool) {
	id, err := pathInt(r, name)
	if err != nil {
		writeErr(w, http.StatusBadRequest, msg)
		return 0, false
	}
	return id, true
}
