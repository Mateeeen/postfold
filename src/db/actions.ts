/**
 * Reads and state transitions for the `actions` table.
 *
 * There is deliberately no insert here. Inserting an action is
 * scheduler.enqueue()'s exclusive job — see invariant 3 in CLAUDE.md — and
 * putting an `insertAction` helper in a shared repo module is exactly how that
 * invariant gets quietly broken six months from now.
 */

import type { Db } from './index.js';
import { decodeJson, fromIso, fromIsoRequired, getDb, nowIso } from './index.js';
import type {
  Action,
  ActionKind,
  ActionPayload,
  ActionStatus,
  FailureClass,
} from '../types.js';

export interface ActionRow {
  id: string;
  account_id: string;
  kind: string;
  status: string;
  payload: string;
  scheduled_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  attempts: number;
  last_error: string | null;
  last_failure_class: string | null;
  dedupe_key: string;
  created_at: string;
}

export function mapAction(row: ActionRow): Action {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind as ActionKind,
    status: row.status as ActionStatus,
    payload: decodeJson<ActionPayload>(row.payload, {
      kind: 'create_post',
      postId: '',
      text: '',
    } as ActionPayload),
    scheduledAt: fromIsoRequired(row.scheduled_at),
    claimedAt: fromIso(row.claimed_at),
    completedAt: fromIso(row.completed_at),
    attempts: row.attempts,
    lastError: row.last_error,
    lastFailureClass: row.last_failure_class as FailureClass | null,
    dedupeKey: row.dedupe_key,
    createdAt: fromIsoRequired(row.created_at),
  };
}

export const ACTION_COLUMNS = `id, account_id, kind, status, payload, scheduled_at,
  claimed_at, completed_at, attempts, last_error, last_failure_class, dedupe_key, created_at`;

export async function getAction(id: string, db: Db = getDb()): Promise<Action | null> {
  const row = db
    .prepare(`SELECT ${ACTION_COLUMNS} FROM actions WHERE id = ?`)
    .get(id) as ActionRow | undefined;
  return row ? mapAction(row) : null;
}

export async function listPendingActions(
  accountId: string,
  db: Db = getDb(),
): Promise<Action[]> {
  const rows = db
    .prepare(
      `SELECT ${ACTION_COLUMNS} FROM actions
        WHERE account_id = ? AND status IN ('pending','in_flight')
        ORDER BY scheduled_at ASC`,
    )
    .all(accountId) as ActionRow[];
  return rows.map(mapAction);
}

export async function listRecentActions(
  accountId: string,
  limit = 25,
  db: Db = getDb(),
): Promise<Action[]> {
  const rows = db
    .prepare(
      `SELECT ${ACTION_COLUMNS} FROM actions
        WHERE account_id = ? AND status IN ('done','failed','cancelled')
        ORDER BY COALESCE(completed_at, created_at) DESC
        LIMIT ?`,
    )
    .all(accountId, limit) as ActionRow[];
  return rows.map(mapAction);
}

/** The next scheduled send, used by the UI header strip. */
export async function nextScheduledAt(
  accountId: string,
  kind: ActionKind | null = null,
  db: Db = getDb(),
): Promise<Date | null> {
  const row = (
    kind
      ? db
          .prepare(
            `SELECT MAX(scheduled_at) AS at FROM actions
              WHERE account_id = ? AND kind = ? AND status = 'pending'`,
          )
          .get(accountId, kind)
      : db
          .prepare(
            `SELECT MAX(scheduled_at) AS at FROM actions
              WHERE account_id = ? AND status = 'pending'`,
          )
          .get(accountId)
  ) as { at: string | null };
  return fromIso(row.at);
}

/** Earliest pending slot — what the user actually sees as "next send". */
export async function soonestScheduledAt(
  accountId: string,
  db: Db = getDb(),
): Promise<Date | null> {
  const row = db
    .prepare(
      `SELECT MIN(scheduled_at) AS at FROM actions
        WHERE account_id = ? AND status = 'pending'`,
    )
    .get(accountId) as { at: string | null };
  return fromIso(row.at);
}

/** When this account last finished an action of the given kind. */
export async function lastCompletedAt(
  accountId: string,
  kind: ActionKind,
  db: Db = getDb(),
): Promise<Date | null> {
  const row = db
    .prepare(
      `SELECT MAX(completed_at) AS at FROM actions
        WHERE account_id = ? AND kind = ? AND status = 'done'`,
    )
    .get(accountId, kind) as { at: string | null };
  return fromIso(row.at);
}

export interface LastActionSummary {
  at: Date;
  result: Record<string, unknown> | null;
}

/** The most recent completed action of a kind, with whatever it recorded. */
export async function lastResult(
  accountId: string,
  kind: ActionKind,
  db: Db = getDb(),
): Promise<LastActionSummary | null> {
  const row = db
    .prepare(
      `SELECT completed_at, result FROM actions
        WHERE account_id = ? AND kind = ? AND status = 'done'
        ORDER BY completed_at DESC LIMIT 1`,
    )
    .get(accountId, kind) as { completed_at: string; result: string | null } | undefined;
  if (!row) return null;
  const at = fromIso(row.completed_at);
  if (!at) return null;
  return { at, result: decodeJson<Record<string, unknown> | null>(row.result, null) };
}

/** Cancel a pending action. Only pending actions may be cancelled; an
 *  in-flight one is already at the provider and cancelling it here would lie. */
export async function cancelAction(
  id: string,
  db: Db = getDb(),
): Promise<boolean> {
  const info = db
    .prepare(
      `UPDATE actions
          SET status = 'cancelled', completed_at = @now, updated_at = @now
        WHERE id = @id AND status = 'pending'`,
    )
    .run({ id, now: nowIso() });
  return info.changes > 0;
}

export async function markDone(id: string, db: Db = getDb()): Promise<void> {
  db.prepare(
    `UPDATE actions
        SET status = 'done', completed_at = @now, updated_at = @now, last_error = NULL
      WHERE id = @id`,
  ).run({ id, now: nowIso() });
}

export async function markFailed(
  id: string,
  failureClass: FailureClass,
  error: string,
  db: Db = getDb(),
): Promise<void> {
  db.prepare(
    `UPDATE actions
        SET status = 'failed', completed_at = @now, updated_at = @now,
            last_error = @error, last_failure_class = @failureClass
      WHERE id = @id`,
  ).run({ id, now: nowIso(), error, failureClass });
}

/**
 * Push a failed attempt back onto the queue.
 *
 * Postgres had `now() + ($2 || ' milliseconds')::interval`. SQLite has no
 * clean equivalent for a millisecond interval, so the caller computes the
 * timestamp in JavaScript and binds it as an ISO string.
 */
export async function rescheduleAction(
  id: string,
  retryAt: Date,
  failureClass: FailureClass,
  error: string,
  db: Db = getDb(),
): Promise<void> {
  db.prepare(
    `UPDATE actions
        SET status = 'pending', claimed_at = NULL, scheduled_at = @retryAt,
            last_error = @error, last_failure_class = @failureClass, updated_at = @now
      WHERE id = @id`,
  ).run({
    id,
    retryAt: retryAt.toISOString(),
    error,
    failureClass,
    now: nowIso(),
  });
}
