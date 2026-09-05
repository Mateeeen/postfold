-- Links back to the real post and author.
--
-- Search returns a share_url whose URN form (activity:) differs from the
-- social_id it also returns (ugcPost:) — so the URL is stored as given rather
-- than derived, and only falls back to a constructed one when absent.
ALTER TABLE discovered_posts ADD COLUMN share_url TEXT;
ALTER TABLE discovered_posts ADD COLUMN author_public_identifier TEXT;
