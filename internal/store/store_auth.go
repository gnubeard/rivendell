package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

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

// --- Bot tokens ----------------------------------------------------------

func (s *Store) CreateBotToken(ctx context.Context, userID int64, tokenHash, name string) (BotToken, error) {
	var t BotToken
	err := s.db.QueryRowContext(ctx,
		`INSERT INTO bot_tokens (user_id, token_hash, name)
		 VALUES ($1, $2, $3)
		 RETURNING id, user_id, name, created_at`,
		userID, tokenHash, name).Scan(&t.ID, &t.UserID, &t.Name, &t.CreatedAt)
	return t, err
}

// UserForBotToken looks up the active user that owns a bot token. Returns
// ErrNotFound if the token doesn't exist or the associated user is inactive.
func (s *Store) UserForBotToken(ctx context.Context, tokenHash string) (User, error) {
	var uid int64
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id FROM bot_tokens WHERE token_hash = $1`, tokenHash).Scan(&uid)
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

func (s *Store) ListBotTokens(ctx context.Context) ([]BotToken, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, name, created_at FROM bot_tokens ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BotToken{}
	for rows.Next() {
		var t BotToken
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) DeleteBotToken(ctx context.Context, id int64) error {
	return s.exec(ctx, `DELETE FROM bot_tokens WHERE id = $1`, id)
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
