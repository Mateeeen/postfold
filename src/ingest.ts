/**
 * Fill the voice bank, at the right trust level.
 *
 * Verifiable origin is not enough. A post this product published unattended
 * left the platform under the user's name and is still machine text — quoting
 * it back as their own material would let one autopilot draft license the
 * specifics in the next, which is the pasted-article degradation arriving
 * through a door we built ourselves.
 *
 * So the test is human authorship: did a person stand behind these words?
 *
 *   written by hand on the platform   → evidence  (never passed through us)
 *   approved by a person in review    → evidence  (they read it and said yes)
 *   published on a timer, unattended  → voice     (nobody read it)
 *
 * Voice is not discarded. It still shapes tone, which is the thing it is
 * actually qualified to do.
 */

import { getAccount } from './db/accounts.js';
import { addDocument, evidenceCount } from './db/documents.js';
import type { DocumentSource } from './db/documents.js';
import type { Db } from './db/index.js';
import { getDb } from './db/index.js';
import type { SocialProvider } from './provider.js';
import { getProvider } from './providers/index.js';

export interface IngestResult {
  evidence: number;
  voice: number;
  /** Items downgraded because nobody read them before they went out. */
  unattended: number;
  evidenceTotal: number;
}

/**
 * Read the account's own writing into the bank.
 *
 * Idempotent on the platform's own ids: the evidence count is the autopilot
 * unlock signal, and a count inflated by re-reading the same material would
 * unlock on writing that does not exist.
 */
export async function ingestOwnWriting(
  accountId: string,
  provider: SocialProvider = getProvider(),
  db: Db = getDb(),
): Promise<IngestResult> {
  const account = await getAccount(accountId, db);
  if (!account) throw new Error(`Unknown account ${accountId}`);

  const result: IngestResult = { evidence: 0, voice: 0, unattended: 0, evidenceTotal: 0 };
  if (!account.ownerPersonId) return result;

  const store = async (
    source: DocumentSource,
    text: string,
    externalId: string,
    attended: boolean,
  ): Promise<void> => {
    // A voice-trust row for something whose source would normally be evidence:
    // 'note' is the vehicle, because trust is derived from source and nothing
    // may pass a trust level in directly.
    const saved = await addDocument(
      { accountId, source: attended ? source : 'note', text, externalId },
      db,
    );
    if (!saved) return;
    if (attended) result.evidence++;
    else {
      result.voice++;
      result.unattended++;
    }
  };

  /* --- Their posts ----------------------------------------------------- */

  // Posts we published, and how they were approved. Absent from this map means
  // it never went through us, which makes it unambiguously theirs.
  const ourPosts = new Map<string, string | null>();
  for (const row of db
    .prepare(`SELECT urn, decided_by FROM posts WHERE account_id = ? AND urn IS NOT NULL`)
    .all(accountId) as { urn: string; decided_by: string | null }[]) {
    ourPosts.set(row.urn, row.decided_by);
  }

  try {
    const authored = await provider.listAuthoredPosts({
      providerAccountId: account.providerAccountId,
      providerPersonId: account.ownerPersonId,
      limit: 20,
    });
    for (const p of authored) {
      // A repost is someone else's writing however it got there.
      if (p.isRepost) continue;
      const attended = !ourPosts.has(p.urn) || ourPosts.get(p.urn) !== 'timer';
      await store('linkedin_post', p.text, p.urn, attended);
    }
  } catch (err) {
    console.warn('[ingest] could not read own posts', err);
  }

  /* --- Their comments -------------------------------------------------- */

  // The platform returns every comment they have written, including the ones
  // this product posted for them; it does not distinguish. We can, because we
  // recorded the id of each comment we sent.
  const ourComments = new Map<string, string | null>();
  for (const row of db
    .prepare(
      `SELECT posted_comment_id AS id, decided_by FROM drafts
        WHERE account_id = ? AND kind = 'comment' AND posted_comment_id IS NOT NULL`,
    )
    .all(accountId) as { id: string; decided_by: string | null }[]) {
    ourComments.set(row.id, row.decided_by);
  }

  try {
    const comments = await provider.listAuthoredComments({
      providerAccountId: account.providerAccountId,
      providerPersonId: account.ownerPersonId,
      limit: 50,
    });
    for (const c of comments) {
      const attended = !ourComments.has(c.id) || ourComments.get(c.id) !== 'timer';
      await store('linkedin_comment', c.text, c.id, attended);
    }
  } catch (err) {
    console.warn('[ingest] could not read own comments', err);
  }

  result.evidenceTotal = (await evidenceCount(accountId, db)).evidence;
  return result;
}
