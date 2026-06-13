package store

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
)

var ErrNotFound = errors.New("store: not found")

// userCols is the canonical projection used by scanUser.
const userCols = `id, username, display_name, role, status, status_text, theme, pronouns, bio,
	(avatar IS NOT NULL) AS has_avatar, avatar_updated_at, (password_hash IS NOT NULL) AS has_password,
	is_active, is_bot, created_at, last_seen_at, identity_key`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	var lastSeen sql.NullTime
	var identityKey sql.NullString
	var avatarUpdatedAt sql.NullTime
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status,
		&u.StatusText, &u.Theme, &u.Pronouns, &u.Bio, &u.HasAvatar, &avatarUpdatedAt, &u.HasPassword, &u.IsActive, &u.IsBot, &u.CreatedAt, &lastSeen, &identityKey)
	if errors.Is(err, sql.ErrNoRows) {
		return u, ErrNotFound
	}
	if err != nil {
		return u, err
	}
	if avatarUpdatedAt.Valid {
		u.AvatarUpdatedAt = &avatarUpdatedAt.Time
	}
	if lastSeen.Valid {
		u.LastSeenAt = &lastSeen.Time
	}
	if identityKey.Valid {
		u.IdentityKey = &identityKey.String
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
	return collectRows(rows, scanUser)
}

func (s *Store) SetPassword(ctx context.Context, id int64, hash string) error {
	return s.exec(ctx, `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, id, hash)
}

func (s *Store) UpdateProfile(ctx context.Context, id int64, displayName, statusText, theme, pronouns, bio string) error {
	return s.exec(ctx, `UPDATE users SET display_name = $2, status_text = $3, theme = $4, pronouns = $5, bio = $6, updated_at = now() WHERE id = $1`,
		id, displayName, statusText, theme, pronouns, bio)
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

func (s *Store) SetBot(ctx context.Context, id int64, bot bool) error {
	return s.exec(ctx, `UPDATE users SET is_bot = $2, updated_at = now() WHERE id = $1`, id, bot)
}

func (s *Store) SetIdentityKey(ctx context.Context, id int64, key string) error {
	return s.exec(ctx, `UPDATE users SET identity_key = $2, identity_key_updated_at = now(), updated_at = now() WHERE id = $1`, id, key)
}

func (s *Store) TouchLastSeen(ctx context.Context, id int64) error {
	return s.exec(ctx, `UPDATE users SET last_seen_at = now() WHERE id = $1`, id)
}

func (s *Store) SetAvatar(ctx context.Context, id int64, mime string, data []byte) error {
	return s.exec(ctx, `UPDATE users SET avatar = $2, avatar_mime = $3, avatar_updated_at = now(), updated_at = now() WHERE id = $1`,
		id, data, mime)
}

func (s *Store) ClearAvatar(ctx context.Context, id int64) error {
	return s.exec(ctx, `UPDATE users SET avatar = NULL, avatar_mime = NULL, avatar_updated_at = NULL, updated_at = now() WHERE id = $1`, id)
}

func (s *Store) GetAvatar(ctx context.Context, id int64) (mime string, data []byte, err error) {
	var m sql.NullString
	err = s.db.QueryRowContext(ctx, `SELECT avatar_mime, avatar FROM users WHERE id = $1`, id).Scan(&m, &data)
	if errors.Is(err, sql.ErrNoRows) || data == nil {
		return "", nil, ErrNotFound
	}
	return m.String, data, err
}

// --- Emojis --------------------------------------------------------------

// ListEmojis returns every custom emoji, alphabetically by shortcode. The image
// bytes are deliberately omitted (served by GetEmojiImage); a fresh non-nil slice
// keeps an empty result serializing as [] rather than JSON null.
func (s *Store) ListEmojis(ctx context.Context) ([]Emoji, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, shortcode, created_by, created_at FROM emojis ORDER BY shortcode`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Emoji{}
	for rows.Next() {
		var e Emoji
		var createdBy sql.NullInt64
		if err := rows.Scan(&e.ID, &e.Shortcode, &createdBy, &e.CreatedAt); err != nil {
			return nil, err
		}
		if createdBy.Valid {
			e.CreatedBy = &createdBy.Int64
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// CreateEmoji inserts a custom emoji and returns its metadata record. A duplicate
// shortcode surfaces as a unique-violation the caller maps to 409.
func (s *Store) CreateEmoji(ctx context.Context, shortcode, mime string, data []byte, createdBy int64) (Emoji, error) {
	var e Emoji
	var cb sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`INSERT INTO emojis (shortcode, mime, data, created_by) VALUES ($1, $2, $3, $4)
		 RETURNING id, shortcode, created_by, created_at`,
		shortcode, mime, data, createdBy).Scan(&e.ID, &e.Shortcode, &cb, &e.CreatedAt)
	if err != nil {
		return Emoji{}, err
	}
	if cb.Valid {
		e.CreatedBy = &cb.Int64
	}
	return e, nil
}

// GetEmojiImage returns the MIME type and raw bytes for a shortcode, or
// ErrNotFound if no such emoji exists.
func (s *Store) GetEmojiImage(ctx context.Context, shortcode string) (mime string, data []byte, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT mime, data FROM emojis WHERE shortcode = $1`, shortcode).Scan(&mime, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	return mime, data, err
}

// DeleteEmoji removes a custom emoji by shortcode; ErrNotFound if it's absent.
func (s *Store) DeleteEmoji(ctx context.Context, shortcode string) error {
	return s.exec(ctx, `DELETE FROM emojis WHERE shortcode = $1`, shortcode)
}

// EmojiExists reports whether a custom emoji with the given shortcode exists. Used
// to reject reactions that reference a shortcode with no backing image.
func (s *Store) EmojiExists(ctx context.Context, shortcode string) (bool, error) {
	var ok bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM emojis WHERE shortcode = $1)`, shortcode).Scan(&ok)
	return ok, err
}

// ListAdminUserIDs returns the ids of active admins. Admins hold a read/write
// bypass on private (non-DM) channels even when they aren't members, so
// realtime audiences for those channels include them — keeping the realtime
// delivery model in step with canAccessChannel.
func (s *Store) ListAdminUserIDs(ctx context.Context) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id FROM users WHERE is_active AND role = 'admin'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// CountAdmins is used to guard against demoting/deactivating the last admin.
func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT count(*) FROM users WHERE role = 'admin' AND is_active`).Scan(&n)
	return n, err
}

// CountChannels returns the number of live (non-archived) channels, DMs
// included. Used by first-boot bootstrap to decide whether to seed a default
// channel on a fresh instance.
func (s *Store) CountChannels(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT count(*) FROM channels WHERE archived_at IS NULL`).Scan(&n)
	return n, err
}

