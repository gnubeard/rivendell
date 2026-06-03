-- 0003_status_default.sql — make user status durable.
-- status is the user's *chosen* presence (online/away/dnd/offline) and is no
-- longer overwritten on every websocket connect/disconnect (connectivity now
-- lives only in the hub). Default to 'online' instead of 'offline', and reset
-- rows the old connect/disconnect logic had parked at 'offline' — no user had a
-- durable "invisible" choice before this, so this loses nothing.

ALTER TABLE users ALTER COLUMN status SET DEFAULT 'online';
UPDATE users SET status = 'online', updated_at = now() WHERE status = 'offline';
