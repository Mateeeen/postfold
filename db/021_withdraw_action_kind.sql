-- Teach the queue about withdrawals.
--
-- The CHECK on actions.kind is the reason a new action type cannot simply be
-- added in TypeScript: the enqueue would compile, typecheck, and then fail at
-- the database on the first real attempt. SQLite cannot alter a CHECK, so the
-- table is rebuilt — the same dance migration 007 did for the previous batch.
--
-- The partial index on claimable work is recreated explicitly. Losing it would
-- turn every worker tick into a full scan of a table that only ever grows.
PRAGMA foreign_keys = OFF;

CREATE TABLE actions_new (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL
                       CHECK (kind IN ('create_post','send_invite','sync_engagers',
                                       'post_comment','sync_trends',
                                       'sync_replies','poll_acceptance',
                                       'withdraw_invite')),
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

INSERT INTO actions_new SELECT * FROM actions;

DROP TABLE actions;
ALTER TABLE actions_new RENAME TO actions;

CREATE INDEX idx_actions_claimable
  ON actions(scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_actions_account_kind_status
  ON actions(account_id, kind, status);
CREATE INDEX idx_actions_recent
  ON actions(account_id, created_at DESC);

PRAGMA foreign_key_check;
PRAGMA foreign_keys = ON;
