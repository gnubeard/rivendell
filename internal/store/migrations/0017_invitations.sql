-- 0017_invitations.sql — signup invitations.
-- An invitation is a single-use, time-limited token an admin issues so a new
-- person can create their own account: they choose their own username, the
-- display name defaults to that username, and the role is always 'member'.
-- This is deliberately distinct from magic_links, which set/reset the password
-- of an *already existing* user. Like every other secret in this schema, only
-- the token's SHA-256 hash is stored, never the token itself.
CREATE TABLE invitations (
    id         BIGSERIAL PRIMARY KEY,
    token_hash TEXT        NOT NULL UNIQUE,
    created_by BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    used_by    BIGINT      REFERENCES users (id) ON DELETE SET NULL
);
