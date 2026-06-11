CREATE TABLE user_notes (
    owner_id   int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note       text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, subject_id)
);