// Stats holds at-a-glance server metrics for the admin panel.
type Stats struct {
	TotalUsers      int `json:"total_users"`
	ActiveUsers     int `json:"active_users"`
	PublicChannels  int `json:"public_channels"`
	PrivateChannels int `json:"private_channels"`
	DMChannels      int `json:"dm_channels"`
	TotalMessages   int `json:"total_messages"`
}

// GetStats returns a snapshot of server-wide counts in a single round-trip.
func (s *Store) GetStats(ctx context.Context) (Stats, error) {
	var st Stats
	err := s.db.QueryRowContext(ctx, `
		SELECT
			(SELECT count(*) FROM users)                                                          AS total_users,
			(SELECT count(*) FROM users WHERE is_active)                                          AS active_users,
			(SELECT count(*) FROM channels WHERE archived_at IS NULL AND is_dm = false AND is_private = false) AS public_channels,
			(SELECT count(*) FROM channels WHERE archived_at IS NULL AND is_dm = false AND is_private = true)  AS private_channels,
			(SELECT count(*) FROM channels WHERE archived_at IS NULL AND is_dm = true)            AS dm_channels,
			(SELECT count(*) FROM messages WHERE deleted_at IS NULL)                              AS total_messages
	`).Scan(&st.TotalUsers, &st.ActiveUsers, &st.PublicChannels, &st.PrivateChannels, &st.DMChannels, &st.TotalMessages)
	return st, err
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

// --- Bot tokens ----------------------------------------------------------

func (s *Store) CreateBotToken(ctx context.Context, userID int64, tokenHash, name string) (BotToken, error) {
	var t BotToken
	err := s.db.QueryRowContext(ctx,
		`INSERT INTO bot_tokens (user_id, token_hash, name)
		 VALUES ($1, $2, $3)
		 RETURNING id, user_id, name, created_at`,
		userID, tokenHash, name).Scan(&t.ID, &t.UserID, &t.Name, &t.CreatedAt)
	return t, err
}

// UserForBotToken looks up the active user that owns a bot token. Returns
// ErrNotFound if the token doesn't exist or the associated user is inactive.
func (s *Store) UserForBotToken(ctx context.Context, tokenHash string) (User, error) {
	var uid int64
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id FROM bot_tokens WHERE token_hash = $1`, tokenHash).Scan(&uid)
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

func (s *Store) ListBotTokens(ctx context.Context) ([]BotToken, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, name, created_at FROM bot_tokens ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BotToken{}
	for rows.Next() {
		var t BotToken
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) DeleteBotToken(ctx context.Context, id int64) error {
	return s.exec(ctx, `DELETE FROM bot_tokens WHERE id = $1`, id)
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

// --- Invitations ---------------------------------------------------------

// CreateInvitation stores a new single-use signup invitation and returns the
// persisted row (so the admin UI can list it immediately).
func (s *Store) CreateInvitation(ctx context.Context, tokenHash string, createdBy int64, expires time.Time) (Invitation, error) {
	return scanInvitation(s.db.QueryRowContext(ctx,
		`INSERT INTO invitations (token_hash, created_by, expires_at)
		 VALUES ($1, $2, $3)
		 RETURNING id, created_by, created_at, expires_at, used_at, used_by`,
		tokenHash, createdBy, expires))
}

// ListInvitations returns every issued invitation, newest first, for the admin
// panel. Both pending and already-redeemed/expired ones are returned so an admin
// can see the full history and revoke stragglers.
func (s *Store) ListInvitations(ctx context.Context) ([]Invitation, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, created_by, created_at, expires_at, used_at, used_by
		 FROM invitations ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invitation{}
	for rows.Next() {
		inv, err := scanInvitation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}

// PeekInvitation reports whether an invitation token is currently redeemable
// (exists, unused, unexpired) without consuming it, so the signup form can
// validate the link before the user fills it in. Returns ErrNotFound otherwise.
func (s *Store) PeekInvitation(ctx context.Context, tokenHash string) error {
	var one int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM invitations
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
		tokenHash).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// RedeemInvitation atomically creates a new member account from a valid
// invitation and marks the invitation consumed, in a single transaction so a
// race (double-submit, concurrent reuse of the same link) can never create two
// users or leave a half-applied state. The new user is always a member with the
// display name seeded from the username and the password already set.
//
// Returns ErrNotFound if the invitation is missing, already used, or expired,
// and a unique-violation error (see IsUniqueViolation) if the username is taken
// — in which case nothing is committed and the invitation stays redeemable.
func (s *Store) RedeemInvitation(ctx context.Context, tokenHash, username, displayName, passwordHash string) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()

	// Create the account first so a duplicate username aborts before the
	// invitation is touched (rollback would undo it anyway, but this keeps the
	// invitation redeemable for an immediate retry under the same link).
	u, err := scanUser(tx.QueryRowContext(ctx,
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, 'member', $3) RETURNING `+userCols,
		username, displayName, passwordHash))
	if err != nil {
		return User{}, err
	}

	// Consume the invitation, recording who used it. The WHERE clause is the
	// single-use/expiry guard; no row back means the link was invalid.
	var id int64
	err = tx.QueryRowContext(ctx,
		`UPDATE invitations SET used_at = now(), used_by = $2
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		 RETURNING id`, tokenHash, u.ID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}

	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return u, nil
}

// DeleteInvitation removes an invitation (admin revoke). Deleting an unused one
// makes its link stop working; deleting a redeemed one just clears the record.
func (s *Store) DeleteInvitation(ctx context.Context, id int64) error {
	return s.exec(ctx, `DELETE FROM invitations WHERE id = $1`, id)
}

func scanInvitation(row interface{ Scan(...any) error }) (Invitation, error) {
	var inv Invitation
	err := row.Scan(&inv.ID, &inv.CreatedBy, &inv.CreatedAt, &inv.ExpiresAt, &inv.UsedAt, &inv.UsedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return inv, ErrNotFound
	}
	return inv, err
}

// --- Channels ------------------------------------------------------------

// channelCols is the canonical projection used by scanChannel; keep the scan
// order in sync.
const channelCols = `id, name, topic, is_private, is_dm, position, created_at, archived_at`

