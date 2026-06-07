-- Per-user UI theme. A durable personal preference so logging in from any device
-- restores your familiar look. 'default' is the built-in dark theme; the client
-- knows the full set (light/forest/hotpink/contrast/vermillion) and the handler
-- validates against it, so the column stays a plain TEXT (no CHECK to migrate
-- every time a theme is added).
ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'default';
