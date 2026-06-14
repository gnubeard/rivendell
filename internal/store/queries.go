package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

var ErrNotFound = errors.New("store: not found")

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
