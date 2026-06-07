-- Web Push: per-device subscriptions for offline notifications, plus this
-- server's single VAPID identity. See docs/web_push.md.

CREATE TABLE push_subscriptions (
    id           BIGSERIAL   PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint     TEXT        NOT NULL UNIQUE,   -- push service URL (the dedupe key)
    p256dh       TEXT        NOT NULL,          -- UA public key, base64url (65-byte point)
    auth         TEXT        NOT NULL,          -- UA auth secret, base64url (16 bytes)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- Single-row table holding the server's long-lived VAPID keypair. Generated once
-- on first boot and reused, so existing subscriptions survive restarts.
CREATE TABLE push_vapid (
    id          INT         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    private_key TEXT        NOT NULL,  -- PKCS#8, base64 (server secret)
    public_key  TEXT        NOT NULL,  -- uncompressed point, base64url (applicationServerKey)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
