CREATE TABLE bot_tokens (
    id         BIGSERIAL    PRIMARY KEY,
    user_id    BIGINT       NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash TEXT         NOT NULL UNIQUE,
    name       TEXT         NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX bot_tokens_user_idx ON bot_tokens (user_id);
