-- 0005_notifications.sql — durable read state + ping records.
-- Powers unread badges that survive refresh/reconnect/multi-device and an
-- authoritative "missed notifications" count. A "ping" is a DM message or an
-- @-mention of you; plain channel chatter only counts toward the unread badge.

-- Per (user, channel) read cursor: the highest message id the user has seen in
-- that channel. Unread = messages newer than this that the user didn't author.
CREATE TABLE channel_reads (
    user_id              BIGINT      NOT NULL REFERENCES users (id)    ON DELETE CASCADE,
    channel_id           BIGINT      NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    last_read_message_id BIGINT      NOT NULL DEFAULT 0,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel_id)
);

-- One row per pinged recipient of a message (the DM partner, or an @-mentioned
-- user), written at message-create time. channel_id is denormalized so ping
-- counts need no join back to messages. The author is never recorded — you do
-- not ping yourself. "Missed" pings = rows whose message_id exceeds the user's
-- read cursor for that channel.
CREATE TABLE message_mentions (
    message_id BIGINT NOT NULL REFERENCES messages (id)  ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users (id)     ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels (id)  ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_mentions_user_idx ON message_mentions (user_id, channel_id);

-- Backfill so existing users start "caught up" rather than facing their entire
-- history as unread: seed every accessible (user, channel) cursor to that
-- channel's current newest message id.
INSERT INTO channel_reads (user_id, channel_id, last_read_message_id)
SELECT u.id, c.id, COALESCE((SELECT max(m.id) FROM messages m WHERE m.channel_id = c.id), 0)
FROM users u
CROSS JOIN channels c
WHERE c.archived_at IS NULL
  AND (c.is_private = FALSE
       OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = u.id))
ON CONFLICT DO NOTHING;