func scanChannel(row interface{ Scan(...any) error }) (Channel, error) {
	var c Channel
	err := row.Scan(&c.ID, &c.Name, &c.Topic, &c.IsPrivate, &c.IsDM, &c.Position, &c.CreatedAt, &c.ArchivedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

func (s *Store) CreateChannel(ctx context.Context, name, topic string, isPrivate bool, createdBy int64) (Channel, error) {
	return scanChannel(s.db.QueryRowContext(ctx,
		`INSERT INTO channels (name, topic, is_private, created_by)
		 VALUES ($1, $2, $3, $4)
		 RETURNING `+channelCols,
		name, topic, isPrivate, createdBy))
}

func (s *Store) ListChannels(ctx context.Context, userID int64) ([]Channel, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT c.id, c.name, c.topic, c.is_private, c.is_dm, c.position,
		        c.created_at, c.archived_at,
		        GREATEST(MAX(m.created_at), MAX(dmo.opened_at)) AS last_message_at
		 FROM channels c
		 LEFT JOIN messages m ON m.channel_id = c.id AND m.deleted_at IS NULL
		 LEFT JOIN dm_open dmo ON dmo.channel_id = c.id AND dmo.user_id = $1
		 WHERE c.archived_at IS NULL
		 GROUP BY c.id
		 ORDER BY c.position, c.name`, userID)
	if err != nil {
		return nil, err
	}
	return collectRows(rows, func(row interface{ Scan(...any) error }) (Channel, error) {
		var c Channel
		err := row.Scan(&c.ID, &c.Name, &c.Topic, &c.IsPrivate, &c.IsDM, &c.Position,
			&c.CreatedAt, &c.ArchivedAt, &c.LastMessageAt)
		if errors.Is(err, sql.ErrNoRows) {
			return c, ErrNotFound
		}
		return c, err
	})
}

func (s *Store) GetChannel(ctx context.Context, id int64) (Channel, error) {
	return scanChannel(s.db.QueryRowContext(ctx,
		`SELECT `+channelCols+` FROM channels WHERE id = $1`, id))
}

// GetChannelWithLastMessage returns a channel by ID and includes the timestamp
// of its most recent non-deleted message so the client can sort it correctly.
func (s *Store) GetChannelWithLastMessage(ctx context.Context, id int64) (Channel, error) {
	var c Channel
	err := s.db.QueryRowContext(ctx,
		`SELECT c.id, c.name, c.topic, c.is_private, c.is_dm, c.position,
		        c.created_at, c.archived_at,
		        MAX(m.created_at) AS last_message_at
		 FROM channels c
		 LEFT JOIN messages m ON m.channel_id = c.id AND m.deleted_at IS NULL
		 WHERE c.id = $1
		 GROUP BY c.id`, id).Scan(
		&c.ID, &c.Name, &c.Topic, &c.IsPrivate, &c.IsDM, &c.Position,
		&c.CreatedAt, &c.ArchivedAt, &c.LastMessageAt)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

// GetDMWithRecencyForUser returns the DM channel by ID with a last_message_at
// that reflects the later of the most recent message or the user's opened_at in
// dm_open. This lets the client sort an explicitly-opened DM to the top even
// when no message has been exchanged recently.
func (s *Store) GetDMWithRecencyForUser(ctx context.Context, channelID, userID int64) (Channel, error) {
	var c Channel
	err := s.db.QueryRowContext(ctx,
		`SELECT c.id, c.name, c.topic, c.is_private, c.is_dm, c.position,
		        c.created_at, c.archived_at,
		        GREATEST(MAX(m.created_at), MAX(dmo.opened_at)) AS last_message_at
		 FROM channels c
		 LEFT JOIN messages m ON m.channel_id = c.id AND m.deleted_at IS NULL
		 LEFT JOIN dm_open dmo ON dmo.channel_id = c.id AND dmo.user_id = $2
		 WHERE c.id = $1
		 GROUP BY c.id`, channelID, userID).Scan(
		&c.ID, &c.Name, &c.Topic, &c.IsPrivate, &c.IsDM, &c.Position,
		&c.CreatedAt, &c.ArchivedAt, &c.LastMessageAt)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

// dmName builds the canonical channel name for a DM between two users. The pair
// is ordered so (a,b) and (b,a) map to the same name, and the result satisfies
// the channels.name regex (^[a-z0-9-]{1,48}$) for any plausible BIGSERIAL ids.
func dmName(a, b int64) string {
	if a > b {
		a, b = b, a
	}
	return "dm-" + strconv.FormatInt(a, 10) + "-" + strconv.FormatInt(b, 10)
}

// GetOrCreateDM returns the two-member private channel for a pair of users,
// creating it (and its two memberships) atomically on first use. The bool is
// true when the channel was newly created. Relies on UNIQUE(name) to make
// concurrent creation race-safe: the loser of an insert race re-fetches.
func (s *Store) GetOrCreateDM(ctx context.Context, a, b int64) (Channel, bool, error) {
	name := dmName(a, b)
	if c, err := s.getChannelByName(ctx, name); err == nil {
		return c, false, nil
	} else if !errors.Is(err, ErrNotFound) {
		return Channel{}, false, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Channel{}, false, err
	}
	defer tx.Rollback()

	c, err := scanChannel(tx.QueryRowContext(ctx,
		`INSERT INTO channels (name, topic, is_private, is_dm, created_by)
		 VALUES ($1, '', TRUE, TRUE, $2)
		 ON CONFLICT (name) DO NOTHING
		 RETURNING `+channelCols, name, a))
	if errors.Is(err, ErrNotFound) {
		// Lost the create race: another request inserted it first.
		_ = tx.Rollback()
		c, err := s.getChannelByName(ctx, name)
		return c, false, err
	}
	if err != nil {
		return Channel{}, false, err
	}
	for _, uid := range []int64{a, b} {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`, c.ID, uid); err != nil {
			return Channel{}, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, false, err
	}
	return c, true, nil
}

// OpenDM marks a DM channel open in a user's sidebar and refreshes opened_at so
// the client can sort the DM to the top on an explicit re-open. The presence of
// the row is the server-authoritative "this DM is open for this user" state.
func (s *Store) OpenDM(ctx context.Context, userID, channelID int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO dm_open (user_id, channel_id) VALUES ($1, $2)
		 ON CONFLICT (user_id, channel_id) DO UPDATE SET opened_at = now()`,
		userID, channelID)
	return err
}

// OpenDMForAllMembers marks a DM open for every member of the channel (used on
// creation, and when a message is posted so a participant who had closed it sees
// it resurface). Returns the number of rows newly inserted — i.e. how many
// members had it closed and just had it reopened — so the caller can decide
// whether anyone needs the channel re-announced.
func (s *Store) OpenDMForAllMembers(ctx context.Context, channelID int64) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO dm_open (user_id, channel_id)
		 SELECT user_id, $1 FROM channel_members WHERE channel_id = $1
		 ON CONFLICT DO NOTHING`, channelID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// CloseDM hides a DM from a single user's sidebar (server-authoritative and
// per-user). The channel, its membership, and its history are untouched — only
// this user's open flag clears, and only on a new message does it reopen.
func (s *Store) CloseDM(ctx context.Context, userID, channelID int64) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM dm_open WHERE user_id = $1 AND channel_id = $2`, userID, channelID)
	return err
}

// OpenDMChannelIDs returns the set of DM channel ids currently open for a user.
func (s *Store) OpenDMChannelIDs(ctx context.Context, userID int64) (map[int64]bool, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT channel_id FROM dm_open WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func (s *Store) getChannelByName(ctx context.Context, name string) (Channel, error) {
	return scanChannel(s.db.QueryRowContext(ctx,
		`SELECT `+channelCols+` FROM channels WHERE name = $1 AND archived_at IS NULL`, name))
}

func (s *Store) UpdateChannel(ctx context.Context, id int64, topic string, position int) error {
	return s.exec(ctx, `UPDATE channels SET topic = $2, position = $3 WHERE id = $1`, id, topic, position)
}

func (s *Store) ArchiveChannel(ctx context.Context, id int64) error {
	return s.exec(ctx, `UPDATE channels SET archived_at = now() WHERE id = $1`, id)
}

// ListArchivedChannels returns soft-deleted channels, most recently deleted first.
func (s *Store) ListArchivedChannels(ctx context.Context) ([]Channel, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+channelCols+` FROM channels WHERE archived_at IS NOT NULL ORDER BY archived_at DESC`)
	if err != nil {
		return nil, err
	}
	return collectRows(rows, scanChannel)
}

// RestoreChannel un-archives a channel. The name was never freed while archived,
// so there's no uniqueness conflict to resolve. Returns ErrNotFound if the id
// isn't an archived channel.
func (s *Store) RestoreChannel(ctx context.Context, id int64) (Channel, error) {
	return scanChannel(s.db.QueryRowContext(ctx,
		`UPDATE channels SET archived_at = NULL WHERE id = $1 AND archived_at IS NOT NULL
		 RETURNING `+channelCols, id))
}

// PurgeChannel permanently deletes an archived channel; messages and memberships
// cascade away (and the name is freed). Refuses to touch a live channel.
func (s *Store) PurgeChannel(ctx context.Context, id int64) error {
	return s.exec(ctx, `DELETE FROM channels WHERE id = $1 AND archived_at IS NOT NULL`, id)
}

func (s *Store) AddChannelMember(ctx context.Context, channelID, userID int64) error {
	return s.exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`, channelID, userID)
}

