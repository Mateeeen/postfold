-- LinkedIn account tier, and whether each invite carried a note.
--
-- These interact in a way that dominates every other invite limit: on a FREE
-- account LinkedIn allows roughly 5 invitations per MONTH when a note is
-- attached, versus ~150 per week without one. On premium the note costs
-- nothing. Without knowing the tier we cannot tell a user why their invites
-- stopped working.
ALTER TABLE accounts ADD COLUMN is_premium INTEGER;
ALTER TABLE accounts ADD COLUMN headline TEXT;

-- Needed to count note-bearing invites against the monthly free-tier ceiling.
ALTER TABLE invites ADD COLUMN with_note INTEGER NOT NULL DEFAULT 1;
