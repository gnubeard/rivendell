package store

import (
	"context"
	"strconv"
	"strings"
)

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