// RemoveChannelMember drops a user's membership in a channel. Returns
// ErrNotFound if they weren't a member.
func (s *Store) RemoveChannelMember(ctx context.Context, channelID, userID int64) error {
	return s.exec(ctx, `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID)
}

func (s *Store) CountChannelMembers(ctx context.Context, channelID int64) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM channel_members WHERE channel_id = $1`, channelID).Scan(&n)
	return n, err
}

func (s *Store) IsChannelMember(ctx context.Context, channelID, userID int64) (bool, error) {
	var ok bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`,
		channelID, userID).Scan(&ok)
	return ok, err
}

// ListChannelMembers returns the users that belong to a (private) channel,
// ordered by display name.
func (s *Store) ListChannelMembers(ctx context.Context, channelID int64) ([]User, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+userCols+` FROM users u
		 JOIN channel_members m ON m.user_id = u.id
		 WHERE m.channel_id = $1 ORDER BY u.display_name`, channelID)
	if err != nil {
		return nil, err
	}
	return collectRows(rows, scanUser)
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

// messageCols is the canonical projection used by scanMessage; keep the scan
// order in sync. Used for RETURNING clauses (subqueries are not allowed there).
const messageCols = `id, channel_id, user_id, content, reply_to_id, created_at, edited_at, deleted_at, pinned_at, pinned_by, is_system`

// messageSelectCols extends messageCols with reply_to_user_id via a correlated
// subquery. Use in SELECT … FROM messages queries, not RETURNING.
const messageSelectCols = `id, channel_id, user_id, content, reply_to_id, ` +
	`(SELECT user_id FROM messages AS r WHERE r.id = reply_to_id) AS reply_to_user_id, ` +
	`created_at, edited_at, deleted_at, pinned_at, pinned_by, is_system`

func scanMessage(row interface{ Scan(...any) error }) (Message, error) {
	var m Message
	err := row.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.ReplyToID,
		&m.CreatedAt, &m.EditedAt, &m.DeletedAt, &m.PinnedAt, &m.PinnedBy, &m.IsSystem)
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

func scanMessageFull(row interface{ Scan(...any) error }) (Message, error) {
	var m Message
	err := row.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.ReplyToID, &m.ReplyToUserID,
		&m.CreatedAt, &m.EditedAt, &m.DeletedAt, &m.PinnedAt, &m.PinnedBy, &m.IsSystem)
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

func (s *Store) CreateMessage(ctx context.Context, channelID, userID int64, content string, replyTo *int64) (Message, error) {
	return scanMessage(s.db.QueryRowContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content, reply_to_id)
		 VALUES ($1, $2, $3, $4)
		 RETURNING `+messageCols,
		channelID, userID, content, replyTo))
}

