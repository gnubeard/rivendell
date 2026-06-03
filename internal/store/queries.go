package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

var ErrNotFound = errors.New("store: not found")

// userCols is the canonical projection used by scanUser.
const userCols = `id, username, display_name, role, status, status_text,
	(avatar IS NOT NULL) AS has_avatar, (password_hash IS NOT NULL) AS has_password,
	is_active, created_at, last_seen_at`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	var lastSeen sql.NullTime
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status,
		&u.StatusText, &u.HasAvatar, &u.HasPassword, &u.IsActive, &u.CreatedAt, &lastSeen)
	if errors.Is(err, sql.ErrNoRows) {
		return u, ErrNotFound
	}
	if err != nil {
		return u, err
	}
	if lastSeen.Valid {
		u.LastSeenAt = &lastSeen.Time
	}
	return u, nil
}

// --- Users ---------------------------------------------------------------

func (s *Store) CreateUser(ctx context.Context, username, displayName string, role Role) (User, error) {
	row := s.db.QueryRowContext(ctx,
		`INSERT INTO users (username, display_name, role) VALUES ($1, $2, $3) RETURNING `+userCols,
		username, displayName, role)
	return scanUser(row)
}

func (s *Store) GetUserByID(ctx context.Context, id int64) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = $1`, id))
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE username = $1`, username))
}

// GetPasswordHash returns the stored hash (may be empty if unset).
func (s *Store) GetPasswordHash(ctx context.Context, id int64) (string, error) {
	var h sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id = $1`, id).Scan(&h)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return h.String, err
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userCols+` FROM users ORDER BY display_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) SetPassword(ctx context.Context, id int64, hash string) error {
	return s.exec(ctx, `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, id, hash)
}

func (s *Store) UpdateProfile(ctx context.Context, id int64, displayName, statusText string) error {
	return s.exec(ctx, `UPDATE users SET display_name = $2, status_text = $3, updated_at = now() WHERE id = $1`,
		id, displayName, statusText)
}

func (s *Store) SetStatus(ctx context.Context, id int64, status string) error {
	return s.exec(ctx, `UPDATE users SET status = $2, updated_at = now() WHERE id = $1`, id, status)
}

func (s *Store) SetRole(ctx context.Context, id int64, role Role) error {
	return s.exec(ctx, `UPDATE users SET role = $2, updated_at = now() WHERE id = $1`, id, role)
}

func (s *Store) SetActive(ctx context.Context, id int64, active bool) error {
	return s.exec(ctx, `UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1`, id, active)
}

func (s *Store) TouchLastSeen(ctx context.Context, id int64) error {
	return s.exec(ctx, `UPDATE users SET last_seen_at = now() WHERE id = $1`, id)
}

func (s *Store) SetAvatar(ctx context.Context, id int64, mime string, data []byte) error {
	return s.exec(ctx, `UPDATE users SET avatar = $2, avatar_mime = $3, updated_at = now() WHERE id = $1`,
		id, data, mime)
}

func (s *Store) GetAvatar(ctx context.Context, id int64) (mime string, data []byte, err error) {
	var m sql.NullString
	err = s.db.QueryRowContext(ctx, `SELECT avatar_mime, avatar FROM users WHERE id = $1`, id).Scan(&m, &data)
	if errors.Is(err, sql.ErrNoRows) || data == nil {
		return "", nil, ErrNotFound
	}
	return m.String, data, err
}

// CountAdmins is used to guard against demoting/deactivating the last admin.
func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT count(*) FROM users WHERE role = 'admin' AND is_active`).Scan(&n)
	return n, err
}

// --- Sessions ------------------------------------------------------------

func (s *Store) CreateSession(ctx context.Context, userID int64, tokenHash, userAgent string, expires time.Time) error {
	return s.exec(ctx,
		`INSERT INTO sessions (user_id, token_hash, user_agent, expires_at) VALUES ($1, $2, $3, $4)`,
		userID, tokenHash, userAgent, expires)
}

// UserForSession returns the active user owning a valid (unexpired) session and
// refreshes last_used_at. Returns ErrNotFound if missing, expired, or inactive.
func (s *Store) UserForSession(ctx context.Context, tokenHash string) (User, error) {
	var uid int64
	err := s.db.QueryRowContext(ctx,
		`UPDATE sessions SET last_used_at = now()
		 WHERE token_hash = $1 AND expires_at > now()
		 RETURNING user_id`, tokenHash).Scan(&uid)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}
	u, err := s.GetUserByID(ctx, uid)
	if err != nil {
		return User{}, err
	}
	if !u.IsActive {
		return User{}, ErrNotFound
	}
	return u, nil
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	return s.exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
}

func (s *Store) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < now()`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// --- Magic links ---------------------------------------------------------

func (s *Store) CreateMagicLink(ctx context.Context, userID int64, tokenHash, purpose string, createdBy int64, expires time.Time) error {
	return s.exec(ctx,
		`INSERT INTO magic_links (user_id, token_hash, purpose, created_by, expires_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		userID, tokenHash, purpose, createdBy, expires)
}

// ConsumeMagicLink atomically validates and marks a link used, returning the
// owning user id and purpose. A link is single-use and time-limited.
func (s *Store) ConsumeMagicLink(ctx context.Context, tokenHash string) (userID int64, purpose string, err error) {
	err = s.db.QueryRowContext(ctx,
		`UPDATE magic_links SET used_at = now()
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		 RETURNING user_id, purpose`, tokenHash).Scan(&userID, &purpose)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", ErrNotFound
	}
	return userID, purpose, err
}

