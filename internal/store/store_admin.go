package store

import (
	"context"
)

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
