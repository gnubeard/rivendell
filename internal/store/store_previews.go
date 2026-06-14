package store

import (
	"context"
	"database/sql"
	"errors"
)

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