// PeekMagicLink reads a link without consuming it, so the UI can decide which
// form to show (set vs reset) before the user actually submits a password.
// Returns ErrNotFound if the link is missing, used, or expired.
func (s *Store) PeekMagicLink(ctx context.Context, tokenHash string) (purpose string, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT purpose FROM magic_links
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
		tokenHash).Scan(&purpose)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return purpose, err
}

// --- Channels ------------------------------------------------------------

func (s *Store) CreateChannel(ctx context.Context, name, topic string, isPrivate bool, createdBy int64) (Channel, error) {
	var c Channel
	err := s.db.QueryRowContext(ctx,
		`INSERT INTO channels (name, topic, is_private, created_by)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, name, topic, is_private, position, created_at`,
		name, topic, isPrivate, createdBy).Scan(
		&c.ID, &c.Name, &c.Topic, &c.IsPrivate, &c.Position, &c.CreatedAt)
	return c, err
}

func (s *Store) ListChannels(ctx context.Context) ([]Channel, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, name, topic, is_private, position, created_at
		 FROM channels WHERE archived_at IS NULL
		 ORDER BY position, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Channel{}
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.Name, &c.Topic, &c.IsPrivate, &c.Position, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) GetChannel(ctx context.Context, id int64) (Channel, error) {
	var c Channel
	err := s.db.QueryRowContext(ctx,
		`SELECT id, name, topic, is_private, position, created_at FROM channels WHERE id = $1`, id).Scan(
		&c.ID, &c.Name, &c.Topic, &c.IsPrivate, &c.Position, &c.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

func (s *Store) UpdateChannel(ctx context.Context, id int64, topic string, position int) error {
	return s.exec(ctx, `UPDATE channels SET topic = $2, position = $3 WHERE id = $1`, id, topic, position)
}

func (s *Store) ArchiveChannel(ctx context.Context, id int64) error {
	return s.exec(ctx, `UPDATE channels SET archived_at = now() WHERE id = $1`, id)
}

func (s *Store) AddChannelMember(ctx context.Context, channelID, userID int64) error {
	return s.exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`, channelID, userID)
}

func (s *Store) IsChannelMember(ctx context.Context, channelID, userID int64) (bool, error) {
	var ok bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`,
		channelID, userID).Scan(&ok)
	return ok, err
}

// ListChannelMemberIDs returns the user ids that belong to a private channel.
func (s *Store) ListChannelMemberIDs(ctx context.Context, channelID int64) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT user_id FROM channel_members WHERE channel_id = $1`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// --- Messages ------------------------------------------------------------

func (s *Store) CreateMessage(ctx context.Context, channelID, userID int64, content string, replyTo *int64) (Message, error) {
	var m Message
	err := s.db.QueryRowContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content, reply_to_id)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, channel_id, user_id, content, reply_to_id, created_at, edited_at, deleted_at`,
		channelID, userID, content, replyTo).Scan(
		&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.ReplyToID, &m.CreatedAt, &m.EditedAt, &m.DeletedAt)
	return m, err
}

// ListMessages returns up to limit messages in a channel with id < beforeID
// (pass 0 for the most recent), oldest-first within the returned page.
func (s *Store) ListMessages(ctx context.Context, channelID int64, beforeID int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if beforeID <= 0 {
		beforeID = 1<<62 - 1
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, channel_id, user_id, content, reply_to_id, created_at, edited_at, deleted_at
		 FROM messages
		 WHERE channel_id = $1 AND id < $2
		 ORDER BY id DESC LIMIT $3`, channelID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.ReplyToID,
			&m.CreatedAt, &m.EditedAt, &m.DeletedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	// reverse to oldest-first
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, rows.Err()
}

func (s *Store) GetMessage(ctx context.Context, id int64) (Message, error) {
	var m Message
	err := s.db.QueryRowContext(ctx,
		`SELECT id, channel_id, user_id, content, reply_to_id, created_at, edited_at, deleted_at
		 FROM messages WHERE id = $1`, id).Scan(
		&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.ReplyToID, &m.CreatedAt, &m.EditedAt, &m.DeletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

func (s *Store) EditMessage(ctx context.Context, id, userID int64, content string) (Message, error) {
	var m Message
	err := s.db.QueryRowContext(ctx,
		`UPDATE messages SET content = $3, edited_at = now()
		 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		 RETURNING id, channel_id, user_id, content, reply_to_id, created_at, edited_at, deleted_at`,
		id, userID, content).Scan(
		&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.ReplyToID, &m.CreatedAt, &m.EditedAt, &m.DeletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

// SoftDeleteMessage marks a message deleted. modOverride allows admins/mods to
// delete others' messages; when false the delete only applies to the author's.
func (s *Store) SoftDeleteMessage(ctx context.Context, id, userID int64, modOverride bool) (Message, error) {
	q := `UPDATE messages SET deleted_at = now(), content = ''
	      WHERE id = $1 AND deleted_at IS NULL`
	args := []any{id}
	if !modOverride {
		q += ` AND user_id = $2`
		args = append(args, userID)
	}
	q += ` RETURNING id, channel_id, user_id, content, reply_to_id, created_at, edited_at, deleted_at`
	var m Message
	err := s.db.QueryRowContext(ctx, q, args...).Scan(
		&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.ReplyToID, &m.CreatedAt, &m.EditedAt, &m.DeletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

// --- helpers -------------------------------------------------------------

func (s *Store) exec(ctx context.Context, query string, args ...any) error {
	res, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// IsUniqueViolation reports whether err is a Postgres unique-constraint error.
// lib/pq returns *pq.Error with SQLState "23505" for unique violations; we
// match on the message to avoid importing the driver's error type here.
func IsUniqueViolation(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "duplicate key value") ||
		strings.Contains(err.Error(), "unique constraint"))
}
