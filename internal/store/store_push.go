package store

import (
	"context"
	"database/sql"
	"errors"
)

// AddPushSubscription stores (or refreshes) a browser's push subscription. The
// endpoint is the dedupe key: a re-subscribe with the same endpoint updates the
// keys and re-owns it for this user rather than duplicating.
func (s *Store) AddPushSubscription(ctx context.Context, userID int64, endpoint, p256dh, auth string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (endpoint) DO UPDATE
		   SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
		userID, endpoint, p256dh, auth)
	return err
}

// DeletePushSubscriptionByEndpoint removes a subscription by its endpoint. Used
// both when the client unsubscribes and when the push service reports it gone.
func (s *Store) DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM push_subscriptions WHERE endpoint = $1`, endpoint)
	return err
}

// ListPushSubscriptions returns all of a user's push subscriptions. Always
// non-nil.
func (s *Store) ListPushSubscriptions(ctx context.Context, userID int64) ([]PushSubscription, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
		userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PushSubscription{}
	for rows.Next() {
		var p PushSubscription
		if err := rows.Scan(&p.ID, &p.UserID, &p.Endpoint, &p.P256dh, &p.Auth); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetVAPIDKeys returns the stored VAPID keypair (private PKCS#8 base64, public
// point base64url), or ErrNotFound if none has been generated yet.
func (s *Store) GetVAPIDKeys(ctx context.Context) (privB64, pubB64 string, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT private_key, public_key FROM push_vapid WHERE id = 1`).Scan(&privB64, &pubB64)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return privB64, pubB64, err
}

// SaveVAPIDKeys persists the VAPID keypair as the single row. A concurrent boot
// that lost the race keeps the existing row (DO NOTHING), so the keys are stable.
func (s *Store) SaveVAPIDKeys(ctx context.Context, privB64, pubB64 string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO push_vapid (id, private_key, public_key) VALUES (1, $1, $2)
		 ON CONFLICT (id) DO NOTHING`,
		privB64, pubB64)
	return err
}
