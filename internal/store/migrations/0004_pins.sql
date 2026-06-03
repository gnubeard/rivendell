-- 0004_pins.sql — pinned messages.
-- A pin is just a nullable timestamp on the message (mirroring edited_at /
-- deleted_at), plus who pinned it. pinned_at IS NOT NULL means "pinned".

ALTER TABLE messages ADD COLUMN pinned_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN pinned_by BIGINT REFERENCES users (id) ON DELETE SET NULL;

-- Fast lookup of a channel's pins.
CREATE INDEX messages_pinned_idx ON messages (channel_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;
