-- 0006_mutes.sql — per-user channel mutes.
-- A mute silences a channel for one user: no chime, no desktop notification, and
-- it stops contributing to that user's unread/mention counts. Durable and
-- cross-device (it's a row, not a localStorage flag). Mute is purely a
-- notification preference — it never hides the channel or its messages.

CREATE TABLE channel_mutes (
    user_id    BIGINT      NOT NULL REFERENCES users (id)    ON DELETE CASCADE,
    channel_id BIGINT      NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    muted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel_id)
);
