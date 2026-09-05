-- Three additions: replies to our comments, comment-reply support, and
-- acceptance polling.

-- Which comment we actually posted, so we can later read its replies.
ALTER TABLE drafts ADD COLUMN posted_comment_id TEXT;
ALTER TABLE drafts ADD COLUMN posted_post_urn TEXT;

-- When we last checked whether an invite was accepted. Polling reads this to
-- avoid re-checking the same person every pass.
ALTER TABLE invites ADD COLUMN last_checked_at TEXT;

-- suggestions.post_id was NOT NULL and referenced our own posts. A suggestion
-- can now also come from someone replying to a comment we left on SOMEBODY
-- ELSE'S post, where there is no row in `posts` at all. SQLite cannot drop a
-- NOT NULL, so the table is rebuilt.
CREATE TABLE suggestions_new (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  -- One of our posts, when the person engaged with it. Null for replies.
  post_id     TEXT REFERENCES posts(id) ON DELETE CASCADE,
  -- Someone else's post, when the person replied to our comment on it.
  discovered_post_id TEXT REFERENCES discovered_posts(id) ON DELETE CASCADE,
  -- Where this came from, so the UI can say why we are suggesting them.
  source      TEXT NOT NULL DEFAULT 'engager'
                CHECK (source IN ('engager','reply')),
  score       REAL NOT NULL DEFAULT 0,
  reason      TEXT NOT NULL DEFAULT '',
  draft_note  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','queued','dismissed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at  TEXT,
  UNIQUE (account_id, person_id)
);

INSERT INTO suggestions_new
  (id, account_id, person_id, post_id, discovered_post_id, source,
   score, reason, draft_note, status, created_at, decided_at)
  SELECT id, account_id, person_id, post_id, NULL, 'engager',
         score, reason, draft_note, status, created_at, decided_at
    FROM suggestions;

DROP TABLE suggestions;
ALTER TABLE suggestions_new RENAME TO suggestions;

CREATE INDEX IF NOT EXISTS idx_suggestions_pending
  ON suggestions(account_id, score DESC)
  WHERE status = 'pending';
