-- Server-authoritative "open DM" state. Previously which DMs showed in the
-- sidebar was a per-browser localStorage set, so a fresh device reopened every
-- DM the user had ever started. dm_open makes openness per-user and durable: a
-- row means "this DM is open in this user's sidebar". Closing deletes the row;
-- starting a DM or receiving a message in one (re)inserts it.
CREATE TABLE dm_open (
    user_id    BIGINT      NOT NULL REFERENCES users (id)    ON DELETE CASCADE,
    channel_id BIGINT      NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    opened_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel_id)
);

-- Backfill every existing DM membership as open so the upgrade doesn't empty
-- everyone's DM sidebar; from here on, closing is authoritative and sticks.
INSERT INTO dm_open (user_id, channel_id)
SELECT cm.user_id, cm.channel_id
FROM channel_members cm
JOIN channels c ON c.id = cm.channel_id
WHERE c.is_dm = TRUE
ON CONFLICT DO NOTHING;
