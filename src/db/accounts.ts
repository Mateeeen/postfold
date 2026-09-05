/**
 * Account reads/writes, plus the counters policy.budget() needs.
 *
 * Signatures are async; bodies are synchronous better-sqlite3 calls.
 */

import type { Db } from './index.js';
import {
  boolToInt,
  decodeJson,
  encodeJson,
  fromIso,
  fromIsoRequired,
  getDb,
  intToBool,
  newId,
  nowIso,
} from './index.js';
import { LIMITS } from '../policy.js';
import type { Account, AccountStatus, ActionKind } from '../types.js';

export interface AccountRow {
  id: string;
  user_id: string;
  provider_account_id: string;
  display_name: string;
  status: string;
  sending_enabled: number;
  paused_reason: string | null;
  connected_at: string;
  timezone: string;
  send_days: string;
  window_start_hour: number;
  window_end_hour: number;
  daily_cap_override: string | null;
  checkpoint_until: string | null;
  owner_person_id: string | null;
  is_premium: number | null;
  headline: string | null;
}

export function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    userId: row.user_id,
    providerAccountId: row.provider_account_id,
    displayName: row.display_name,
    status: row.status as AccountStatus,
    sendingEnabled: intToBool(row.sending_enabled),
    pausedReason: row.paused_reason,
    connectedAt: fromIsoRequired(row.connected_at),
    timezone: row.timezone,
    sendDays: decodeJson<number[]>(row.send_days, [...LIMITS.DEFAULT_SEND_DAYS]),
    windowStartHour: row.window_start_hour,
    windowEndHour: row.window_end_hour,
    dailyCapOverride: decodeJson<Partial<Record<ActionKind, number>> | null>(
      row.daily_cap_override,
      null,
    ),
    checkpointUntil: fromIso(row.checkpoint_until),
    ownerPersonId: row.owner_person_id,
    isPremium: row.is_premium === null ? null : row.is_premium === 1,
    headline: row.headline,
  };
}

const SELECT = `SELECT id, user_id, provider_account_id, display_name, status,
  sending_enabled, paused_reason, connected_at, timezone, send_days,
  window_start_hour, window_end_hour, daily_cap_override, checkpoint_until,
  owner_person_id, is_premium, headline
  FROM accounts`;

export async function getAccount(id: string, db: Db = getDb()): Promise<Account | null> {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as AccountRow | undefined;
  return row ? mapAccount(row) : null;
}

export async function listAccounts(userId: string, db: Db = getDb()): Promise<Account[]> {
  const rows = db
    .prepare(`${SELECT} WHERE user_id = ? ORDER BY created_at ASC`)
    .all(userId) as AccountRow[];
  return rows.map(mapAccount);
}

export interface CreateAccountInput {
  userId: string;
  providerAccountId: string;
  displayName: string;
  connectedAt?: Date;
  timezone?: string;
  sendDays?: number[];
  windowStartHour?: number;
  windowEndHour?: number;
}

export async function createAccount(
  input: CreateAccountInput,
  db: Db = getDb(),
): Promise<Account> {
  const id = newId();
  db.prepare(
    `INSERT INTO accounts (
       id, user_id, provider_account_id, display_name, status, sending_enabled,
       connected_at, timezone, send_days, window_start_hour, window_end_hour,
       created_at, updated_at
     ) VALUES (
       @id, @userId, @providerAccountId, @displayName, 'active', 1,
       @connectedAt, @timezone, @sendDays, @windowStartHour, @windowEndHour,
       @now, @now
     )
     ON CONFLICT (provider_account_id) DO NOTHING`,
  ).run({
    id,
    userId: input.userId,
    providerAccountId: input.providerAccountId,
    displayName: input.displayName,
    connectedAt: (input.connectedAt ?? new Date()).toISOString(),
    timezone: input.timezone ?? 'UTC',
    sendDays: JSON.stringify(input.sendDays ?? [...LIMITS.DEFAULT_SEND_DAYS]),
    windowStartHour: input.windowStartHour ?? LIMITS.DEFAULT_WINDOW_START_HOUR,
    windowEndHour: input.windowEndHour ?? LIMITS.DEFAULT_WINDOW_END_HOUR,
    now: nowIso(),
  });

  const row = db
    .prepare(`${SELECT} WHERE provider_account_id = ?`)
    .get(input.providerAccountId) as AccountRow | undefined;
  if (!row) throw new Error('createAccount: insert did not produce a row');
  return mapAccount(row);
}

