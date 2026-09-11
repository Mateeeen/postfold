/**
 * Is autopilot reachable, and if not, what is missing?
 *
 * Three numbers, and the order matters. Evidence-document count is the leading
 * indicator: grounded-draft rate cannot move until it does, and when autopilot
 * eligibility stays low this is what separates "ingestion is the bottleneck"
 * from "retrieval is".
 *
 * The blocked message names which KIND of material is missing. Someone who has
 * pasted ten articles and still cannot unlock will otherwise conclude the
 * product is broken — and they would be right to, because nothing on screen
 * told them pasted text is not citable.
 */

import { evidenceCount } from './db/documents.js';
import type { Db } from './db/index.js';
import { getDb } from './db/index.js';
import { LIMITS } from './policy.js';

export interface Readiness {
  evidenceDocuments: number;
  voiceDocuments: number;
  /** Drafts whose gaps were all filled from evidence, over drafts with gaps. */
  groundedDraftRate: number | null;
  fills: { retrieved: number; user: number; open: number };
  autopilotReady: boolean;
  /** Written for the user, naming the missing thing. Null when ready. */
  blockedBy: string | null;
}

export async function readiness(
  accountId: string,
  db: Db = getDb(),
): Promise<Readiness> {
  const { evidence, voice } = await evidenceCount(accountId, db);

  const rows = db
    .prepare(
      `SELECT gaps FROM drafts
        WHERE account_id = ? AND kind = 'post' AND gaps IS NOT NULL
        ORDER BY created_at DESC LIMIT 50`,
    )
    .all(accountId) as { gaps: string }[];

  let withGaps = 0;
  let grounded = 0;
  const fills = { retrieved: 0, user: 0, open: 0 };

  for (const r of rows) {
    let parsed: { value: string | null; source: string | null }[];
    try {
      parsed = JSON.parse(r.gaps) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.length === 0) continue;
    withGaps++;

    for (const g of parsed) {
      if (g.value === null) fills.open++;
      else if (g.source === 'retrieved') fills.retrieved++;
      else fills.user++;
    }
    if (parsed.every((g) => g.value !== null && g.source === 'retrieved')) grounded++;
  }

  const ready = evidence >= LIMITS.AUTOPILOT_MIN_EVIDENCE_DOCS;
  const short = LIMITS.AUTOPILOT_MIN_EVIDENCE_DOCS - evidence;

  return {
    evidenceDocuments: evidence,
    voiceDocuments: voice,
    groundedDraftRate: withGaps === 0 ? null : grounded / withGaps,
    fills,
    autopilotReady: ready,
    blockedBy: ready
      ? null
      : `Autopilot needs more of your own writing to work from — ${short} more `
        + `${short === 1 ? 'post or comment' : 'posts or comments'}. `
        + (voice > 0
            ? 'Pasted notes and links shape the writing style but cannot be quoted as yours.'
            : 'It can only quote things you actually wrote.'),
  };
}
