/**
 * The only way work enters the `actions` table.
 *
 * Every caller — routes, the engager pipeline, webhooks, scripts — goes
 * through enqueue(). Routes never INSERT. This is invariant 3, and it exists
 * because the budget check and the insert have to be one atomic decision: if
 * a route could insert directly, "how many invites are promised for today"
 * stops being knowable and the account's daily cap becomes advisory.
 *
 * Budget decisions themselves are not made here. They are made in policy.ts;
 * this file supplies it with counters and obeys the answer.
 */

import { getAccount, getUsage } from '../db/accounts.js';
import { ACTION_COLUMNS, mapAction } from '../db/actions.js';
import type { ActionRow } from '../db/actions.js';
import type { Db } from '../db/index.js';
import { encodeJson, getDb, immediateTransaction, newId, nowIso } from '../db/index.js';
import { budget, LIMITS, nextSlot, soonSlot } from '../policy.js';
import type { BudgetResult } from '../policy.js';
import type { Action, ActionPayload } from '../types.js';

export interface EnqueueInput {
  accountId: string;
  /** Carries its own `kind` — one object, no chance of them disagreeing. */
  payload: ActionPayload;
  /**
   * Natural key for this unit of work, e.g. `invite:<suggestionId>`. Two calls
   * with the same key produce one action, forever.
   */
  dedupeKey: string;
  now?: Date;
  /**
   * 'paced' spreads the action across the account's send window (the default,
   * and what everything machine-initiated uses). 'soon' runs it a few minutes
   * from now regardless of the hour — only for things the user just approved.
   */
  urgency?: 'paced' | 'soon';
  /** Injectable for deterministic tests. */
  random?: () => number;
}

export type EnqueueResult =
  /** `budget` is null when the call was a no-op duplicate: no budget was spent
   *  and none was evaluated. */
  | { ok: true; action: Action; created: boolean; budget: BudgetResult | null }
  | { ok: false; reason: string; budget: BudgetResult | null };

function findByDedupeKey(db: Db, dedupeKey: string): Action | null {
  const row = db
    .prepare(`SELECT ${ACTION_COLUMNS} FROM actions WHERE dedupe_key = ?`)
    .get(dedupeKey) as ActionRow | undefined;
  return row ? mapAction(row) : null;
}

/**
 * Schedule one action, if the account's budget allows it.
 *
 * On refusal the `reason` is user-facing text straight from policy.ts. Routes
 * return it as a 409 body verbatim — do not reword it here, and do not turn it
 * into a code. The whole point is that the user reads why their account is
 * being held back.
 */
export async function enqueue(
  input: EnqueueInput,
  db: Db = getDb(),
): Promise<EnqueueResult> {
  const now = input.now ?? new Date();

  const existing = findByDedupeKey(db, input.dedupeKey);
  if (existing && (existing.status === 'pending' || existing.status === 'in_flight' ||
      existing.status === 'done')) {
    // Idempotent: a duplicate approve, a retried request, a double-click.
    // Costs no budget and creates nothing.
    return { ok: true, action: existing, created: false, budget: null };
  }

  if (existing) {
    // The previous attempt is terminal (cancelled, or failed for good). Retire
    // its dedupe key so a fresh attempt can take it — otherwise the UNIQUE
    // constraint makes one failure block that work forever, and the caller
    // gets the old failed action handed back as though it had just been
    // queued, complete with a scheduled time in the past.
    db.prepare('UPDATE actions SET dedupe_key = ? WHERE id = ?').run(
      `${existing.dedupeKey}:retired:${existing.id}`,
      existing.id,
    );
  }

  const account = await getAccount(input.accountId, db);
  if (!account) {
    return { ok: false, reason: 'That account no longer exists.', budget: null };
  }

  const kind = input.payload.kind;
  const usage = await getUsage(input.accountId, kind, db);

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
    usesNote:
      input.payload.kind === 'send_invite'
        ? input.payload.note.trim().length > 0
        : true,
  });

  if (!decision.allowed) {
    return { ok: false, reason: decision.reason ?? 'Not allowed right now.', budget: decision };
  }

  // Spacing is computed across ALL pending actions for the account, not just
  // this kind: per-account concurrency is 1, so a post and an invite must not
  // be scheduled on top of each other.
  //
  // For a 'soon' action the anchor is restricted to work that is actually
  // imminent. Otherwise a single paced action sitting in tomorrow's window
  // drags every manual approval behind it — two sends sixteen hours apart are
  // not a burst, and the gap rule exists to stop bursts.
  const horizon =
    input.urgency === 'soon'
      ? new Date(now.getTime() + LIMITS.MANUAL_CHAIN_HORIZON_MS).toISOString()
      : null;

  const lastRow = (
    horizon
      ? db
          .prepare(
            `SELECT MAX(scheduled_at) AS at FROM actions
              WHERE account_id = ? AND status IN ('pending','in_flight')
                AND scheduled_at <= ?`,
          )
          .get(input.accountId, horizon)
      : db
          .prepare(
            `SELECT MAX(scheduled_at) AS at FROM actions
              WHERE account_id = ? AND status IN ('pending','in_flight')`,
          )
          .get(input.accountId)
  ) as { at: string | null };
  const lastScheduledAt = lastRow.at ? new Date(lastRow.at) : null;

  const scheduledAt =
    input.urgency === 'soon'
      ? soonSlot({ now, lastScheduledAt, random: input.random ?? Math.random })
      : nextSlot({
          now,
          window: {
            timezone: account.timezone,
            sendDays: account.sendDays,
            startHour: account.windowStartHour,
            endHour: account.windowEndHour,
          },
          budget: decision.cap,
          lastScheduledAt,
          random: input.random ?? Math.random,
        });

  const id = newId();
  const inserted = immediateTransaction(db, () => {
    const info = db
      .prepare(
        `INSERT INTO actions (
           id, account_id, kind, status, payload, scheduled_at, attempts,
           dedupe_key, created_at, updated_at
         ) VALUES (
           @id, @accountId, @kind, 'pending', @payload, @scheduledAt, 0,
           @dedupeKey, @now, @now
         )
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .run({
        id,
        accountId: input.accountId,
        kind,
        payload: encodeJson(input.payload),
        scheduledAt: scheduledAt.toISOString(),
        dedupeKey: input.dedupeKey,
        now: nowIso(),
      });
    return info.changes > 0;
  });

  const action = findByDedupeKey(db, input.dedupeKey);
  if (!action) {
    return { ok: false, reason: 'Could not queue that action. Try again.', budget: decision };
  }
  return { ok: true, action, created: inserted, budget: decision };
}

/**
 * Read-only view of the same decision, for the UI header strip. Routes use
 * this to grey out approve buttons; enqueue() remains the authority.
 */
export async function currentBudget(
  accountId: string,
  kind: ActionPayload['kind'],
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<{ budget: BudgetResult; acceptanceSample: number } | null> {
  const account = await getAccount(accountId, db);
  if (!account) return null;
  const usage = await getUsage(accountId, kind, db);
  return {
    budget: budget({
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
    }),
    acceptanceSample: usage.acceptanceSample,
  };
}
