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
  /** Held, but not citable, because nobody read it before it was sent. */
  unattendedDocuments: number;
  /** Written for the user, naming the missing thing. Null when ready. */
  blockedBy: string | null;
}

/**
 * Why autopilot is not available, in the user's terms.
 *
 * Losing an unlock reads as breakage unless the reason is stated, and "add
 * more material" is not a reason to someone who has already added plenty of
 * the wrong kind. The unattended count is named explicitly because it is the
 * surprising half: writing that is theirs by byline and not by authorship.
 */
function blockedMessage(short: number, unattended: number, pasted: number): string {
  const need = `${short} more ${short === 1 ? 'post or comment' : 'posts or comments'} you have written or approved.`;

  if (unattended > 0) {
    return `Autopilot paused — ${unattended} of your ${unattended + pasted + (short > 0 ? 0 : 0)} `
      + `saved ${unattended === 1 ? 'item was' : 'items were'} sent unattended and cannot be `
      + `quoted as yours. ${need}`;
  }
  if (pasted > 0) {
    return `Autopilot needs more of your own writing to work from. Pasted notes and links `
      + `shape the writing style but cannot be quoted as yours. ${need}`;
  }
  return `Autopilot needs more of your own writing to work from. ${need}`;
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

  // Material we hold but cannot cite because nobody read it before it went
  // out. Counting it is what lets the message explain a lost unlock instead of
  // just showing a smaller number.
  const unattended = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM documents
          WHERE account_id = ? AND trust = 'voice' AND source = 'note'`,
      )
      .get(accountId) as { n: number }
  ).n;

  const ready = evidence >= LIMITS.AUTOPILOT_MIN_EVIDENCE_DOCS;
  const short = LIMITS.AUTOPILOT_MIN_EVIDENCE_DOCS - evidence;

  return {
    evidenceDocuments: evidence,
    voiceDocuments: voice,
    groundedDraftRate: withGaps === 0 ? null : grounded / withGaps,
    fills,
    autopilotReady: ready,
    unattendedDocuments: unattended,
    blockedBy: ready
      ? null
      : blockedMessage(short, unattended, voice - unattended),
  };
}
