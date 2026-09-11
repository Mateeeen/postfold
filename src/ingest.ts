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
import type { Authorship, DocumentSource } from './db/documents.js';
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
  /** Rows removed because this run no longer sees them. */
  pruned: number;
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
    pruned: 0,
    provenance: {
      ours: 0, theirs: 0, matchedById: 0, matchedByText: 0, sentByTimer: 0, sentByUser: 0,
    },
  };
  if (!account.ownerPersonId) return result;

  /** Text, flattened enough that retyping or re-encoding still matches. */
  const key = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  /**
   * The single place authorship is decided.
   *
   * `undefined` means the item never passed through us - written by hand on
   * the platform, and theirs. Anything we sent must name a person: 'user' and
   * nothing else. 'timer' and null are both unproven, and null is the common
   * case for everything sent before the decider stopped being erased.
   */
  const authorshipOf = (decided: string | null | undefined): Authorship =>
    decided === undefined || decided === 'user' ? 'human-verified' : 'unproven';

  // Everything this run actually saw, per source. Ingestion is authoritative
  // for the sources it manages, so a row it no longer sees is stale - and a
  // stale row keeps whatever trust it was written with, which is how an
  // orphan from an earlier, more permissive version stays citable forever.
  const seen = new Map<DocumentSource, Set<string>>();
  const fetched = new Set<DocumentSource>();

  const store = async (
    source: DocumentSource,
    text: string,
    externalId: string,
    authorship: Authorship,
  ): Promise<void> => {
    const attended = authorship === 'human-verified';
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
    const effective: DocumentSource = attended ? source : 'note';
    if (!seen.has(effective)) seen.set(effective, new Set());
    seen.get(effective)!.add(externalId);

    const saved = await addDocument(
      { accountId, source: effective, text, externalId, authorship },
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
    const page = await provider.listAuthoredPosts({
      providerAccountId: account.providerAccountId,
      providerPersonId: account.ownerPersonId,
      limit: 20,
    });
    for (const p of page.items) {
      // A repost is someone else's writing however it got there.
      if (p.isRepost) continue;
      const decided = ourPosts.has(p.urn) ? ourPosts.get(p.urn) : ourPostsByText.get(key(p.text));
      if (decided === undefined) result.provenance.theirs++;
      else {
        result.provenance.ours++;
        if (decided === 'user') result.provenance.sentByUser++;
        else result.provenance.sentByTimer++;
      }
      await store('linkedin_post', p.text, p.urn, authorshipOf(decided));
    }
    if (page.complete) fetched.add('linkedin_post');
    else console.warn('[ingest] posts page incomplete — skipping prune for this source');
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
    const page = await provider.listAuthoredComments({
      providerAccountId: account.providerAccountId,
      providerPersonId: account.ownerPersonId,
      limit: 50,
    });
    for (const c of page.items) {
      const byId = ourComments.has(c.id);
      const decided = byId ? ourComments.get(c.id) : ourComments.get(key(c.text));
      if (decided === undefined) result.provenance.theirs++;
      else {
        result.provenance.ours++;
        if (byId) result.provenance.matchedById++;
        else result.provenance.matchedByText++;
        if (decided === 'user') result.provenance.sentByUser++;
        else result.provenance.sentByTimer++; // timer or unknown: both unproven
      }
      // Fail closed. Not ours at all means written by hand on the platform and
      // is theirs. Ours requires positive proof a person approved it: 'timer'
      // and null both mean we cannot show anyone read it, and null is the
      // common case for anything sent before the decider was preserved.
      // Treating unknown as human is the same fail-open that let machine text
      // become citable in the first place.
      await store('linkedin_comment', c.text, c.id, authorshipOf(decided));
    }
    if (page.complete) fetched.add('linkedin_comment');
    else console.warn('[ingest] comments page incomplete — skipping prune for this source');
  } catch (err) {
    console.warn('[ingest] could not read own comments', err);
  }

  // Prune only where the fetch was COMPLETE, not merely successful. A
  // paginated read that returns page one and stops has succeeded while showing
  // a fraction of the material; pruning on that would delete valid evidence,
  // silently revert autopilot, and tell the user they are short items they
  // actually have. A stale row is a far cheaper mistake.
  for (const source of fetched) {
    const ids = [...(seen.get(source) ?? new Set<string>())];
    const placeholders = ids.map(() => '?').join(',');
    const removed = db
      .prepare(
        `DELETE FROM documents
          WHERE account_id = ? AND source = ?
            ${ids.length > 0 ? `AND external_id NOT IN (${placeholders})` : ''}`,
      )
      .run(accountId, source, ...ids);
    if (removed.changes > 0) {
      console.log(`[ingest] pruned ${removed.changes} stale ${source} document(s)`);
      result.pruned += removed.changes;
    }
  }

  result.evidenceTotal = (await evidenceCount(accountId, db)).evidence;
  return result;
}
