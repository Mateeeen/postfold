-- How a post was approved.
--
-- Evidence requires that a person stood behind the words, not merely that they
-- left our system under the user's name. A post this product published
-- unattended is machine text wearing the user's byline; quoting it back as
-- their own material would let one autopilot draft license the specifics in
-- the next — the same degradation as a pasted article, through a door we
-- built ourselves.
--
-- Null means we did not publish it: written by hand on the platform, and
-- therefore unambiguously theirs.
ALTER TABLE posts ADD COLUMN decided_by TEXT
  CHECK (decided_by IS NULL OR decided_by IN ('user', 'timer'));
