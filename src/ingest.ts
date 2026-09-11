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
  /**
   * How each ingested item was classified, and why.
   *
   * Here because the first version of this filter silently classified
   * everything as human-authored and the only symptom was a number that did
   * not drop when it should have. A count that can only be read by inference
   * is a count that hides its own bugs.
   */
  provenance: {
    ours: number;
    theirs: number;
    matchedById: number;
    matchedByText: number;
    sentByTimer: number;
    sentByUser: number;
  };
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

  const result: IngestResult = {
    evidence: 0,
    voice: 0,
    unattended: 0,
    evidenceTotal: 0,
    provenance: {
      ours: 0, theirs: 0, matchedById: 0, matchedByText: 0, sentByTimer: 0, sentByUser: 0,
    },
  };
  if (!account.ownerPersonId) return result;

  /** Text, flattened enough that retyping or re-encoding still matches. */
  const key = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const store = async (
    source: DocumentSource,
    text: string,
    externalId: string,
    attended: boolean,
  ): Promise<void> => {
    // Re-ingestion must be able to DOWNGRADE. A row stored as evidence before
    // this rule existed would otherwise keep its trust level forever, because
    // the upsert keys on source and the source is what carries trust.
    db.prepare(
      `DELETE FROM documents
        WHERE account_id = ? AND external_id = ? AND source <> ?`,
    ).run(accountId, externalId, attended ? source : 'note');

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
  const ourPostsByText = new Map<string, string | null>();
  for (const row of db
    .prepare(`SELECT urn, text, decided_by FROM posts WHERE account_id = ?`)
    .all(accountId) as { urn: string | null; text: string; decided_by: string | null }[]) {
    if (row.urn) ourPosts.set(row.urn, row.decided_by);
    // Same reasoning as comments: urn forms differ between publish and read.
    ourPostsByText.set(key(row.text), row.decided_by);
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
      const decided = ourPosts.has(p.urn) ? ourPosts.get(p.urn) : ourPostsByText.get(key(p.text));
      const attended = decided === undefined || decided !== 'timer';
      await store('linkedin_post', p.text, p.urn, attended);
    }
  } catch (err) {
    console.warn('[ingest] could not read own posts', err);
  }

  /* --- Their comments -------------------------------------------------- */

  // The platform returns every comment they have written, including the ones
  // this product posted for them; it does not distinguish. We can, because we
  // recorded the id of each comment we sent.
  //
  // Matched on BOTH id and text. The id alone fails open: the list endpoint
  // returns bare numeric ids while postComment stores `comment_id ?? id ??
  // 'unknown'` - a different namespace with a poisoned fallback - so nothing
  // ever matched, every comment looked human-authored, and the evidence count
  // grew silently. Text is the key that cannot drift between two endpoints.
  const ourComments = new Map<string, string | null>();
  for (const row of db
    .prepare(
      `SELECT posted_comment_id AS id, text, decided_by FROM drafts
        WHERE account_id = ? AND kind = 'comment' AND status IN ('queued', 'approved')`,
    )
    .all(accountId) as { id: string | null; text: string; decided_by: string | null }[]) {
    if (row.id) ourComments.set(row.id, row.decided_by);
    ourComments.set(key(row.text), row.decided_by);
  }

  try {
    const comments = await provider.listAuthoredComments({
      providerAccountId: account.providerAccountId,
      providerPersonId: account.ownerPersonId,
      limit: 50,
    });
    for (const c of comments) {
      const byId = ourComments.has(c.id);
      const decided = byId ? ourComments.get(c.id) : ourComments.get(key(c.text));
      if (decided === undefined) result.provenance.theirs++;
      else {
        result.provenance.ours++;
        if (byId) result.provenance.matchedById++;
        else result.provenance.matchedByText++;
        if (decided === 'timer') result.provenance.sentByTimer++;
        if (decided === 'user') result.provenance.sentByUser++;
      }
      // Not ours at all means written by hand on the platform: theirs.
      const attended = decided === undefined || decided !== 'timer';
      await store('linkedin_comment', c.text, c.id, attended);
    }
  } catch (err) {
    console.warn('[ingest] could not read own comments', err);
  }

  result.evidenceTotal = (await evidenceCount(accountId, db)).evidence;
  return result;
}
