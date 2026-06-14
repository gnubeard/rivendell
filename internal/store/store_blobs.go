package store

import (
	"context"
	"database/sql"
	"errors"
)

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
