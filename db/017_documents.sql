-- The voice bank, with a trust boundary.
--
-- Two levels, and the distinction is load-bearing rather than tidy.
--
--   voice     Anything the user offers: pasted text, saved links, notes.
--             Shapes tone and vocabulary. Never citable.
--   evidence  Authorship is verifiable: their own posts, their own comments,
--             their own commits. The ONLY material a retrieval fill or the
--             numeral provenance scan may cite.
--
-- Without the split, someone pasting an article to bootstrap faster makes that
-- article citable as their own claim — and the fabrication guarantee degrades
-- silently, which is the worst way for a guarantee to go.
--
-- external_id makes ingestion idempotent: re-reading the same twenty posts
-- must not produce twenty more rows, or the evidence count lies about how much
-- material there really is.
CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  trust        TEXT NOT NULL CHECK (trust IN ('voice', 'evidence')),
  source       TEXT NOT NULL CHECK (source IN (
                 'linkedin_post', 'linkedin_comment', 'commit', 'pull_request',
                 'note', 'link'
               )),
  text         TEXT NOT NULL,
  external_id  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, source, external_id)
);

CREATE INDEX documents_by_trust ON documents (account_id, trust, created_at DESC);
