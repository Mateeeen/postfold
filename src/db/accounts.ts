/**
 * Account reads/writes, plus the counters policy.budget() needs.
 *
 * Signatures are async; bodies are synchronous better-sqlite3 calls.
 */

import { DEFAULT_AUTOMATION_MODES } from '../types.js';
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
import type { Account, AccountStatus, ActionKind, AutomationModes } from '../types.js';

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
  automation_modes: string;
  avatar_url: string | null;
  public_identifier: string | null;
  location: string | null;
  follower_count: number | null;
  connections_count: number | null;
  impressions_7d: number | null;
  posts_7d: number | null;
  stats_updated_at: string | null;
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
    automationModes: {
      ...DEFAULT_AUTOMATION_MODES,
      ...decodeJson<Partial<AutomationModes>>(row.automation_modes, {}),
    },
    avatarUrl: row.avatar_url,
    publicIdentifier: row.public_identifier,
    location: row.location,
    followerCount: row.follower_count,
    connectionsCount: row.connections_count,
    impressions7d: row.impressions_7d,
    posts7d: row.posts_7d,
    statsUpdatedAt: fromIso(row.stats_updated_at),
  };
}

const SELECT = `SELECT id, user_id, provider_account_id, display_name, status,
  sending_enabled, paused_reason, connected_at, timezone, send_days,
  window_start_hour, window_end_hour, daily_cap_override, checkpoint_until,
  owner_person_id, is_premium, headline, automation_modes, avatar_url,
  public_identifier, location,
  follower_count, connections_count, impressions_7d, posts_7d, stats_updated_at
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
  automationModes?: AutomationModes;
  /** Settings a person can change. Window hours are local to `timezone`. */
  timezone?: string;
  sendDays?: number[];
  windowStartHour?: number;
  windowEndHour?: number;
  /** Repointing at a new provider tenant. See the reconnect route. */
  providerAccountId?: string;
  displayName?: string;
  avatarUrl?: string | null;
  publicIdentifier?: string | null;
  location?: string | null;
  followerCount?: number | null;
  connectionsCount?: number | null;
  impressions7d?: number | null;
  posts7d?: number | null;
  statsUpdatedAt?: Date | null;
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
  if (patch.providerAccountId !== undefined) {
    sets.push('provider_account_id = @providerAccountId');
    params['providerAccountId'] = patch.providerAccountId;
  }
  if (patch.displayName !== undefined) {
    sets.push('display_name = @displayName');
    params['displayName'] = patch.displayName;
  }
  if (patch.timezone !== undefined) {
    sets.push('timezone = @timezone');
    params['timezone'] = patch.timezone;
  }
  if (patch.sendDays !== undefined) {
    sets.push('send_days = @sendDays');
    params['sendDays'] = encodeJson(patch.sendDays);
  }
  if (patch.windowStartHour !== undefined) {
    sets.push('window_start_hour = @windowStartHour');
    params['windowStartHour'] = patch.windowStartHour;
  }
  if (patch.windowEndHour !== undefined) {
    sets.push('window_end_hour = @windowEndHour');
    params['windowEndHour'] = patch.windowEndHour;
  }
  if (patch.automationModes !== undefined) {
    sets.push('automation_modes = @automationModes');
    params['automationModes'] = encodeJson(patch.automationModes);
  }
  if (patch.avatarUrl !== undefined) {
    sets.push('avatar_url = @avatarUrl');
    params['avatarUrl'] = patch.avatarUrl;
  }
  if (patch.publicIdentifier !== undefined) {
    sets.push('public_identifier = @publicIdentifier');
    params['publicIdentifier'] = patch.publicIdentifier;
  }
  if (patch.followerCount !== undefined) {
    sets.push('follower_count = @followerCount');
    params['followerCount'] = patch.followerCount;
  }
  if (patch.connectionsCount !== undefined) {
    sets.push('connections_count = @connectionsCount');
    params['connectionsCount'] = patch.connectionsCount;
  }
  if (patch.impressions7d !== undefined) {
    sets.push('impressions_7d = @impressions7d');
    params['impressions7d'] = patch.impressions7d;
  }
  if (patch.posts7d !== undefined) {
    sets.push('posts_7d = @posts7d');
    params['posts7d'] = patch.posts7d;
  }
  if (patch.statsUpdatedAt !== undefined) {
    sets.push('stats_updated_at = @statsUpdatedAt');
    params['statsUpdatedAt'] = patch.statsUpdatedAt ? patch.statsUpdatedAt.toISOString() : null;
  }
  if (patch.location !== undefined) {
    sets.push('location = @location');
    params['location'] = patch.location;
  }
  if (sets.length === 0) return;

  sets.push('updated_at = @now');
  db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

/**
 * Record how many note-bearing invites were sent before this instance existed.
 *
 * Counted alongside real invites when the note allowance is computed. Stored
 * as a number on the account rather than as invite rows, because `invites`
 * feeds the acceptance rate and must contain only invites we actually sent.
 */
export async function backfillNoteUsage(
  accountId: string,
  count: number,
  db: Db = getDb(),
): Promise<number> {
  db.prepare('UPDATE accounts SET note_backfill = ?, updated_at = ? WHERE id = ?').run(
    count,
    nowIso(),
    accountId,
  );
  return count;
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
  /** Invites awaiting an answer. Its own stop, separate from the rate. */
  pendingInvites: number;
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
  const pending2 = db
    .prepare(`SELECT COUNT(*) AS n FROM invites WHERE account_id = ? AND status = 'sent'`)
    .get(accountId) as { n: number };

  const withNote = db
    .prepare(
      `SELECT COUNT(*) AS n FROM invites
        WHERE account_id = ? AND with_note = 1
          AND sent_at >= datetime('now','-30 days')`,
    )
    .get(accountId) as { n: number };

  // Invites this instance never saw still count against the platform's limit.
  const backfill = db
    .prepare('SELECT note_backfill AS n FROM accounts WHERE id = ?')
    .get(accountId) as { n: number } | undefined;

  return {
    sentLast24h: done.d1,
    sentLast7d: done.d7,
    pendingSameKind: pending.n,
    acceptanceRate: acceptance.rate,
    acceptanceSample: acceptance.sample,
    invitesWithNoteLast30d: withNote.n + (backfill?.n ?? 0),
    pendingInvites: pending2.n,
  };
}

export interface Acceptance {
  rate: number | null;
  sample: number;
  accepted: number;
}

/**
 * Invites still awaiting an answer.
 *
 * A large unanswered pile is its own negative signal, independent of how the
 * resolved ones landed - and it is invisible to the acceptance rate by
 * construction, since pending is excluded from that entirely.
 */
export async function pendingInviteCount(
  accountId: string,
  db: Db = getDb(),
): Promise<number> {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM invites WHERE account_id = ? AND status = 'sent'`)
    .get(accountId) as { n: number };
  return row.n;
}

export async function getAcceptance(
  accountId: string,
  db: Db = getDb(),
): Promise<Acceptance> {
  // RESOLVED only. An invite still sitting at 'sent' is undecided, not
  // refused, and counting it as a failure is how 40 fresh invites read as 0%
  // acceptance and hard-stop a perfectly healthy account. Withdrawn counts as
  // resolved-not-accepted: we asked, and the asking ended.
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS sample,
         COUNT(*) FILTER (WHERE status = 'accepted') AS accepted
       FROM invites
       WHERE account_id = ?
         AND status IN ('accepted', 'declined', 'expired', 'withdrawn')
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
