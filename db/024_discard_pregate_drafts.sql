-- Retire everything written before the gate existed.
--
-- These drafts came from the version with nothing reading its output — the
-- one observed inventing a first-person anecdote with fabricated numbers.
-- Landing them on Home as an ordinary needs-you list would present a backlog
-- that has to be individually verified as not fabricated, and the fastest way
-- through such a list is a bulk approve: the one affordance this product has
-- deliberately never built. A queue that makes the forbidden thing feel
-- necessary is a badly designed queue.
--
-- Discarded, not deleted, and a status of its own rather than reusing
-- 'dismissed' — a person rejecting a draft and us retiring a generation of
-- them are different events, and conflating them would lose the only record
-- of which is which.
--
-- One-time and unconditional on 'pending' because every draft that exists at
-- this moment predates the gate. Later drafts are unaffected; migrations run
-- once.
PRAGMA foreign_keys = OFF;

CREATE TABLE drafts_new (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('post','comment')),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','queued','dismissed',
                                         'discarded','expired')),
  text               TEXT NOT NULL,
  rationale          TEXT NOT NULL DEFAULT '',
  discovered_post_id TEXT REFERENCES discovered_posts(id) ON DELETE CASCADE,
  model              TEXT,
  auto_approve_at    TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at         TEXT,
  decided_by         TEXT CHECK (decided_by IS NULL OR decided_by IN ('user','timer')),
  posted_comment_id  TEXT,
  posted_post_urn    TEXT,
  image_url          TEXT,
  image_prompt       TEXT,
  gaps               TEXT
);

INSERT INTO drafts_new (
  id, account_id, kind, status, text, rationale, discovered_post_id, model,
  auto_approve_at, created_at, decided_at, decided_by, posted_comment_id,
  posted_post_urn, image_url, image_prompt, gaps
)
SELECT
  id, account_id, kind, status, text, rationale, discovered_post_id, model,
  auto_approve_at, created_at, decided_at, decided_by, posted_comment_id,
  posted_post_urn, image_url, image_prompt, gaps
FROM drafts;

DROP TABLE drafts;
ALTER TABLE drafts_new RENAME TO drafts;

CREATE INDEX idx_drafts_pending
  ON drafts(account_id, created_at DESC) WHERE status = 'pending';
CREATE INDEX idx_drafts_due
  ON drafts(auto_approve_at) WHERE status = 'pending' AND auto_approve_at IS NOT NULL;
CREATE UNIQUE INDEX idx_drafts_one_comment_per_post
  ON drafts(discovered_post_id) WHERE kind = 'comment' AND discovered_post_id IS NOT NULL;

-- decided_by stays NULL: nobody decided these, which is the point of them.
UPDATE drafts
   SET status = 'discarded', decided_at = datetime('now')
 WHERE status = 'pending';

PRAGMA foreign_key_check;
PRAGMA foreign_keys = ON;
