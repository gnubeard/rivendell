UPDATE users SET avatar_updated_at = now() WHERE avatar IS NOT NULL AND avatar_updated_at IS NULL;
