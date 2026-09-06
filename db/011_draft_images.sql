-- An image generated for a post draft.
--
-- Stored as a data URI rather than a link. The generator hands back a CDN URL
-- that expires within the hour, and a draft sits for a full day before it
-- publishes itself — so a stored link would be dead exactly when it was needed.
--
-- The prompt is kept alongside it so a bad image can be explained rather than
-- just regenerated blindly.
ALTER TABLE drafts ADD COLUMN image_url TEXT;
ALTER TABLE drafts ADD COLUMN image_prompt TEXT;
