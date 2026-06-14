package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// --- Invitations ---------------------------------------------------------

// CreateInvitation stores a new single-use signup invitation and returns the
// persisted row (so the admin UI can list it immediately).
func (s *Store) CreateInvitation(ctx context.Context, tokenHash string, createdBy int64, expires time.Time) (Invitation, error) {
	return scanInvitation(s.db.QueryRowContext(ctx,
		`INSERT INTO invitations (token_hash, created_by, expires_at)
		 VALUES ($1, $2, $3)
		 RETURNING id, created_by, created_at, expires_at, used_at, used_by`,
		tokenHash, createdBy, expires))
}

// ListInvitations returns every issued invitation, newest first, for the admin
// panel. Both pending and already-redeemed/expired ones are returned so an admin
// can see the full history and revoke stragglers.
func (s *Store) ListInvitations(ctx context.Context) ([]Invitation, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, created_by, created_at, expires_at, used_at, used_by
		 FROM invitations ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invitation{}
	for rows.Next() {
		inv, err := scanInvitation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}

// PeekInvitation reports whether an invitation token is currently redeemable
// (exists, unused, unexpired) without consuming it, so the signup form can
// validate the link before the user fills it in. Returns ErrNotFound otherwise.
func (s *Store) PeekInvitation(ctx context.Context, tokenHash string) error {
	var one int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM invitations
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
		tokenHash).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// RedeemInvitation atomically creates a new member account from a valid
// invitation and marks the invitation consumed, in a single transaction so a
// race (double-submit, concurrent reuse of the same link) can never create two
// users or leave a half-applied state. The new user is always a member with the
// display name seeded from the username and the password already set.
//
// Returns ErrNotFound if the invitation is missing, already used, or expired,
// and a unique-violation error (see IsUniqueViolation) if the username is taken
// — in which case nothing is committed and the invitation stays redeemable.
func (s *Store) RedeemInvitation(ctx context.Context, tokenHash, username, displayName, passwordHash string) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()

	// Create the account first so a duplicate username aborts before the
	// invitation is touched (rollback would undo it anyway, but this keeps the
	// invitation redeemable for an immediate retry under the same link).
	u, err := scanUser(tx.QueryRowContext(ctx,
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, 'member', $3) RETURNING `+userCols,
		username, displayName, passwordHash))
	if err != nil {
		return User{}, err
	}

	// Consume the invitation, recording who used it. The WHERE clause is the
	// single-use/expiry guard; no row back means the link was invalid.
	var id int64
	err = tx.QueryRowContext(ctx,
		`UPDATE invitations SET used_at = now(), used_by = $2
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		 RETURNING id`, tokenHash, u.ID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}

	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return u, nil
}

// DeleteInvitation removes an invitation (admin revoke). Deleting an unused one
// makes its link stop working; deleting a redeemed one just clears the record.
func (s *Store) DeleteInvitation(ctx context.Context, id int64) error {
	return s.exec(ctx, `DELETE FROM invitations WHERE id = $1`, id)
}

func scanInvitation(row interface{ Scan(...any) error }) (Invitation, error) {
	var inv Invitation
	err := row.Scan(&inv.ID, &inv.CreatedBy, &inv.CreatedAt, &inv.ExpiresAt, &inv.UsedAt, &inv.UsedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return inv, ErrNotFound
	}
	return inv, err
}
