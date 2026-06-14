package store

import (
	"context"
	"database/sql"
	"errors"
)

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
