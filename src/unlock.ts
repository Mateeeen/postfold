/**
 * What autopilot has earned, per action type.
 *
 * Autopilot is earned rather than toggled, and each condition exists because
 * of something we cannot know until it is met: whether this person's drafts
 * are any good, whether the people they invite accept, whether the account is
 * old enough that a burst reads as activity rather than as arrival.
 *
 * Reasons here are display-ready and shown verbatim as a progress line. They
 * are phrased as a distance to travel — "2 more strong drafts" — because the
 * thing to communicate is that this is reachable, not that it is refused.
 *
 * Evidence-document count is deliberately NOT folded in. It has its own
 * message about pasted material not counting, and "your notes cannot be
 * quoted as yours" is a different thing to tell someone than "write two more
 * strong drafts". For posts it is enforced anyway, one layer down: a post
 * cannot be grounded without citable material.
 */

import { getAcceptance, getAccount } from './db/accounts.js';
import type { Db } from './db/index.js';
import { getDb } from './db/index.js';
import { acceptanceBand, ACCEPTANCE_BANDS, LIMITS, warmupDay } from './policy.js';
import { scoreComment, scorePost } from './quality.js';
import type { AutomatedKind } from './types.js';

export interface UnlockState {
  unlocked: boolean;
  /** Shown verbatim. Null when unlocked. */
  reason: string | null;
}

export type UnlockByKind = Record<AutomatedKind, UnlockState>;

const locked = (reason: string): UnlockState => ({ unlocked: false, reason });
const open: UnlockState = { unlocked: true, reason: null };

/** How many recent drafts read as strong. Scored now, not stored. */
function strongDrafts(accountId: string, db: Db): number {
  const rows = db
    .prepare(
      `SELECT d.kind, d.text, p.text AS parent
         FROM drafts d
         LEFT JOIN discovered_posts p ON p.id = d.discovered_post_id
        WHERE d.account_id = ?
        ORDER BY d.created_at DESC
        LIMIT 50`,
    )
    .all(accountId) as { kind: string; text: string; parent: string | null }[];

  let strong = 0;
  for (const r of rows) {
    const q =
      r.kind === 'comment' ? scoreComment(r.text, r.parent ?? '') : scorePost(r.text);
    if (q.band === 'strong') strong++;
  }
  return strong;
}

export async function autopilotUnlock(
  accountId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<UnlockByKind> {
  const account = await getAccount(accountId, db);
  // Withdrawal is always available: it removes an action rather than adding
  // one, and an invitation nobody answered is not made safer by waiting.
  if (!account) {
    return {
      post: locked('No account connected.'),
      comment: locked('No account connected.'),
      connect: locked('No account connected.'),
      withdraw: open,
    };
  }

  const day = warmupDay(account.connectedAt, now);
  const daysShort = LIMITS.AUTOPILOT_MIN_DAY - day;
  const tooNew =
    daysShort > 0
      ? locked(
          `Unlocks on day ${LIMITS.AUTOPILOT_MIN_DAY} — ${daysShort} more `
            + `${daysShort === 1 ? 'day' : 'days'}.`,
        )
      : null;

  /* --- Posts and comments: is the writing any good yet? ---------------- */

  const strong = strongDrafts(accountId, db);
  const draftsShort = LIMITS.AUTOPILOT_MIN_STRONG_DRAFTS - strong;
  const writing =
    tooNew ??
    (draftsShort > 0
      ? locked(
          `Unlocks after ${draftsShort} more strong `
            + `${draftsShort === 1 ? 'draft' : 'drafts'}.`,
        )
      : open);

  /* --- Invites: do the people being asked actually accept? ------------- */

  const acceptance = await getAcceptance(accountId, db);
  const resolvedShort = LIMITS.AUTOPILOT_MIN_RESOLVED_INVITES - acceptance.sample;
  const healthyAt = ACCEPTANCE_BANDS.find((b) => b.band === 'healthy')?.minRate ?? 0.4;

  let connect: UnlockState;
  if (tooNew) {
    connect = tooNew;
  } else if (resolvedShort > 0) {
    // Answered, not sent. A pile of pending invitations tells us nothing, and
    // saying "sent" here would invite someone to send more to unlock faster.
    connect = locked(
      `Unlocks after ${resolvedShort} more `
        + `${resolvedShort === 1 ? 'invitation is' : 'invitations are'} answered.`,
    );
  } else if (acceptanceBand(acceptance.rate, acceptance.sample).band !== 'healthy') {
    connect = locked(
      `Unlocks when acceptance is comfortably above ${Math.round(healthyAt * 100)}%.`,
    );
  } else {
    connect = open;
  }

  return { post: writing, comment: writing, connect, withdraw: open };
}
