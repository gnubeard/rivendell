// Package store is the data-access layer. It uses database/sql with the pure-Go
// github.com/lib/pq driver — the only third-party module in the entire backend.
// No ORM, no query builder: plain SQL, so every query is visible and auditable.
package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strings"
	"time"

	_ "github.com/lib/pq"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type Store struct {
	db *sql.DB
}

// Open connects to Postgres and verifies the connection.
func Open(ctx context.Context, dsn string) (*Store, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: open: %w", err)
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(time.Hour)
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// DB exposes the underlying handle for health checks.
func (s *Store) DB() *sql.DB { return s.db }

// Ping verifies the database connection is alive.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// Migrate applies any embedded migrations that have not yet run. Each migration
// runs in its own transaction and is recorded in schema_migrations.
func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("store: ensure schema_migrations: %w", err)
	}

	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("store: read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		var exists bool
		if err := s.db.QueryRowContext(ctx,
			`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)`, name,
		).Scan(&exists); err != nil {
			return fmt.Errorf("store: check migration %s: %w", name, err)
		}
		if exists {
			continue
		}
		sqlBytes, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("store: read %s: %w", name, err)
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("store: begin %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, string(sqlBytes)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("store: apply %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO schema_migrations (version) VALUES ($1)`, name); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("store: record %s: %w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("store: commit %s: %w", name, err)
		}
	}
	return nil
}

// --- Domain models -------------------------------------------------------

type Role string

const (
	RoleAdmin     Role = "admin"
	RoleModerator Role = "moderator"
	RoleMember    Role = "member"
)

type User struct {
	ID          int64      `json:"id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"display_name"`
	Role        Role       `json:"role"`
	Status      string     `json:"status"`
	StatusText  string     `json:"status_text"`
	Theme       string     `json:"theme"`
	HasAvatar   bool       `json:"has_avatar"`
	HasPassword bool       `json:"has_password"`
	IsActive    bool       `json:"is_active"`
	IsBot       bool       `json:"is_bot"`
	CreatedAt   time.Time  `json:"created_at"`
	LastSeenAt  *time.Time `json:"last_seen_at,omitempty"`
	IdentityKey *string    `json:"identity_key,omitempty"`
}

type Channel struct {
	ID         int64      `json:"id"`
	Name       string     `json:"name"`
	Topic      string     `json:"topic"`
	IsPrivate  bool       `json:"is_private"`
	IsDM       bool       `json:"is_dm"`
	Position   int        `json:"position"`
	CreatedAt  time.Time  `json:"created_at"`
	ArchivedAt *time.Time `json:"archived_at,omitempty"`
}

// ChannelUnread is the per-channel unread/mention summary for a user, returned
// by UnreadSummary. Unread counts messages the user hasn't seen (excluding their
// own and deleted ones); Mentions counts the subset that pinged them (DMs and
// @-mentions).
type ChannelUnread struct {
	ChannelID int64 `json:"channel_id"`
	Unread    int   `json:"unread"`
	Mentions  int   `json:"mentions"`
}

// Emoji is a custom instance-wide emoji. The image bytes are never included in
// list responses (only served by the dedicated image endpoint); ListEmojis
// leaves Mime/Data zero-valued.
type Emoji struct {
	ID        int64     `json:"id"`
	Shortcode string    `json:"shortcode"`
	CreatedBy *int64    `json:"created_by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type Message struct {
	ID        int64      `json:"id"`
	ChannelID int64      `json:"channel_id"`
	UserID    int64      `json:"user_id"`
	Content   string     `json:"content"`
	ReplyToID *int64     `json:"reply_to_id,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	EditedAt  *time.Time `json:"edited_at,omitempty"`
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
	PinnedAt  *time.Time `json:"pinned_at,omitempty"`
	PinnedBy  *int64     `json:"pinned_by,omitempty"`
	// Reactions is populated by the HTTP layer on list responses (not part of the
	// messages row); omitted when empty so the message JSON stays lean.
	Reactions []Reaction `json:"reactions,omitempty"`
}

// Reaction is one emoji's reaction group on a message: the emoji and the ids of
// the users who reacted with it (oldest first). Emoji is either a custom shortcode
// or a literal Unicode grapheme; the client resolves which when rendering. The
// server stays viewer-agnostic — the client derives count and "did I react" from
// UserIDs.
type Reaction struct {
	Emoji   string  `json:"emoji"`
	UserIDs []int64 `json:"user_ids"`
}

// BotToken is a permanent API credential for automated/bot access (no expiry,
// revoked explicitly by an admin). The raw token is never stored; only its
// SHA-256 hash lives in the database. Presented as a Bearer token in the
// Authorization header.
type BotToken struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

// Blob is a content-addressed image stored in the local blob store. The hash is
// a hex-encoded SHA-256 of the file bytes and serves as the primary key and the
// filename on disk. UploaderID may be nil if the uploader account was deleted.
type Blob struct {
	Hash        string    `json:"hash"`
	UploaderID  *int64    `json:"uploader_id,omitempty"`
	ContentType string    `json:"content_type"`
	Size        int64     `json:"size"`
	CreatedAt   time.Time `json:"created_at"`
}

// PushSubscription is a browser's Web Push registration for a user (one per
// device/browser). The keys are base64url, exactly as the PushSubscription
// exposes them; the server never decodes them except to encrypt a payload.
type PushSubscription struct {
	ID       int64  `json:"id"`
	UserID   int64  `json:"user_id"`
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
}
