/**
 * Fill the voice bank from material whose authorship we can verify.
 *
 * Everything here produces `evidence`-trust documents, because everything here
 * is something this account demonstrably wrote: posts under their name, and
 * comments this product posted on their behalf and recorded the text of.
 *
 * Pasted text and links do not come through this file. They arrive from the
 * user, land as `voice`, and are never citable — see the note in
 * db/documents.ts.
 */

import { getAccount } from './db/accounts.js';
import { addDocument, evidenceCount } from './db/documents.js';
import type { Db } from './db/index.js';
import { getDb } from './db/index.js';
import type { SocialProvider } from './provider.js';
import { getProvider } from './providers/index.js';

export interface IngestResult {
  posts: number;
  comments: number;
  evidenceTotal: number;
}

/**
 * Read the account's own writing into the bank.
 *
 * Idempotent: documents are keyed on their platform id, so running this twice
 * refreshes rather than duplicates. That matters because the evidence count is
 * the unlock signal — a count inflated by re-ingestion would unlock autopilot
 * on material that does not exist.
 */
export async function ingestOwnWriting(
  accountId: string,
  provider: SocialProvider = getProvider(),
  db: Db = getDb(),
): Promise<IngestResult> {
  const account = await getAccount(accountId, db);
  if (!account) throw new Error(`Unknown account ${accountId}`);

  let posts = 0;
  if (account.ownerPersonId) {
    try {
      const authored = await provider.listAuthoredPosts({
        providerAccountId: account.providerAccountId,
        providerPersonId: account.ownerPersonId,
        limit: 20,
      });
      for (const p of authored) {
        // A repost is someone else's writing. Citing it as this person's own
        // material is exactly the confusion the trust split exists to stop.
        if (p.isRepost) continue;
        const saved = await addDocument(
          { accountId, source: 'linkedin_post', text: p.text, externalId: p.urn },
          db,
        );
        if (saved) posts++;
      }
    } catch (err) {
      console.warn('[ingest] could not read own posts', err);
    }
  }

  // Comments this product actually posted. Authorship is verifiable because we
  // are the thing that sent them, and the text is on the draft row.
  const sent = db
    .prepare(
      `SELECT id, text FROM drafts
        WHERE account_id = ? AND kind = 'comment' AND posted_comment_id IS NOT NULL`,
    )
    .all(accountId) as { id: string; text: string }[];

  let comments = 0;
  for (const c of sent) {
    const saved = await addDocument(
      { accountId, source: 'linkedin_comment', text: c.text, externalId: c.id },
      db,
    );
    if (saved) comments++;
  }

  const { evidence } = await evidenceCount(accountId, db);
  return { posts, comments, evidenceTotal: evidence };
}
