/**
 * The account state the UI needs in one shape: warm-up day, effective caps,
 * acceptance rate and its band, paused reason, next scheduled send.
 *
 * Composed from policy.ts and the DB counters. Routes read it; they never
 * recompute any part of it, because a cap computed in two places is a cap that
 * will eventually disagree with itself.
 */

import { getAcceptance, getAccount, getUsage } from './db/accounts.js';
import { soonestScheduledAt } from './db/actions.js';
import type { Db } from './db/index.js';
import { getDb } from './db/index.js';
import { acceptanceBand, budget, noteAllowance, warmupDay } from './policy.js';
import type { BudgetResult } from './policy.js';
import type { AcceptanceBand, Account, ActionKind } from './types.js';

export interface CapView {
  cap: number;
  remaining: number;
  allowed: boolean;
  reason: string | null;
}

export interface AccountState {
  id: string;
  displayName: string;
  status: Account['status'];
  sendingEnabled: boolean;
  /** Why sending is held, if it is. Shown to the user verbatim. */
  pausedReason: string | null;
  timezone: string;
  sendDays: number[];
  windowStartHour: number;
  windowEndHour: number;
  warmupDay: number;
  warmupCap: number;
  caps: Record<ActionKind, CapView>;
  acceptance: {
    rate: number | null;
    accepted: number;
    sample: number;
    band: AcceptanceBand;
    /** False until there are enough settled invites to draw a conclusion. */
    rated: boolean;
  };
  /** Paid tier, or null when we could not determine it. */
  isPremium: boolean | null;
  /**
   * Note-bearing invitations left this month. At zero, invites still send —
   * without a note, which has a far higher ceiling.
   */
  notesRemaining: number;
  noteAllowance: number;
  nextScheduledAt: string | null;
  checkpointUntil: string | null;
}

const KINDS: ActionKind[] = [
  'send_invite',
  'create_post',
  'sync_engagers',
  'post_comment',
  'sync_trends',
  'sync_replies',
  'poll_acceptance',
];

function toView(b: BudgetResult): CapView {
  return { cap: b.cap, remaining: b.remaining, allowed: b.allowed, reason: b.reason };
}

export async function getAccountState(
  accountId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<AccountState | null> {
  const account = await getAccount(accountId, db);
  if (!account) return null;

  const acceptance = await getAcceptance(accountId, db);
  const band = acceptanceBand(acceptance.rate, acceptance.sample);

  const caps = {} as Record<ActionKind, CapView>;
  let warmupCapValue = 0;
  let notesRemaining = 0;

  for (const kind of KINDS) {
    const usage = await getUsage(accountId, kind, db);
    const decision = budget({
      kind,
      now,
      status: account.status,
      sendingEnabled: account.sendingEnabled,
      pausedReason: account.pausedReason,
      checkpointUntil: account.checkpointUntil,
      connectedAt: account.connectedAt,
      sentLast24h: usage.sentLast24h,
      sentLast7d: usage.sentLast7d,
      pendingSameKind: usage.pendingSameKind,
      acceptanceRate: usage.acceptanceRate,
      acceptanceSample: usage.acceptanceSample,
      dailyCapOverride: account.dailyCapOverride,
      isPremium: account.isPremium,
      invitesWithNoteLast30d: usage.invitesWithNoteLast30d,
    });
    caps[kind] = toView(decision);
    if (kind === 'send_invite') {
      warmupCapValue = decision.warmupCap;
      notesRemaining = decision.notesRemaining;
    }
  }

  const next = await soonestScheduledAt(accountId, db);

  return {
    id: account.id,
    displayName: account.displayName,
    status: account.status,
    sendingEnabled: account.sendingEnabled,
    pausedReason: account.pausedReason,
    timezone: account.timezone,
    sendDays: account.sendDays,
    windowStartHour: account.windowStartHour,
    windowEndHour: account.windowEndHour,
    warmupDay: warmupDay(account.connectedAt, now),
    warmupCap: warmupCapValue,
    caps,
    acceptance: {
      rate: acceptance.rate,
      accepted: acceptance.accepted,
      sample: acceptance.sample,
      band: band.band,
      rated: band.band !== 'unrated',
    },
    isPremium: account.isPremium,
    notesRemaining,
    noteAllowance: noteAllowance(account.isPremium),
    nextScheduledAt: next ? next.toISOString() : null,
    checkpointUntil: account.checkpointUntil ? account.checkpointUntil.toISOString() : null,
  };
}
