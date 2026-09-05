-- A short machine-written summary of what a completed action actually did.
--
-- Without this, a sync that searched 8 keywords, found 40 posts and drafted
-- nothing is indistinguishable from a sync that never ran — which is exactly
-- how "I clicked the button and nothing happened" becomes unanswerable.
ALTER TABLE actions ADD COLUMN result TEXT;
