-- Two more action kinds: reading replies to our comments, and polling whether
-- invites were accepted. Same table-rebuild dance as 003 — SQLite cannot ALTER
-- a CHECK constraint.
CREATE TABLE actions_new (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL
                       CHECK (kind IN ('create_post','send_invite','sync_engagers',
                                       'post_comment','sync_trends',
                                       'sync_replies','poll_acceptance')),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','in_flight','done','failed','cancelled')),
  payload            TEXT NOT NULL DEFAULT '{}',
  scheduled_at       TEXT NOT NULL,
  claimed_at         TEXT,
  completed_at       TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  last_failure_class TEXT
                       CHECK (last_failure_class IS NULL OR last_failure_class IN
                         ('transient','rate_limited','checkpoint','auth','invalid','permanent')),
  dedupe_key         TEXT NOT NULL,
  result             TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (dedupe_key)
);

INSERT INTO actions_new
  SELECT id, account_id, kind, status, payload, scheduled_at, claimed_at,
         completed_at, attempts, last_error, last_failure_class, dedupe_key,
         result, created_at, updated_at
    FROM actions;

DROP TABLE actions;
ALTER TABLE actions_new RENAME TO actions;

CREATE INDEX IF NOT EXISTS idx_actions_claimable
  ON actions(scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_actions_account_kind_status
  ON actions(account_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_actions_recent
  ON actions(account_id, created_at DESC);