export interface AccountPatch {
  status?: AccountStatus;
  sendingEnabled?: boolean;
  pausedReason?: string | null;
  checkpointUntil?: Date | null;
  dailyCapOverride?: Partial<Record<ActionKind, number>> | null;
  ownerPersonId?: string | null;
  isPremium?: boolean | null;
  headline?: string | null;
}

export async function updateAccount(
  id: string,
  patch: AccountPatch,
  db: Db = getDb(),
): Promise<void> {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, now: nowIso() };

  if (patch.status !== undefined) {
    sets.push('status = @status');
    params['status'] = patch.status;
  }
  if (patch.sendingEnabled !== undefined) {
    sets.push('sending_enabled = @sendingEnabled');
    params['sendingEnabled'] = boolToInt(patch.sendingEnabled);
  }
  if (patch.pausedReason !== undefined) {
    sets.push('paused_reason = @pausedReason');
    params['pausedReason'] = patch.pausedReason;
  }
  if (patch.checkpointUntil !== undefined) {
    sets.push('checkpoint_until = @checkpointUntil');
    params['checkpointUntil'] = patch.checkpointUntil
      ? patch.checkpointUntil.toISOString()
      : null;
  }
  if (patch.dailyCapOverride !== undefined) {
    sets.push('daily_cap_override = @dailyCapOverride');
    params['dailyCapOverride'] = encodeJson(patch.dailyCapOverride);
  }
  if (patch.ownerPersonId !== undefined) {
    sets.push('owner_person_id = @ownerPersonId');
    params['ownerPersonId'] = patch.ownerPersonId;
  }
  if (patch.isPremium !== undefined) {
    sets.push('is_premium = @isPremium');
    params['isPremium'] = patch.isPremium === null ? null : patch.isPremium ? 1 : 0;
  }
  if (patch.headline !== undefined) {
    sets.push('headline = @headline');
    params['headline'] = patch.headline;
  }
  if (sets.length === 0) return;

  sets.push('updated_at = @now');
  db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

/* --- Counters for policy.budget() -------------------------------------- */

export interface AccountUsage {
  sentLast24h: number;
  sentLast7d: number;
  pendingSameKind: number;
  acceptanceRate: number | null;
  acceptanceSample: number;
  /** Note-bearing invites in the trailing 30 days — the free-tier ceiling. */
  invitesWithNoteLast30d: number;
}

/**
 * `datetime('now','-24 hours')` — Postgres was `now() - interval '24 hours'`.
 * The comparison works because every timestamp column holds ISO-8601 UTC and
 * datetime() emits the same field order; do not mix epoch integers in here.
 */
export async function getUsage(
  accountId: string,
  kind: ActionKind,
  db: Db = getDb(),
): Promise<AccountUsage> {
  const done = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE completed_at >= datetime('now','-24 hours')) AS d1,
         COUNT(*) FILTER (WHERE completed_at >= datetime('now','-7 days'))  AS d7
       FROM actions
       WHERE account_id = ? AND kind = ? AND status = 'done'`,
    )
    .get(accountId, kind) as { d1: number; d7: number };

  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM actions
        WHERE account_id = ? AND kind = ? AND status IN ('pending','in_flight')`,
    )
    .get(accountId, kind) as { n: number };

  const acceptance = await getAcceptance(accountId, db);

  const withNote = db
    .prepare(
      `SELECT COUNT(*) AS n FROM invites
        WHERE account_id = ? AND with_note = 1
          AND sent_at >= datetime('now','-30 days')`,
    )
    .get(accountId) as { n: number };

  return {
    sentLast24h: done.d1,
    sentLast7d: done.d7,
    pendingSameKind: pending.n,
    acceptanceRate: acceptance.rate,
    acceptanceSample: acceptance.sample,
    invitesWithNoteLast30d: withNote.n,
  };
}

export interface Acceptance {
  rate: number | null;
  sample: number;
  accepted: number;
}

export async function getAcceptance(
  accountId: string,
  db: Db = getDb(),
): Promise<Acceptance> {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS sample,
         COUNT(*) FILTER (WHERE status = 'accepted') AS accepted
       FROM invites
       WHERE account_id = ?
         AND sent_at >= datetime('now', ?)`,
    )
    .get(accountId, `-${LIMITS.ACCEPTANCE_LOOKBACK_DAYS} days`) as {
    sample: number;
    accepted: number;
  };

  return {
    sample: row.sample,
    accepted: row.accepted,
    rate: row.sample === 0 ? null : row.accepted / row.sample,
  };
}
