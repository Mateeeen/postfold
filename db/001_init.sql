-- PostFold schema (SQLite).
--
-- Conventions, applied without exception:
--   * ids are TEXT holding crypto.randomUUID() generated in the app.
--     There is no gen_random_uuid() here.
--   * every timestamp is TEXT holding ISO-8601 UTC, i.e. new Date().toISOString().
--     NEVER store an epoch integer in one of these columns. datetime('now')
--     produces 'YYYY-MM-DD HH:MM:SS' which compares correctly against ISO
--     strings for the ranges we use, but the app should prefer binding an ISO
--     string it computed itself.
--   * former enums are TEXT + CHECK, with the exact same string values the
--     Postgres enums had.
--   * former jsonb is TEXT holding JSON. Encode/decode happens in src/db/json.ts
--     and nowhere else.
--
-- PRAGMA foreign_keys = ON is set on every connection in src/db/index.ts.
-- Without it every REFERENCES and ON DELETE CASCADE below is decoration.

CREATE TABLE IF NOT EXISTS accounts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','paused','checkpointed','restricted','disconnected')),
  sending_enabled     INTEGER NOT NULL DEFAULT 1 CHECK (sending_enabled IN (0,1)),
  paused_reason       TEXT,
  connected_at        TEXT NOT NULL,
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  -- JSON array of weekday numbers, 0 = Sunday. Was smallint[].
  send_days           TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  window_start_hour   INTEGER NOT NULL DEFAULT 9,
  window_end_hour     INTEGER NOT NULL DEFAULT 17,
  -- JSON object keyed by action kind. Was jsonb. May only lower a cap.
  daily_cap_override  TEXT,
  checkpoint_until    TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider_account_id)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

CREATE TABLE IF NOT EXISTS posts (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  urn                TEXT,
  text               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','queued','published','failed')),
  published_at       TEXT,
  engagers_synced_at TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (urn)
);

CREATE INDEX IF NOT EXISTS idx_posts_account_published
  ON posts(account_id, published_at DESC);

CREATE TABLE IF NOT EXISTS people (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_person_id TEXT NOT NULL,
  name               TEXT NOT NULL,
  headline           TEXT,
  profile_url        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, provider_person_id)
);

CREATE TABLE IF NOT EXISTS engagements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('reaction','comment')),
  comment_text TEXT,
  occurred_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (post_id, person_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_engagements_person ON engagements(person_id);

CREATE TABLE IF NOT EXISTS suggestions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  score       REAL NOT NULL DEFAULT 0,
  reason      TEXT NOT NULL DEFAULT '',
  draft_note  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','queued','dismissed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at  TEXT,
  -- One live suggestion per person per account. Re-engaging on a later post
  -- must not produce a second card for someone already decided on.
  UNIQUE (account_id, person_id)
);

-- The suggestions list is always "pending, best first".
CREATE INDEX IF NOT EXISTS idx_suggestions_pending
  ON suggestions(account_id, score DESC)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS actions (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL
                       CHECK (kind IN ('create_post','send_invite','sync_engagers')),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','in_flight','done','failed','cancelled')),
  -- JSON. Was jsonb.
  payload            TEXT NOT NULL DEFAULT '{}',
  scheduled_at       TEXT NOT NULL,
  claimed_at         TEXT,
  completed_at       TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  last_failure_class TEXT
                       CHECK (last_failure_class IS NULL OR last_failure_class IN
                         ('transient','rate_limited','checkpoint','auth','invalid','permanent')),
  -- Natural key for the work. This is what makes scheduler.enqueue idempotent.
  dedupe_key         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (dedupe_key)
);

-- The worker's claim query rides on this partial index. Do not drop it; a full
-- index on scheduled_at makes the claim scan every terminal action ever run.
CREATE INDEX IF NOT EXISTS idx_actions_claimable
  ON actions(scheduled_at)
  WHERE status = 'pending';

-- Budget counting: pending-of-kind per account.
CREATE INDEX IF NOT EXISTS idx_actions_account_kind_status
  ON actions(account_id, kind, status);

CREATE INDEX IF NOT EXISTS idx_actions_recent
  ON actions(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  action_id   TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  provider_invite_id TEXT,
  status      TEXT NOT NULL DEFAULT 'sent'
                CHECK (status IN ('sent','accepted','withdrawn','expired')),
  sent_at     TEXT NOT NULL,
  accepted_at TEXT,
  UNIQUE (account_id, person_id)
);

-- Acceptance rate is a trailing-window aggregate over this index.
CREATE INDEX IF NOT EXISTS idx_invites_account_sent
  ON invites(account_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id                TEXT PRIMARY KEY,
  provider_event_id TEXT,
  type              TEXT NOT NULL,
  body              TEXT NOT NULL,
  received_at       TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at      TEXT,
  error             TEXT,
  UNIQUE (provider_event_id)
);
