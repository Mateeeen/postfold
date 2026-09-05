-- The account owner's own person id at the provider.
--
-- Without this we cannot tell the account owner apart from anyone else who
-- engaged with a post, so reacting to your own post makes you a connection
-- suggestion for yourself. Populated at connect time; null for accounts
-- connected before this migration, which simply means no filtering for them.
ALTER TABLE accounts ADD COLUMN owner_person_id TEXT;
