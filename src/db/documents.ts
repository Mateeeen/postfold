/**
 * The voice bank.
 *
 * Two trust levels, and the whole file exists to keep them apart. `evidence`
 * is material whose authorship we can verify — their own posts, their own
 * comments. `voice` is anything they hand us: pasted text, notes, links.
 *
 * Only evidence may be cited. A retrieval fill quotes it; the numeral
 * provenance scan checks against it. Voice shapes tone and nothing else.
 *
 * The reason is not fussiness. Retrieved material becomes the thing that lets
 * a specific through the provenance scan, so if pasted text counted as
 * evidence, pasting an article to bootstrap faster would make that article
 * citable as the user's own claim — and the fabrication guarantee would
 * degrade with nobody noticing. Callers ask for one level or the other by
 * name; there is deliberately no function that returns both as one blob.
 */

import { getDb, newId } from './index.js';
import type { Db } from './index.js';

export type Trust = 'voice' | 'evidence';

export type DocumentSource =
  | 'linkedin_post'
  | 'linkedin_comment'
  | 'commit'
  | 'pull_request'
  | 'note'
  | 'link';

/** Which sources carry verifiable authorship. The list is the boundary. */
const EVIDENCE_SOURCES: readonly DocumentSource[] = [
  'linkedin_post',
  'linkedin_comment',
  'commit',
  'pull_request',
];

/**
 * Did a person demonstrably stand behind these words?
 *
 * Not a boolean, because a boolean invites `!machineWritten` and every one of
 * the three fail-open bugs in this layer was a negation of an unknown.
 */
export type Authorship = 'human-verified' | 'unproven';

/**
 * Trust, defaulting to voice.
 *
 * Both conditions must hold for evidence: a source whose authorship CAN be
 * verified, and an authorship signal that actually verifies it. The parameter
 * defaults to 'unproven' so that a caller which forgets to pass one gets the
 * safe answer rather than the permissive one - invariant 12, made structural
 * rather than remembered.
 */
export function trustFor(
  source: DocumentSource,
  authorship: Authorship = 'unproven',
): Trust {
  if (authorship !== 'human-verified') return 'voice';
  return EVIDENCE_SOURCES.includes(source) ? 'evidence' : 'voice';
}

export interface VoiceDocument {
  id: string;
  accountId: string;
  trust: Trust;
  source: DocumentSource;
  text: string;
  externalId: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  account_id: string;
  trust: string;
  source: string;
  text: string;
  external_id: string | null;
  created_at: string;
}

const map = (r: Row): VoiceDocument => ({
  id: r.id,
  accountId: r.account_id,
  trust: r.trust as Trust,
  source: r.source as DocumentSource,
  text: r.text,
  externalId: r.external_id,
  createdAt: r.created_at,
});

/**
 * Store a document.
 *
 * Trust is derived, never passed in: a caller that could choose its own trust
 * level can promote pasted text to evidence by accident. It needs both a
 * source whose authorship can be verified AND an authorship signal that
 * verifies it, and the latter defaults to `unproven`.
 */
export async function addDocument(
  input: {
    accountId: string;
    source: DocumentSource;
    text: string;
    externalId?: string | null;
    /** Omitted means unproven, which means voice. Never default to trust. */
    authorship?: Authorship;
  },
  db: Db = getDb(),
): Promise<VoiceDocument | null> {
  const text = input.text.trim();
  // Two words of material help nobody and dilute the retrieval prompt.
  if (text.length < 40) return null;

  const id = newId();
  db.prepare(
    `INSERT INTO documents (id, account_id, trust, source, text, external_id)
     VALUES (@id, @accountId, @trust, @source, @text, @externalId)
     ON CONFLICT (account_id, source, external_id) DO UPDATE SET text = excluded.text`,
  ).run({
    id,
    accountId: input.accountId,
    trust: trustFor(input.source, input.authorship),
    source: input.source,
    text,
    externalId: input.externalId ?? null,
  });

  const row = db
    .prepare(
      `SELECT * FROM documents WHERE account_id = ? AND source = ?
        AND external_id IS ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.accountId, input.source, input.externalId ?? null) as Row | undefined;
  return row ? map(row) : null;
}

/**
 * Material that may be cited.
 *
 * Everything the provenance scan and retrieval are allowed to see. Nothing
 * else in the codebase should assemble this string.
 */
export async function evidenceMaterial(
  accountId: string,
  limit = 40,
  db: Db = getDb(),
): Promise<string> {
  const rows = db
    .prepare(
      `SELECT text FROM documents
        WHERE account_id = ? AND trust = 'evidence'
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(accountId, limit) as { text: string }[];
  return rows.map((r) => r.text).join('\n\n');
}

/** Material that may shape tone. Both levels — style is not a truth claim. */
export async function voiceSamples(
  accountId: string,
  limit = 5,
  db: Db = getDb(),
): Promise<string[]> {
  const rows = db
    .prepare(
      `SELECT text FROM documents
        WHERE account_id = ?
        ORDER BY trust = 'evidence' DESC, created_at DESC
        LIMIT ?`,
    )
    .all(accountId, limit) as { text: string }[];
  return rows.map((r) => r.text);
}

/**
 * How much citable material exists.
 *
 * The leading indicator for everything else: grounded-draft rate cannot move
 * until this does, and when autopilot eligibility stays low this is what
 * separates "ingestion is the bottleneck" from "retrieval is".
 */
export async function evidenceCount(
  accountId: string,
  db: Db = getDb(),
): Promise<{ evidence: number; voice: number }> {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE trust = 'evidence') AS evidence,
         COUNT(*) FILTER (WHERE trust = 'voice')    AS voice
       FROM documents WHERE account_id = ?`,
    )
    .get(accountId) as { evidence: number; voice: number };
  return row;
}
