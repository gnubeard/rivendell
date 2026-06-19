// Package httpapi wires the store and the websocket hub to an HTTP API and the
// static web client. Routing uses the standard library net/http ServeMux with
// Go 1.22 method+pattern matching — no third-party router.
package httpapi

import (
	"context"
	"errors"
	"log"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

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

// voiceGraceKey identifies a pending DM-call reconnection grace timer: the DM
// channel plus the user whose WS dropped mid-call (see scheduleDMTeardown).
type voiceGraceKey struct{ channelID, userID int64 }

type Server struct {
	cfg              config.Config
	st               *store.Store
	hub              *ws.Hub
	blobStore        *blobs.FSStore
	pusher           *push.Sender // nil if Web Push couldn't be initialised (push disabled)
	telemetryLog     *slog.Logger // dedicated logfmt logger for WebRTC debug telemetry
	typingMu         sync.Mutex
	typingTimers     map[typingKey]*time.Timer
	ringMu           sync.Mutex
	rings            map[int64]*activeRing // DM channelID → pending ring
	voiceGraceMu     sync.Mutex
	voiceGraceTimers map[voiceGraceKey]*time.Timer // pending DM-call reconnection grace timers
	inFlight         sync.Map                      // URL → struct{} for in-flight link-preview fetches
	previewClient    *http.Client                  // SSRF-guarded outbound client for link-preview fetches
}

func New(cfg config.Config, st *store.Store) *Server {
	s := &Server{
		cfg:              cfg,
		st:               st,
		typingTimers:     make(map[typingKey]*time.Timer),
		rings:            make(map[int64]*activeRing),
		voiceGraceTimers: make(map[voiceGraceKey]*time.Timer),
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
	s.previewClient = newPreviewClient(s.domainAllowed)
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