// CreateSystemMessage inserts a server-generated event line into a channel log
// (e.g. "Call started", "Call ended"). System messages have no author and are
// rendered differently by the client.
func (s *Store) CreateSystemMessage(ctx context.Context, channelID int64, content string) (Message, error) {
	return scanMessage(s.db.QueryRowContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content, is_system)
		 VALUES ($1, NULL, $2, TRUE)
		 RETURNING `+messageCols,
		channelID, content))
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
		`SELECT `+messageSelectCols+`
		 FROM messages
		 WHERE channel_id = $1 AND id < $2
		 ORDER BY id DESC LIMIT $3`, channelID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	out, err := collectRows(rows, scanMessageFull)
	if err != nil {
		return nil, err
	}
	// reverse to oldest-first
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

// ListMessagesAfter returns up to limit messages in a channel with id > afterID,
// oldest-first. It's the forward counterpart to ListMessages, used to page newer
// messages when the client is viewing history below the live tail.
func (s *Store) ListMessagesAfter(ctx context.Context, channelID int64, afterID int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+messageSelectCols+`
		 FROM messages
		 WHERE channel_id = $1 AND id > $2
		 ORDER BY id ASC LIMIT $3`, channelID, afterID, limit)
	if err != nil {
		return nil, err
	}
	return collectRows(rows, scanMessageFull)
}

// GetMessagesAround returns up to halfLimit messages before messageID, the
// message itself, and up to halfLimit messages after, sorted oldest-first.
// Returns ErrNotFound if messageID does not exist in channelID.
func (s *Store) GetMessagesAround(ctx context.Context, channelID, messageID int64, halfLimit int) ([]Message, error) {
	if halfLimit <= 0 || halfLimit > 100 {
		halfLimit = 25
	}

	// Older messages (DESC so we get the closest ones; reversed below).
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+messageSelectCols+`
		 FROM messages
		 WHERE channel_id = $1 AND id < $2
		 ORDER BY id DESC LIMIT $3`, channelID, messageID, halfLimit)
	if err != nil {
		return nil, err
	}
	older, err := collectRows(rows, scanMessageFull)
	if err != nil {
		return nil, err
	}

	// The anchor message itself.
	target, err := scanMessageFull(s.db.QueryRowContext(ctx,
		`SELECT `+messageSelectCols+` FROM messages WHERE channel_id = $1 AND id = $2`,
		channelID, messageID))
	if err != nil {
		return nil, err // includes ErrNotFound
	}

	// Newer messages.
	rows2, err := s.db.QueryContext(ctx,
		`SELECT `+messageSelectCols+`
		 FROM messages
		 WHERE channel_id = $1 AND id > $2
		 ORDER BY id ASC LIMIT $3`, channelID, messageID, halfLimit)
	if err != nil {
		return nil, err
	}
	newer, err := collectRows(rows2, scanMessageFull)
	if err != nil {
		return nil, err
	}

	// Merge: reverse(older) + target + newer → oldest-first.
	out := make([]Message, 0, len(older)+1+len(newer))
	for i := len(older) - 1; i >= 0; i-- {
		out = append(out, older[i])
	}
	out = append(out, target)
	out = append(out, newer...)
	return out, nil
}

// ListPinnedMessages returns a channel's pinned (non-deleted) messages, oldest
// pinned first.
func (s *Store) ListPinnedMessages(ctx context.Context, channelID int64) ([]Message, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+messageSelectCols+`
		 FROM messages
		 WHERE channel_id = $1 AND pinned_at IS NOT NULL AND deleted_at IS NULL
		 ORDER BY pinned_at ASC`, channelID)
	if err != nil {
		return nil, err
	}
	return collectRows(rows, scanMessageFull)
}

// SearchMessages returns up to limit non-deleted messages whose content matches
// the full-text query, restricted to channelIDs, newest-first, with id <
// beforeID (pass 0 for the most recent page) so callers can keyset-paginate the
// same way they page channel history. websearch_to_tsquery tolerates arbitrary
// user input — quoted phrases, OR, leading-minus negation — without erroring,
// and yields no matches (an empty slice) for a query with no searchable terms.
// An empty channel set or blank query short-circuits to [].
func (s *Store) SearchMessages(ctx context.Context, channelIDs []int64, query string, beforeID int64, limit int) ([]Message, error) {
	if len(channelIDs) == 0 || strings.TrimSpace(query) == "" {
		return []Message{}, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if beforeID <= 0 {
		beforeID = 1<<62 - 1
	}
	// Parameterized IN list for the channel ids (keeping this file free of
	// pq-specific imports, per UsersByUsernames), followed by the query, cursor
	// and limit placeholders.
	ph := make([]string, len(channelIDs))
	args := make([]any, 0, len(channelIDs)+3)
	for i, id := range channelIDs {
		ph[i] = "$" + strconv.Itoa(i+1)
		args = append(args, id)
	}
	n := len(channelIDs)
	args = append(args, query, beforeID, limit)
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+messageSelectCols+`
		 FROM messages
		 WHERE channel_id IN (`+strings.Join(ph, ", ")+`)
		   AND deleted_at IS NULL
		   AND id < $`+strconv.Itoa(n+2)+`
		   AND to_tsvector('english', content) @@ websearch_to_tsquery('english', $`+strconv.Itoa(n+1)+`)
		 ORDER BY id DESC LIMIT $`+strconv.Itoa(n+3), args...)
	if err != nil {
		return nil, err
	}
	return collectRows(rows, scanMessageFull)
}

func (s *Store) GetMessage(ctx context.Context, id int64) (Message, error) {
	return scanMessage(s.db.QueryRowContext(ctx,
		`SELECT `+messageCols+` FROM messages WHERE id = $1`, id))
}

func (s *Store) EditMessage(ctx context.Context, id, userID int64, content string) (Message, error) {
	return scanMessage(s.db.QueryRowContext(ctx,
		`UPDATE messages SET content = $3, edited_at = now()
		 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		 RETURNING `+messageCols,
		id, userID, content))
}

// SetMessagePinned pins or unpins a message. Pinning is refused on a deleted
// message; unpinning always clears the flag.
func (s *Store) SetMessagePinned(ctx context.Context, id, byUserID int64, pinned bool) (Message, error) {
	if pinned {
		return scanMessage(s.db.QueryRowContext(ctx,
			`UPDATE messages SET pinned_at = now(), pinned_by = $2
			 WHERE id = $1 AND deleted_at IS NULL
			 RETURNING `+messageCols, id, byUserID))
	}
	return scanMessage(s.db.QueryRowContext(ctx,
		`UPDATE messages SET pinned_at = NULL, pinned_by = NULL
		 WHERE id = $1
		 RETURNING `+messageCols, id))
}

// SoftDeleteMessage marks a message deleted. modOverride allows admins/mods to
// delete others' messages; when false the delete only applies to the author's.
func (s *Store) SoftDeleteMessage(ctx context.Context, id, userID int64, modOverride bool) (Message, error) {
	q := `UPDATE messages SET deleted_at = now(), content = '', pinned_at = NULL, pinned_by = NULL
	      WHERE id = $1 AND deleted_at IS NULL`
	args := []any{id}
	if !modOverride {
		q += ` AND user_id = $2`
		args = append(args, userID)
	}
	q += ` RETURNING ` + messageCols
	return scanMessage(s.db.QueryRowContext(ctx, q, args...))
}

// --- reactions -----------------------------------------------------------

// AddReaction records that userID reacted to messageID with emoji. It's
// idempotent: a repeat is a no-op (the PK collision is swallowed).
func (s *Store) AddReaction(ctx context.Context, messageID, userID int64, emoji string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO message_reactions (message_id, user_id, emoji)
		 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		messageID, userID, emoji)
	return err
}

// RemoveReaction clears userID's reaction of emoji from messageID. Removing one
// that isn't there is a no-op.
func (s *Store) RemoveReaction(ctx context.Context, messageID, userID int64, emoji string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
		messageID, userID, emoji)
	return err
}

// DeleteReactionsForMessage clears every reaction on a message — called when a
// message is soft-deleted (a deleted message shows no reactions).
func (s *Store) DeleteReactionsForMessage(ctx context.Context, messageID int64) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM message_reactions WHERE message_id = $1`, messageID)
	return err
}

