-- A face for the people you are asked to approve.
--
-- The connections flow shows one person at a time and asks for a yes or no on
-- them specifically. Name and headline alone make that a row in a spreadsheet;
-- a face makes it a person, which is the judgement actually being asked for.
--
-- Signed and expiring, like every other avatar here. Refreshed whenever the
-- person is seen again, and degrades to initials rather than a broken image.
ALTER TABLE people ADD COLUMN avatar_url TEXT;
