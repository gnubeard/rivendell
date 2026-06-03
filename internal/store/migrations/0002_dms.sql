-- 0002_dms.sql — direct messages.
-- A DM is just a private channel with exactly two members (is_dm = TRUE),
-- reusing the channels + channel_members model rather than a parallel system.
-- The channel name is canonical (dm-<minUserId>-<maxUserId>) so a pair maps to
-- exactly one channel; the existing UNIQUE(name) makes create-or-find race-safe.

ALTER TABLE channels ADD COLUMN is_dm BOOLEAN NOT NULL DEFAULT FALSE;

-- Speeds up listing a user's DMs / channels by membership.
CREATE INDEX channel_members_user_idx ON channel_members (user_id);
