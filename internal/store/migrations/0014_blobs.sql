CREATE TABLE blobs (
    hash         TEXT        PRIMARY KEY,
    uploader_id  BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    content_type TEXT        NOT NULL,
    size         BIGINT      NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
