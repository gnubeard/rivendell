-- 0001_init.sql — initial Rivendell schema.
-- BIGSERIAL keys keep the model easy to reason about. Secrets (session and
-- magic-link tokens) are random high-entropy strings stored only as hashes,
-- so sequential integer IDs pose no enumeration risk for secrets.

CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT        NOT NULL UNIQUE CHECK (username = lower(username) AND username ~ '^[a-z0-9_]{2,32}$'),
    display_name  TEXT        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 64),
    password_hash TEXT,                       -- NULL until the user sets a password
    role          TEXT        NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'moderator', 'member')),
    status        TEXT        NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'away', 'dnd', 'offline')),
    status_text   TEXT        NOT NULL DEFAULT '' CHECK (length(status_text) <= 128),
    avatar        BYTEA,
    avatar_mime   TEXT,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ
);

CREATE TABLE sessions (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   TEXT        NOT NULL UNIQUE,
    user_agent   TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE magic_links (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash TEXT        NOT NULL UNIQUE,
    purpose    TEXT        NOT NULL CHECK (purpose IN ('set_password', 'reset_password')),
    created_by BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
);
CREATE INDEX magic_links_user_idx ON magic_links (user_id);

CREATE TABLE channels (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT        NOT NULL UNIQUE CHECK (name = lower(name) AND name ~ '^[a-z0-9-]{1,48}$'),
    topic       TEXT        NOT NULL DEFAULT '' CHECK (length(topic) <= 256),
    is_private  BOOLEAN     NOT NULL DEFAULT FALSE,
    position    INTEGER     NOT NULL DEFAULT 0,
    created_by  BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at TIMESTAMPTZ
);

CREATE TABLE channel_members (
    channel_id BIGINT      NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE messages (
    id          BIGSERIAL PRIMARY KEY,
    channel_id  BIGINT      NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    content     TEXT        NOT NULL,
    reply_to_id BIGINT      REFERENCES messages (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at   TIMESTAMPTZ,
    deleted_at  TIMESTAMPTZ
);
CREATE INDEX messages_channel_idx ON messages (channel_id, id DESC);
