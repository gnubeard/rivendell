package store

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
)

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
