-- 0007_search.sql — full-text message search.
-- A GIN index over to_tsvector('english', content) makes substring-stemmed
-- search fast. It's a functional index (no extra column or trigger): the same
-- expression appears in the WHERE clause of SearchMessages, so the planner uses
-- it directly. 'english' gives stemming (run/running/ran all match). Deleted
-- messages are filtered at query time, not excluded from the index.

CREATE INDEX messages_content_fts
    ON messages USING GIN (to_tsvector('english', content));
