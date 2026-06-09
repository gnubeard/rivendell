-- Free-format profile fields surfaced on a user's profile card: pronouns and a
-- bio/notes box. Both are optional and default empty. They ride along on every
-- user object (the client already holds the full roster, so opening a profile
-- needs no extra fetch) and are edited via PATCH /api/me like display_name.
ALTER TABLE users ADD COLUMN pronouns TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