// aggregateReactions folds rows ordered by (created_at, user_id) into reaction
// groups, preserving emoji order by first-reaction time and user order within a
// group by reaction time. It returns a non-nil (possibly empty) slice.
func aggregateReactions(rows *sql.Rows) ([]Reaction, error) {
	out := []Reaction{}
	idx := map[string]int{}
	for rows.Next() {
		var emoji string
		var userID int64
		if err := rows.Scan(&emoji, &userID); err != nil {
			return nil, err
		}
		if i, ok := idx[emoji]; ok {
			out[i].UserIDs = append(out[i].UserIDs, userID)
		} else {
			idx[emoji] = len(out)
			out = append(out, Reaction{Emoji: emoji, UserIDs: []int64{userID}})
		}
	}
	return out, rows.Err()
}

// ReactionsForMessage returns the reaction groups for a single message, ordered by
// first-reaction time. Used to build the realtime broadcast after a toggle.
func (s *Store) ReactionsForMessage(ctx context.Context, messageID int64) ([]Reaction, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT emoji, user_id FROM message_reactions
		 WHERE message_id = $1
		 ORDER BY created_at, user_id`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return aggregateReactions(rows)
}

// ReactionsForMessages batch-loads reaction groups for a page of messages, keyed
// by message id, so list endpoints avoid an N+1. Messages with no reactions are
// simply absent from the map. An empty id set short-circuits. The IN list is
// parameterized by hand (keeping this file free of pq-specific imports, as
// SearchMessages does).
func (s *Store) ReactionsForMessages(ctx context.Context, ids []int64) (map[int64][]Reaction, error) {
	out := map[int64][]Reaction{}
	if len(ids) == 0 {
		return out, nil
	}
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i] = "$" + strconv.Itoa(i+1)
		args[i] = id
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT message_id, emoji, user_id FROM message_reactions
		 WHERE message_id IN (`+strings.Join(ph, ", ")+`)
		 ORDER BY message_id, created_at, user_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// Per-message group index, reset when message_id changes (rows are grouped by
	// message_id thanks to the ORDER BY).
	idx := map[int64]map[string]int{}
	for rows.Next() {
		var msgID, userID int64
		var emoji string
		if err := rows.Scan(&msgID, &emoji, &userID); err != nil {
			return nil, err
		}
		gi := idx[msgID]
		if gi == nil {
			gi = map[string]int{}
			idx[msgID] = gi
		}
		groups := out[msgID]
		if i, ok := gi[emoji]; ok {
			groups[i].UserIDs = append(groups[i].UserIDs, userID)
		} else {
			gi[emoji] = len(groups)
			groups = append(groups, Reaction{Emoji: emoji, UserIDs: []int64{userID}})
		}
		out[msgID] = groups
	}
	return out, rows.Err()
}

// --- read state + mentions ----------------------------------------------

// MarkRead advances a user's read cursor for a channel to messageID. The cursor
// is monotonic — GREATEST guards against out-of-order / concurrent updates
// moving it backward.
func (s *Store) MarkRead(ctx context.Context, userID, channelID, messageID int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (user_id, channel_id) DO UPDATE
		   SET last_read_message_id = GREATEST(channel_reads.last_read_message_id, EXCLUDED.last_read_message_id),
		       updated_at = now()`,
		userID, channelID, messageID)
	return err
}

// MarkUnread moves a user's read cursor to beforeMessageID-1, making that
// message and everything after it appear unread. Unlike MarkRead this is
// intentionally non-monotonic so the cursor can move backward.
func (s *Store) MarkUnread(ctx context.Context, userID, channelID, beforeMessageID int64) error {
	cursor := beforeMessageID - 1
	if cursor < 0 {
		cursor = 0
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (user_id, channel_id) DO UPDATE
		   SET last_read_message_id = EXCLUDED.last_read_message_id,
		       updated_at = now()`,
		userID, channelID, cursor)
	return err
}

// SeedReadCursor sets a user's cursor for a channel to the channel's current
// newest message id, but only if no cursor exists yet (ON CONFLICT DO NOTHING) —
// so a user who gains access to a channel starts "caught up" rather than facing
// the whole backlog as unread. Never moves an existing cursor.
func (s *Store) SeedReadCursor(ctx context.Context, userID, channelID int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO channel_reads (user_id, channel_id, last_read_message_id)
		 VALUES ($1, $2, COALESCE((SELECT max(id) FROM messages WHERE channel_id = $2), 0))
		 ON CONFLICT DO NOTHING`,
		userID, channelID)
	return err
}

