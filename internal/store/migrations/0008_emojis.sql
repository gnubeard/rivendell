-- 0008_emojis.sql — custom (instance-wide) emojis.
-- Stored exactly like avatars: the image bytes live in a BYTEA column alongside
-- their MIME type, so there's no filesystem/CDN dependency. The shortcode is the
-- :name: token typed in messages; UNIQUE makes it the natural key and keeps the
-- namespace collision-free. created_by is kept for provenance and goes NULL if the
-- uploader is later deleted (emojis are instance assets, not user-owned).

CREATE TABLE emojis (
    id         BIGSERIAL PRIMARY KEY,
    shortcode  TEXT NOT NULL UNIQUE,
    mime       TEXT NOT NULL,
    data       BYTEA NOT NULL,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
