-- 'declined' as a status of its own.
--
-- Reconciliation could previously only say "no longer pending", and wrote
-- 'withdrawn' for all of it. The arithmetic is unaffected — both are
-- resolved-and-not-accepted — but the diagnostic is not: a withdrawal is our
-- own housekeeping, and a decline is the market telling us something about who
-- we are asking and how. Collapsing them hides the only signal separating
-- "we are targeting badly" from "we tidied up".
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Existing
-- rows keep their current status: no outcome is inferred for anything, and
-- nothing already written as 'withdrawn' is reinterpreted as a decline.
PRAGMA foreign_keys = OFF;

CREATE TABLE invites_new (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  person_id          TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  action_id          TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  provider_invite_id TEXT,
  status             TEXT NOT NULL DEFAULT 'sent'
                       CHECK (status IN ('sent','accepted','declined','withdrawn','expired')),
  sent_at            TEXT NOT NULL,
  accepted_at        TEXT,
  last_checked_at    TEXT,
  with_note          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (account_id, person_id)
);

INSERT INTO invites_new
  SELECT id, account_id, person_id, action_id, provider_invite_id, status,
         sent_at, accepted_at, last_checked_at, with_note
    FROM invites;

DROP TABLE invites;
ALTER TABLE invites_new RENAME TO invites;

CREATE INDEX idx_invites_account_sent ON invites(account_id, sent_at DESC);
-- Reconciliation and the pending-pile check both scan by status.
CREATE INDEX idx_invites_status ON invites(account_id, status, sent_at);

PRAGMA foreign_key_check;
PRAGMA foreign_keys = ON;
