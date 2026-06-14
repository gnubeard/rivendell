package store

import (
	"context"
	"database/sql"
	"strconv"
	"strings"
)

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
