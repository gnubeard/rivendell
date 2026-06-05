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

func (s *Store) ListChannels(ctx context.Context) ([]Channel, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+channelCols+`
		 FROM channels WHERE archived_at IS NULL
		 ORDER BY position, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Channel{}
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) GetChannel(ctx context.Context, id int64) (Channel, error) {
	return scanChannel(s.db.QueryRowContext(ctx,
		`SELECT `+channelCols+` FROM channels WHERE id = $1`, id))
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
	defer rows.Close()
	out := []Channel{}
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
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
// order in sync.
const messageCols = `id, channel_id, user_id, content, reply_to_id, created_at, edited_at, deleted_at, pinned_at, pinned_by`

func scanMessage(row interface{ Scan(...any) error }) (Message, error) {
	var m Message
	err := row.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.ReplyToID,
		&m.CreatedAt, &m.EditedAt, &m.DeletedAt, &m.PinnedAt, &m.PinnedBy)
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
		`SELECT `+messageCols+`
		 FROM messages
		 WHERE channel_id = $1 AND id < $2
		 ORDER BY id DESC LIMIT $3`, channelID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
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

// ListMessagesAfter returns up to limit messages in a channel with id > afterID,
// oldest-first. It's the forward counterpart to ListMessages, used to page newer
// messages when the client is viewing history below the live tail.
func (s *Store) ListMessagesAfter(ctx context.Context, channelID int64, afterID int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+messageCols+`
		 FROM messages
		 WHERE channel_id = $1 AND id > $2
		 ORDER BY id ASC LIMIT $3`, channelID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
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
		`SELECT `+messageCols+`
		 FROM messages
		 WHERE channel_id = $1 AND id < $2
		 ORDER BY id DESC LIMIT $3`, channelID, messageID, halfLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var older []Message
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		older = append(older, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// The anchor message itself.
	target, err := scanMessage(s.db.QueryRowContext(ctx,
		`SELECT `+messageCols+` FROM messages WHERE channel_id = $1 AND id = $2`,
		channelID, messageID))
	if err != nil {
		return nil, err // includes ErrNotFound
	}

	// Newer messages.
	rows2, err := s.db.QueryContext(ctx,
		`SELECT `+messageCols+`
		 FROM messages
		 WHERE channel_id = $1 AND id > $2
		 ORDER BY id ASC LIMIT $3`, channelID, messageID, halfLimit)
	if err != nil {
		return nil, err
	}
	defer rows2.Close()
	var newer []Message
	for rows2.Next() {
		m, err := scanMessage(rows2)
		if err != nil {
			return nil, err
		}
		newer = append(newer, m)
	}
	if err := rows2.Err(); err != nil {
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
		`SELECT `+messageCols+`
		 FROM messages
		 WHERE channel_id = $1 AND pinned_at IS NOT NULL AND deleted_at IS NULL
		 ORDER BY pinned_at ASC`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// SearchMessages returns up to limit non-deleted messages whose content matches
// the full-text query, restricted to channelIDs, newest-first, with id <
// beforeID (pass 0 for the most recent page) so callers can keyset-paginate the
// same way they page channel history. websearch_to_tsquery tolerates arbitrary
// user input — quoted phrases, OR, leading-minus negation — without erroring,
// and yields no matches (an empty slice) for a query with no searchable terms.
// An empty channel set or blank query short-circuits to [].
func (s *Store) SearchMessages(ctx context.Context, channelIDs []int64, query string, beforeID int64, limit int) ([]Message, error) {
	out := []Message{}
	if len(channelIDs) == 0 || strings.TrimSpace(query) == "" {
		return out, nil
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
		`SELECT `+messageCols+`
		 FROM messages
		 WHERE channel_id IN (`+strings.Join(ph, ", ")+`)
		   AND deleted_at IS NULL
		   AND id < $`+strconv.Itoa(n+2)+`
		   AND to_tsvector('english', content) @@ websearch_to_tsquery('english', $`+strconv.Itoa(n+1)+`)
		 ORDER BY id DESC LIMIT $`+strconv.Itoa(n+3), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
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

	out := make([]ChannelUnread, 0, len(byChannel))
	for _, cu := range byChannel {
		out = append(out, *cu)
	}
	return out, nil
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
