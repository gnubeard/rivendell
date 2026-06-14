package store

import (
	"context"
	"database/sql"
	"errors"
)

// userCols is the canonical projection used by scanUser.
const userCols = `id, username, display_name, role, status, status_text, theme, pronouns, bio,
	(avatar IS NOT NULL) AS has_avatar, avatar_updated_at, (password_hash IS NOT NULL) AS has_password,
	is_active, is_bot, created_at, last_seen_at, identity_key`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	var lastSeen sql.NullTime
	var identityKey sql.NullString
	var avatarUpdatedAt sql.NullTime
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status,
		&u.StatusText, &u.Theme, &u.Pronouns, &u.Bio, &u.HasAvatar, &avatarUpdatedAt, &u.HasPassword, &u.IsActive, &u.IsBot, &u.CreatedAt, &lastSeen, &identityKey)
	if errors.Is(err, sql.ErrNoRows) {
		return u, ErrNotFound
	}
	if err != nil {
		return u, err
	}
	if avatarUpdatedAt.Valid {
		u.AvatarUpdatedAt = &avatarUpdatedAt.Time
	}
	if lastSeen.Valid {
		u.LastSeenAt = &lastSeen.Time
	}
	if identityKey.Valid {
		u.IdentityKey = &identityKey.String
	}
	return u, nil
}

// --- Users ---------------------------------------------------------------

func (s *Store) CreateUser(ctx context.Context, username, displayName string, role Role) (User, error) {
	row := s.db.QueryRowContext(ctx,
		`INSERT INTO users (username, display_name, role) VALUES ($1, $2, $3) RETURNING `+userCols,
		username, displayName, role)
	return scanUser(row)
}

func (s *Store) GetUserByID(ctx context.Context, id int64) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = $1`, id))
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE username = $1`, username))
}

// GetPasswordHash returns the stored hash (may be empty if unset).
func (s *Store) GetPasswordHash(ctx context.Context, id int64) (string, error) {
	var h sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id = $1`, id).Scan(&h)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return h.String, err
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userCols+` FROM users ORDER BY display_name`)
	if err != nil {
		return nil, err
	}
	return collectRows(rows, scanUser)
}

func (s *Store) SetPassword(ctx context.Context, id int64, hash string) error {
	return s.exec(ctx, `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, id, hash)
}

func (s *Store) UpdateProfile(ctx context.Context, id int64, displayName, statusText, theme, pronouns, bio string) error {
	return s.exec(ctx, `UPDATE users SET display_name = $2, status_text = $3, theme = $4, pronouns = $5, bio = $6, updated_at = now() WHERE id = $1`,
		id, displayName, statusText, theme, pronouns, bio)
}

func (s *Store) SetStatus(ctx context.Context, id int64, status string) error {
	return s.exec(ctx, `UPDATE users SET status = $2, updated_at = now() WHERE id = $1`, id, status)
}

func (s *Store) SetRole(ctx context.Context, id int64, role Role) error {
	return s.exec(ctx, `UPDATE users SET role = $2, updated_at = now() WHERE id = $1`, id, role)
}

func (s *Store) SetActive(ctx context.Context, id int64, active bool) error {
	return s.exec(ctx, `UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1`, id, active)
}

func (s *Store) SetBot(ctx context.Context, id int64, bot bool) error {
	return s.exec(ctx, `UPDATE users SET is_bot = $2, updated_at = now() WHERE id = $1`, id, bot)
}

func (s *Store) SetIdentityKey(ctx context.Context, id int64, key string) error {
	return s.exec(ctx, `UPDATE users SET identity_key = $2, identity_key_updated_at = now(), updated_at = now() WHERE id = $1`, id, key)
}

func (s *Store) TouchLastSeen(ctx context.Context, id int64) error {
	return s.exec(ctx, `UPDATE users SET last_seen_at = now() WHERE id = $1`, id)
}

func (s *Store) SetAvatar(ctx context.Context, id int64, mime string, data []byte) error {
	return s.exec(ctx, `UPDATE users SET avatar = $2, avatar_mime = $3, avatar_updated_at = now(), updated_at = now() WHERE id = $1`,
		id, data, mime)
}

func (s *Store) ClearAvatar(ctx context.Context, id int64) error {
	return s.exec(ctx, `UPDATE users SET avatar = NULL, avatar_mime = NULL, avatar_updated_at = NULL, updated_at = now() WHERE id = $1`, id)
}

func (s *Store) GetAvatar(ctx context.Context, id int64) (mime string, data []byte, err error) {
	var m sql.NullString
	err = s.db.QueryRowContext(ctx, `SELECT avatar_mime, avatar FROM users WHERE id = $1`, id).Scan(&m, &data)
	if errors.Is(err, sql.ErrNoRows) || data == nil {
		return "", nil, ErrNotFound
	}
	return m.String, data, err
}

// --- user notes ----------------------------------------------------------

// GetUserNote returns the note owner_id has written about subject_id.
// Returns an empty string (not ErrNotFound) when no note exists yet.
func (s *Store) GetUserNote(ctx context.Context, ownerID, subjectID int64) (string, error) {
	var note string
	err := s.db.QueryRowContext(ctx,
		`SELECT note FROM user_notes WHERE owner_id = $1 AND subject_id = $2`,
		ownerID, subjectID).Scan(&note)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return note, err
}

// UpsertUserNote saves (or replaces) owner_id's note about subject_id.
func (s *Store) UpsertUserNote(ctx context.Context, ownerID, subjectID int64, note string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO user_notes (owner_id, subject_id, note, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (owner_id, subject_id) DO UPDATE SET note = EXCLUDED.note, updated_at = now()`,
		ownerID, subjectID, note)
	return err
}
