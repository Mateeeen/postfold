-- Reach, as the platform reports it.
--
-- Followers and connections come from a full profile retrieve; /users/me does
-- not carry them. Impressions are summed from the owner's own posts, where the
-- platform reports a per-post counter.
--
-- Cached rather than fetched per page load: profile retrieval is a budgeted
-- operation on the provider side (their guidance is roughly 100 a day), and a
-- dashboard that refetched on every render would spend that budget on nobody
-- looking. Refreshed on the same schedule as the rest of the profile.
--
-- stats_updated_at exists so the UI can say how fresh these are rather than
-- implying they are live.
ALTER TABLE accounts ADD COLUMN follower_count INTEGER;
ALTER TABLE accounts ADD COLUMN connections_count INTEGER;
ALTER TABLE accounts ADD COLUMN impressions_7d INTEGER;
ALTER TABLE accounts ADD COLUMN posts_7d INTEGER;
ALTER TABLE accounts ADD COLUMN stats_updated_at TEXT;
