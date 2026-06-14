package store

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
)

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
