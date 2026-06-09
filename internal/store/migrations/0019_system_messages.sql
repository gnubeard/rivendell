-- System messages: server-generated events posted to a channel log (e.g. call
-- started / call ended). They have no author (user_id = NULL) and are rendered
-- differently by the client (no avatar, no actions, centred event text).
ALTER TABLE messages ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE messages ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT FALSE;
