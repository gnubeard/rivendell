-- 0009_reactions.sql — per-message emoji reactions.
-- emoji is EITHER a custom shortcode (matching the emojis.shortcode namespace) OR a
-- literal Unicode emoji grapheme; the client resolves which at render time — a value
-- present in the custom-emoji registry renders as its <img>, anything else as literal
-- text. The PK makes "one of each emoji per user per message" intrinsic and makes the
-- add idempotent (INSERT ... ON CONFLICT DO NOTHING). The cascades mean a hard-deleted
-- message or user takes its reactions with it; a soft-deleted message clears them
-- explicitly (see SoftDeleteMessage's companion DeleteReactionsForMessage call).
CREATE TABLE message_reactions (
    message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    emoji      TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);

-- Batch-aggregating reactions for a page of messages keys on message_id.
CREATE INDEX message_reactions_message_idx ON message_reactions (message_id);
