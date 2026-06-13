CREATE TABLE link_previews (
    url         TEXT        NOT NULL PRIMARY KEY CHECK (length(url) <= 2048),
    title       TEXT        NOT NULL DEFAULT '',
    description TEXT        NOT NULL DEFAULT '',
    image_url   TEXT        NOT NULL DEFAULT '',
    site_name   TEXT        NOT NULL DEFAULT '',
    error_msg   TEXT,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX link_previews_expires_idx ON link_previews (expires_at);