// SeedPublicReadCursors seeds a (new) user's cursors for every live public
// channel to each channel's newest message id, so a freshly created account
// isn't greeted by every public channel's history as unread.
func (s *Store) SeedPublicReadCursors(ctx context.Context, userID int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO channel_reads (user_id, channel_id, last_read_message_id)
		 SELECT $1, c.id, COALESCE((SELECT max(m.id) FROM messages m WHERE m.channel_id = c.id), 0)
		 FROM channels c
		 WHERE c.is_private = FALSE AND c.archived_at IS NULL
		 ON CONFLICT DO NOTHING`,
		userID)
	return err
}

// RecordMentions inserts a ping row per recipient for a message. Idempotent
// (ON CONFLICT DO NOTHING) so a re-record after an edit is safe.
func (s *Store) RecordMentions(ctx context.Context, messageID, channelID int64, userIDs []int64) error {
	for _, uid := range userIDs {
		if _, err := s.db.ExecContext(ctx,
			`INSERT INTO message_mentions (message_id, user_id, channel_id)
			 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
			messageID, uid, channelID); err != nil {
			return err
		}
	}
	return nil
}

// DeleteMentionsForMessage clears a message's ping rows — used on soft-delete (so
// a deleted message stops pinging) and before recomputing on edit.
func (s *Store) DeleteMentionsForMessage(ctx context.Context, messageID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM message_mentions WHERE message_id = $1`, messageID)
	return err
}

// UsersByUsernames resolves a set of usernames to the ids of the active users
// that own them, keyed by lower-cased username. Unknown/inactive names are
// omitted. Returns an empty map for an empty input.
func (s *Store) UsersByUsernames(ctx context.Context, names []string) (map[string]int64, error) {
	out := map[string]int64{}
	if len(names) == 0 {
		return out, nil
	}
	// Build a parameterized IN list ($1, $2, ...) rather than importing the
	// driver's array type, keeping this file free of pq-specific imports.
	ph := make([]string, len(names))
	args := make([]any, len(names))
	for i, n := range names {
		ph[i] = "$" + strconv.Itoa(i+1)
		args[i] = n
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT username, id FROM users WHERE is_active AND username IN (`+strings.Join(ph, ", ")+`)`,
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var id int64
		if err := rows.Scan(&name, &id); err != nil {
			return nil, err
		}
		out[name] = id
	}
	return out, rows.Err()
}

// MuteChannel silences a channel for a user (idempotent).
func (s *Store) MuteChannel(ctx context.Context, userID, channelID int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO channel_mutes (user_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		userID, channelID)
	return err
}

// UnmuteChannel un-silences a channel for a user (idempotent).
func (s *Store) UnmuteChannel(ctx context.Context, userID, channelID int64) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM channel_mutes WHERE user_id = $1 AND channel_id = $2`, userID, channelID)
	return err
}

// ListMutedChannelIDs returns the channel ids a user has muted. Always non-nil.
func (s *Store) ListMutedChannelIDs(ctx context.Context, userID int64) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT channel_id FROM channel_mutes WHERE user_id = $1`, userID)
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

// UnreadSummary returns the per-channel unread/mention counts for a user across
// every channel they can access (public channels, plus private channels they
// belong to). Channels with nothing unread are omitted. Always non-nil.
func (s *Store) UnreadSummary(ctx context.Context, userID int64) ([]ChannelUnread, error) {
	// "visible" = the channels whose unread we report for this user.
	// Muted channels are excluded entirely — they contribute no unread or mention
	// counts (mute is a full silence).
	const visibleCTE = `
		WITH visible AS (
			SELECT id FROM channels
			WHERE archived_at IS NULL
			  AND (is_private = FALSE
			       OR id IN (SELECT channel_id FROM channel_members WHERE user_id = $1))
			  AND id NOT IN (SELECT channel_id FROM channel_mutes WHERE user_id = $1)
		)`

	byChannel := map[int64]*ChannelUnread{}
	get := func(id int64) *ChannelUnread {
		cu := byChannel[id]
		if cu == nil {
			cu = &ChannelUnread{ChannelID: id}
			byChannel[id] = cu
		}
		return cu
	}

	// Unread: messages newer than the cursor that the user didn't author and
	// that aren't deleted.
	unreadRows, err := s.db.QueryContext(ctx, visibleCTE+`
		SELECT m.channel_id, count(*)
		FROM messages m
		JOIN visible v ON v.id = m.channel_id
		LEFT JOIN channel_reads cr ON cr.user_id = $1 AND cr.channel_id = m.channel_id
		WHERE m.user_id <> $1 AND m.deleted_at IS NULL
		  AND m.id > COALESCE(cr.last_read_message_id, 0)
		GROUP BY m.channel_id`, userID)
	if err != nil {
		return nil, err
	}
	defer unreadRows.Close()
	for unreadRows.Next() {
		var cid int64
		var n int
		if err := unreadRows.Scan(&cid, &n); err != nil {
			return nil, err
		}
		get(cid).Unread = n
	}
	if err := unreadRows.Err(); err != nil {
		return nil, err
	}

	// Mentions (pings): unread ping rows for this user.
	mentionRows, err := s.db.QueryContext(ctx, visibleCTE+`
		SELECT mm.channel_id, count(*)
		FROM message_mentions mm
		JOIN visible v ON v.id = mm.channel_id
		LEFT JOIN channel_reads cr ON cr.user_id = $1 AND cr.channel_id = mm.channel_id
		WHERE mm.user_id = $1
		  AND mm.message_id > COALESCE(cr.last_read_message_id, 0)
		GROUP BY mm.channel_id`, userID)
	if err != nil {
		return nil, err
	}
	defer mentionRows.Close()
	for mentionRows.Next() {
		var cid int64
		var n int
		if err := mentionRows.Scan(&cid, &n); err != nil {
			return nil, err
		}
		get(cid).Mentions = n
	}
	if err := mentionRows.Err(); err != nil {
		return nil, err
	}

	// Read cursors: populate LastReadMessageID for every visible channel that
	// has a cursor row. This lets the client place the "New messages" marker.
	cursorRows, err := s.db.QueryContext(ctx, visibleCTE+`
		SELECT cr.channel_id, cr.last_read_message_id
		FROM channel_reads cr
		JOIN visible v ON v.id = cr.channel_id
		WHERE cr.user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer cursorRows.Close()
	for cursorRows.Next() {
		var cid, msgID int64
		if err := cursorRows.Scan(&cid, &msgID); err != nil {
			return nil, err
		}
		get(cid).LastReadMessageID = msgID
	}
	if err := cursorRows.Err(); err != nil {
		return nil, err
	}

	out := make([]ChannelUnread, 0, len(byChannel))
	for _, cu := range byChannel {
		out = append(out, *cu)
	}
	return out, nil
}

// --- Web Push ------------------------------------------------------------

// IsChannelMuted reports whether the user has muted the channel. Used to skip
// push for a silenced channel.
func (s *Store) IsChannelMuted(ctx context.Context, userID, channelID int64) (bool, error) {
	var muted bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM channel_mutes WHERE user_id = $1 AND channel_id = $2)`,
		userID, channelID).Scan(&muted)
	return muted, err
}

