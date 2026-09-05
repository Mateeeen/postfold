-- Comments, trend discovery, and the draft-approval queue.
--
-- The actions table gains two kinds (post_comment, sync_trends). SQLite cannot
-- ALTER a CHECK constraint, so the table is rebuilt: create, copy, drop,
-- rename, recreate indexes. The migration runner disables foreign keys around
-- each migration and runs foreign_key_check afterwards — without that, DROP
-- TABLE actions would either fail or silently orphan invites.action_id.

CREATE TABLE actions_new (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL
                       CHECK (kind IN ('create_post','send_invite','sync_engagers',
                                       'post_comment','sync_trends')),
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
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (dedupe_key)
);

INSERT INTO actions_new
  SELECT id, account_id, kind, status, payload, scheduled_at, claimed_at,
         completed_at, attempts, last_error, last_failure_class, dedupe_key,
         created_at, updated_at
    FROM actions;

DROP TABLE actions;
ALTER TABLE actions_new RENAME TO actions;

CREATE INDEX IF NOT EXISTS idx_actions_claimable
  ON actions(scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_actions_account_kind_status
  ON actions(account_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_actions_recent
  ON actions(account_id, created_at DESC);

-- Topics the account cares about. Either proposed from the profile or typed by
-- the user; `source` records which, so a regenerate never silently discards
-- something the user added by hand.
CREATE TABLE IF NOT EXISTS keywords (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  term       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','derived')),
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, term)
);

-- Posts discovered by keyword search. Not our posts — other people's, kept so
-- a comment draft can quote what it is replying to and so we never comment on
-- the same post twice.
CREATE TABLE IF NOT EXISTS discovered_posts (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  urn                TEXT NOT NULL,
  keyword            TEXT NOT NULL,
  text               TEXT NOT NULL,
  author_name        TEXT NOT NULL,
  author_headline    TEXT,
  author_provider_id TEXT,
  reactions          INTEGER NOT NULL DEFAULT 0,
  comments           INTEGER NOT NULL DEFAULT 0,
  posted_at          TEXT,
  discovered_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, urn)
);

CREATE INDEX IF NOT EXISTS idx_discovered_recent
  ON discovered_posts(account_id, discovered_at DESC);

-- Drafts awaiting a decision.
--
-- `auto_approve_at` is what makes an unattended draft publish. It is nullable:
-- null means this draft will wait forever, which is the correct behaviour for
-- anything the user has not opted into auto-approval for.
CREATE TABLE IF NOT EXISTS drafts (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('post','comment')),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','queued','dismissed','expired')),
  text               TEXT NOT NULL,
  -- Why this draft exists: the trend or post that prompted it.
  rationale          TEXT NOT NULL DEFAULT '',
  -- Set for comments; the post being replied to.
  discovered_post_id TEXT REFERENCES discovered_posts(id) ON DELETE CASCADE,
  model              TEXT,
  auto_approve_at    TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at         TEXT,
  decided_by         TEXT CHECK (decided_by IS NULL OR decided_by IN ('user','timer'))
);

CREATE INDEX IF NOT EXISTS idx_drafts_pending
  ON drafts(account_id, created_at DESC) WHERE status = 'pending';

-- The auto-approve sweep rides this: due drafts, cheaply.
CREATE INDEX IF NOT EXISTS idx_drafts_due
  ON drafts(auto_approve_at) WHERE status = 'pending' AND auto_approve_at IS NOT NULL;

-- One comment per post, ever.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_one_comment_per_post
  ON drafts(discovered_post_id) WHERE kind = 'comment' AND discovered_post_id IS NOT NULL;