// AddPushSubscription stores (or refreshes) a browser's push subscription. The
// endpoint is the dedupe key: a re-subscribe with the same endpoint updates the
// keys and re-owns it for this user rather than duplicating.
func (s *Store) AddPushSubscription(ctx context.Context, userID int64, endpoint, p256dh, auth string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (endpoint) DO UPDATE
		   SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
		userID, endpoint, p256dh, auth)
	return err
}

// DeletePushSubscriptionByEndpoint removes a subscription by its endpoint. Used
// both when the client unsubscribes and when the push service reports it gone.
func (s *Store) DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM push_subscriptions WHERE endpoint = $1`, endpoint)
	return err
}

// ListPushSubscriptions returns all of a user's push subscriptions. Always
// non-nil.
func (s *Store) ListPushSubscriptions(ctx context.Context, userID int64) ([]PushSubscription, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
		userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PushSubscription{}
	for rows.Next() {
		var p PushSubscription
		if err := rows.Scan(&p.ID, &p.UserID, &p.Endpoint, &p.P256dh, &p.Auth); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetVAPIDKeys returns the stored VAPID keypair (private PKCS#8 base64, public
// point base64url), or ErrNotFound if none has been generated yet.
func (s *Store) GetVAPIDKeys(ctx context.Context) (privB64, pubB64 string, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT private_key, public_key FROM push_vapid WHERE id = 1`).Scan(&privB64, &pubB64)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return privB64, pubB64, err
}

// SaveVAPIDKeys persists the VAPID keypair as the single row. A concurrent boot
// that lost the race keeps the existing row (DO NOTHING), so the keys are stable.
func (s *Store) SaveVAPIDKeys(ctx context.Context, privB64, pubB64 string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO push_vapid (id, private_key, public_key) VALUES (1, $1, $2)
		 ON CONFLICT (id) DO NOTHING`,
		privB64, pubB64)
	return err
}

// --- helpers -------------------------------------------------------------

// collectRows calls scan on each row, accumulates results into a non-nil slice,
// and closes rows. Any scan error or rows.Err() is returned immediately.
func collectRows[T any](rows *sql.Rows, scan func(interface{ Scan(...any) error }) (T, error)) ([]T, error) {
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		t, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

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

// --- blobs ---------------------------------------------------------------

// CreateBlob records blob metadata. Idempotent: if a blob with the same hash was
// already recorded (same bytes → same hash), the insert is a no-op.
func (s *Store) CreateBlob(ctx context.Context, hash string, uploaderID int64, contentType string, size int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO blobs (hash, uploader_id, content_type, size)
		 VALUES ($1, $2, $3, $4) ON CONFLICT (hash) DO NOTHING`,
		hash, uploaderID, contentType, size)
	return err
}

// --- user notes ----------------------------------------------------------

// GetUserNote returns the note owner_id has written about subject_id.
// Returns an empty string (not ErrNotFound) when no note exists yet.
func (s *Store) GetUserNote(ctx context.Context, ownerID, subjectID int64) (string, error) {
	var note string
	err := s.db.QueryRowContext(ctx,
		`SELECT note FROM user_notes WHERE owner_id = $1 AND subject_id = $2`,
		ownerID, subjectID).Scan(&note)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return note, err
}

// UpsertUserNote saves (or replaces) owner_id's note about subject_id.
func (s *Store) UpsertUserNote(ctx context.Context, ownerID, subjectID int64, note string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO user_notes (owner_id, subject_id, note, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (owner_id, subject_id) DO UPDATE SET note = EXCLUDED.note, updated_at = now()`,
		ownerID, subjectID, note)
	return err
}

// --- blobs ---------------------------------------------------------------

// GetBlob returns the metadata for a blob by hash.
func (s *Store) GetBlob(ctx context.Context, hash string) (Blob, error) {
	var b Blob
	var uid sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`SELECT hash, uploader_id, content_type, size, created_at FROM blobs WHERE hash = $1`,
		hash).Scan(&b.Hash, &uid, &b.ContentType, &b.Size, &b.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return b, ErrNotFound
	}
	if uid.Valid {
		b.UploaderID = &uid.Int64
	}
	return b, err
}

// --- link preview cache --------------------------------------------------

// GetLinkPreview returns the cached preview for rawURL, or ErrNotFound if the
// cache has no non-expired entry. ErrorMsg is set on rows that represent a
// failed fetch (the caller should return 404 for those).
func (s *Store) GetLinkPreview(ctx context.Context, rawURL string) (LinkPreview, error) {
	var lp LinkPreview
	var errMsg sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT url, title, description, image_url, site_name, error_msg, fetched_at, expires_at
		FROM link_previews
		WHERE url = $1 AND expires_at > now()`,
		rawURL).Scan(&lp.URL, &lp.Title, &lp.Description, &lp.ImageURL, &lp.SiteName,
		&errMsg, &lp.FetchedAt, &lp.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return lp, ErrNotFound
	}
	if err != nil {
		return lp, err
	}
	if errMsg.Valid {
		lp.ErrorMsg = errMsg.String
	}
	return lp, nil
}

// SaveLinkPreview upserts a preview row. ExpiresAt must be set by the caller.
func (s *Store) SaveLinkPreview(ctx context.Context, lp LinkPreview) error {
	var errMsg sql.NullString
	if lp.ErrorMsg != "" {
		errMsg = sql.NullString{String: lp.ErrorMsg, Valid: true}
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO link_previews (url, title, description, image_url, site_name, error_msg, fetched_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
		ON CONFLICT (url) DO UPDATE SET
			title       = EXCLUDED.title,
			description = EXCLUDED.description,
			image_url   = EXCLUDED.image_url,
			site_name   = EXCLUDED.site_name,
			error_msg   = EXCLUDED.error_msg,
			fetched_at  = now(),
			expires_at  = EXCLUDED.expires_at`,
		lp.URL, lp.Title, lp.Description, lp.ImageURL, lp.SiteName, errMsg, lp.ExpiresAt)
	return err
}

// DeleteExpiredLinkPreviews removes all rows whose TTL has elapsed.
func (s *Store) DeleteExpiredLinkPreviews(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM link_previews WHERE expires_at < now()`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
