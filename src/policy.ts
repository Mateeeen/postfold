/**
 * Account-safety policy. This is the file that keeps users from getting
 * restricted, and it is the only file in the codebase permitted to contain a
 * rate limit, a cap, an interval, or a backoff.
 *
 * Everything here is a pure function of its inputs. No DB, no clock reads
 * except the `now` you pass in, no randomness except the `random` you pass in.
 * That is deliberate: it is the only way the pacing is testable, and the
 * pacing is the part that, when wrong, ships account restrictions to users.
 *
 * Conservative by design. If you are reading this because a number feels low:
 * the numbers are low on purpose. Raising them is a product decision with a
 * blast radius measured in other people's LinkedIn accounts.
 */

import type {
  AcceptanceBand,
  AccountStatus,
  ActionKind,
  FailureClass,
} from './types.js';

/* ================================================================== *
 * 1. The numbers
 * ================================================================== */

export const LIMITS = {
  /** Absolute ceiling on invites/day. No warm-up day, override or band
   *  may exceed this. LinkedIn's own weekly guidance is the reason. */
  HARD_DAILY_INVITE_CAP: 25,
  /** Trailing 7-day ceiling, enforced alongside the daily cap. */
  WEEKLY_INVITE_CAP: 100,
  /**
   * Invitations WITH a note, per 30 days, on a free account.
   *
   * This is the platform's own limit, not ours, and it is brutal: attaching a
   * note to an invite on a free account costs roughly 30x the volume you could
   * otherwise send. We enforce it so the user finds out from us, with an
   * explanation, rather than from invites that quietly stop arriving.
   */
  FREE_WITH_NOTE_MONTHLY_CAP: 5,
  /** Invitations WITHOUT a note, per day, on a free account (~150/week). */
  FREE_NO_NOTE_DAILY_CAP: 20,
  /**
   * Note-bearing invitations per 30 days on a PAID account.
   *
   * Unlike the free figure above, this is OUR choice, not a documented
   * platform limit — the platform publishes no note restriction for premium.
   * It exists so notes stay a deliberate, rationed thing rather than the
   * default on every invite. Raise it freely; it protects taste, not the
   * account.
   */
  PREMIUM_WITH_NOTE_MONTHLY_CAP: 40,

  DAILY_POST_CAP: 3,
  DAILY_SYNC_CAP: 24,

  /** Absolute ceiling on comments/day. Commenting on strangers' posts is the
   *  most visible automated thing this product does — a burst of them is
   *  exactly what a spam classifier is built to catch. */
  HARD_DAILY_COMMENT_CAP: 20,
  /** Keyword searches per day. Read-only, so this is about not hammering the
   *  platform rather than about account safety. */
  DAILY_TREND_SYNC_CAP: 12,
  /** Reply pulls per day. Read-only. */
  DAILY_REPLY_SYNC_CAP: 12,
  /**
   * Acceptance polls per day.
   *
   * Deliberately small. Unipile's own guidance is to check "only a few times
   * by day with random delay, not at fixed time" — a poll that runs exactly on
   * the hour is itself an automation signal, which is why this rides the
   * normal jittered scheduler rather than a cron.
   */
  DAILY_ACCEPTANCE_POLL_CAP: 4,
  /** Shortest gap between acceptance polls. */
  ACCEPTANCE_POLL_INTERVAL_MS: 5 * 60 * 60 * 1000,
  /** Don't re-check the same invite more often than this. */
  INVITE_RECHECK_INTERVAL_MS: 6 * 60 * 60 * 1000,
  /** Stop checking an invite that has gone this long without being accepted. */
  INVITE_GIVE_UP_AFTER_MS: 21 * 24 * 60 * 60 * 1000,
  /** Platform limit on a comment. */
  MAX_COMMENT_CHARS: 1250,

  /**
   * How long an untouched draft waits before it publishes itself.
   *
   * This is the most dangerous number in the file: after this long, text
   * nobody read goes out under the user's name. A full day, so that "I was
   * busy yesterday" is not enough to trigger it — and it applies only to
   * drafts the user opted in for.
   */
  AUTO_APPROVE_AFTER_MS: 24 * 60 * 60 * 1000,

  /** Never two sends closer together than this, at any budget. */
  MIN_GAP_MINUTES: 8,
  /** Never spread so thin that a day's budget cannot fit in the window. */
  MAX_GAP_MINUTES: 90,
  /** Gaps are multiplied by 1 ± this. Human-ish, not metronomic. */
  JITTER_RATIO: 0.35,
  /** Nothing is ever scheduled sooner than this from `now`. */
  MIN_LEAD_MINUTES: 2,
  /**
   * Delay on something the user approved by hand.
   *
   * Deliberately short: an explicit approval is a decision the user just made
   * and expects to see happen. It is also a real relaxation of the safety
   * model — these actions ignore the send window, so an approval at 02:00
   * sends at 02:00. Daily caps and the minimum gap still apply.
   */
  MANUAL_APPROVAL_DELAY_MS: 5 * 60 * 1000,
  /**
   * How far ahead a manual approval looks when spacing itself.
   *
   * Pending work inside this window is treated as a burst risk and spaced
   * against; work beyond it (a paced action sitting in tomorrow's send window)
   * is ignored, so one queued post cannot drag every approval into tomorrow.
   * Four hours holds a chain of ~30 approvals at MIN_GAP_MINUTES, comfortably
   * more than any daily cap allows.
   */
  MANUAL_CHAIN_HORIZON_MS: 4 * 60 * 60 * 1000,
  /** Refuse to schedule into the last minutes of the window; a send that
   *  starts at 16:59 and retries lands outside it. */
  WINDOW_TAIL_GUARD_MINUTES: 5,

  /** Default working-hours window, local to the account's timezone. */
  DEFAULT_WINDOW_START_HOUR: 9,
  DEFAULT_WINDOW_END_HOUR: 17,
  /** Mon–Fri. 0 = Sunday. */
  DEFAULT_SEND_DAYS: [1, 2, 3, 4, 5] as readonly number[],

  /** Below this many settled invites we do not trust the acceptance rate. */
  ACCEPTANCE_MIN_SAMPLE: 20,
  ACCEPTANCE_LOOKBACK_DAYS: 14,

  MAX_ATTEMPTS: 5,
  BASE_BACKOFF_MS: 60_000,
  MAX_BACKOFF_MS: 6 * 60 * 60 * 1000,
  /** Cool the whole account after the platform tells us to slow down. */
  RATE_LIMIT_COOLDOWN_MS: 60 * 60 * 1000,
  /** A checkpoint is a human problem. Don't touch the account for a day. */
  CHECKPOINT_COOLDOWN_MS: 24 * 60 * 60 * 1000,

  /** Invariant 5. Not a tuning knob. */
  PER_ACCOUNT_CONCURRENCY: 1,

  /** Don't re-pull engagers for the same post more often than this. */
  ENGAGER_SYNC_MIN_INTERVAL_MS: 30 * 60 * 1000,
  /** Shortest gap between keyword searches. Short enough that the button feels
   *  responsive, long enough that mashing it does not burn the daily cap. */
  TREND_SYNC_MIN_INTERVAL_MS: 10 * 60 * 1000,

  /** Platform's own limit on connection-request notes. */
  MAX_NOTE_CHARS: 200,
  /** Where LinkedIn truncates a feed post with "…see more". */
  FOLD_CHAR_LIMIT: 210,
  FOLD_LINE_LIMIT: 3,
} as const;

/**
 * Warm-up ladder. A freshly connected account does not get to send 25 invites
 * on day one; that pattern is the single most reliable way to get flagged.
 * `throughDay` is inclusive and 1-based from `connectedAt`.
 */
export const WARMUP_LADDER: readonly { throughDay: number; cap: number }[] = [
  { throughDay: 3, cap: 5 },
  { throughDay: 7, cap: 10 },
  { throughDay: 14, cap: 15 },
  { throughDay: 21, cap: 20 },
  { throughDay: Number.POSITIVE_INFINITY, cap: 25 },
];

/**
 * Warm-up ladder for comments — separate from invites, and lower.
 *
 * A new account that immediately starts commenting on strangers' posts looks
 * exactly like the thing it would be. Same shape as WARMUP_LADDER; the caps
 * are smaller because the blast radius is other people's comment sections.
 */
export const COMMENT_WARMUP_LADDER: readonly { throughDay: number; cap: number }[] = [
  { throughDay: 3, cap: 3 },
  { throughDay: 7, cap: 6 },
  { throughDay: 14, cap: 10 },
  { throughDay: 21, cap: 15 },
  { throughDay: Number.POSITIVE_INFINITY, cap: 20 },
];

/**
 * How many note-bearing invitations this account gets per 30 days.
 *
 * Unknown tier is treated as free — the safe guess, since guessing premium
 * would blow through a real platform limit.
 */
export function noteAllowance(isPremium: boolean | null | undefined): number {
  return isPremium === true
    ? LIMITS.PREMIUM_WITH_NOTE_MONTHLY_CAP
    : LIMITS.FREE_WITH_NOTE_MONTHLY_CAP;
}

export function commentWarmupCap(day: number): number {
  for (const rung of COMMENT_WARMUP_LADDER) {
    if (day <= rung.throughDay) return rung.cap;
  }
  return LIMITS.HARD_DAILY_COMMENT_CAP;
}

/**
 * When a draft would publish itself, given when it was written. Pure, so the
 * UI can render the countdown without asking the server.
 */
export function autoApproveAt(draftedAt: Date): Date {
  return new Date(draftedAt.getTime() + LIMITS.AUTO_APPROVE_AFTER_MS);
}

/**
 * Acceptance-rate bands. A low acceptance rate is how the platform decides an
 * account is spamming, so it is also how we decide to slow ourselves down —
 * before the platform does it for us.
 */
export const ACCEPTANCE_BANDS: readonly {
  band: Exclude<AcceptanceBand, 'unrated'>;
  minRate: number;
  multiplier: number;
}[] = [
  { band: 'healthy', minRate: 0.4, multiplier: 1 },
  { band: 'watch', minRate: 0.25, multiplier: 0.6 },
  { band: 'throttled', minRate: 0.15, multiplier: 0.3 },
  { band: 'critical', minRate: 0, multiplier: 0 },
];

/* ================================================================== *
 * 2. Warm-up and acceptance
 * ================================================================== */

/** 1-based day number since the account connected. Day of connection is 1. */
export function warmupDay(connectedAt: Date, now: Date): number {
  const elapsedMs = now.getTime() - connectedAt.getTime();
  if (elapsedMs < 0) return 1;
  return Math.floor(elapsedMs / 86_400_000) + 1;
}

export function warmupCap(day: number): number {
  for (const rung of WARMUP_LADDER) {
    if (day <= rung.throughDay) return rung.cap;
  }
  return LIMITS.HARD_DAILY_INVITE_CAP;
}

/**
 * `rate` is accepted / settled over the lookback window. `sample` is the
 * number of settled invites behind it. Too small a sample and we refuse to
 * draw a conclusion in either direction — a new account with 2 sent and 0
 * accepted is not a spammer, it is new.
 */
export function acceptanceBand(
  rate: number | null,
  sample: number,
): { band: AcceptanceBand; multiplier: number } {
  if (rate === null || sample < LIMITS.ACCEPTANCE_MIN_SAMPLE) {
    return { band: 'unrated', multiplier: 1 };
  }
  for (const b of ACCEPTANCE_BANDS) {
    if (rate >= b.minRate) return { band: b.band, multiplier: b.multiplier };
  }
  return { band: 'critical', multiplier: 0 };
}

/* ================================================================== *
 * 3. Budget
 * ================================================================== */

export interface BudgetInput {
  kind: ActionKind;
  now: Date;
  status: AccountStatus;
  sendingEnabled: boolean;
  pausedReason: string | null;
  checkpointUntil: Date | null;
  connectedAt: Date;
  /** Invites sent in the trailing 24h. */
  sentLast24h: number;
  /** Invites sent in the trailing 7 days. */
  sentLast7d: number;
  /** Actions of this kind already queued and not yet executed. These count
   *  against the cap — otherwise a user approves 40 suggestions in a minute
   *  and the queue happily promises to send all of them. */
  pendingSameKind: number;
  acceptanceRate: number | null;
  acceptanceSample: number;
  dailyCapOverride: Partial<Record<ActionKind, number>> | null;
  /** Null means unknown; treated as free, because that is the safer guess. */
  isPremium?: boolean | null;
  /** Note-bearing invites sent in the trailing 30 days. */
  invitesWithNoteLast30d?: number;
  /** Whether the invite being considered carries a note. */
  usesNote?: boolean;
}

export interface BudgetResult {
  /** Effective cap for this kind, after warm-up, band and override. */
  cap: number;
  /** Cap minus everything already sent or promised. Never negative. */
  remaining: number;
  allowed: boolean;
  /** Verbatim user-facing text when `allowed` is false. Routes return this
   *  as the body of a 409 and the UI shows it unmodified. */
  reason: string | null;
  band: AcceptanceBand;
  warmupDay: number;
  warmupCap: number;
  multiplier: number;
  /**
   * Note-bearing invitations left this month. When this hits zero we do NOT
   * refuse the invite — we send it without a note, which is a far higher
   * ceiling. Callers must read this and strip the note themselves rather than
   * having it silently rewritten underneath them.
   */
  notesRemaining: number;
  /** False once the note allowance is spent. */
  noteAllowed: boolean;
}

function baseCapFor(kind: ActionKind, day: number): number {
  switch (kind) {
    case 'send_invite':
      return warmupCap(day);
    case 'create_post':
      return LIMITS.DAILY_POST_CAP;
    case 'sync_engagers':
      return LIMITS.DAILY_SYNC_CAP;
    case 'post_comment':
      return commentWarmupCap(day);
    case 'sync_trends':
      return LIMITS.DAILY_TREND_SYNC_CAP;
    case 'sync_replies':
      return LIMITS.DAILY_REPLY_SYNC_CAP;
    case 'poll_acceptance':
      return LIMITS.DAILY_ACCEPTANCE_POLL_CAP;
  }
}

/**
 * The single decision point for "may this account do one more of these right
 * now". scheduler.enqueue() is the only caller that matters; everything else
 * reads it to display state.
 */
export function budget(input: BudgetInput): BudgetResult {
  const day = warmupDay(input.connectedAt, input.now);
  const { band, multiplier } = acceptanceBand(
    input.acceptanceRate,
    input.acceptanceSample,
  );

  const isInvite = input.kind === 'send_invite';
  const isComment = input.kind === 'post_comment';
  const ladderCap = baseCapFor(input.kind, day);

  // The band throttles outbound social actions - invites and comments alike.
  // A low acceptance rate says the platform already reads this account as
  // spammy; commenting on at full rate is how that becomes a restriction.
  // Publishing your own post is not what gets an account flagged, so posts
  // and read-only syncs are exempt.
  const banded =
    isInvite || isComment ? Math.floor(ladderCap * multiplier) : ladderCap;

  const override = input.dailyCapOverride?.[input.kind];
  // An override may only lower a cap. It is a safety valve, not a bypass.
  const withOverride =
    typeof override === 'number' ? Math.min(banded, Math.max(0, override)) : banded;

  const cap = isInvite
    ? Math.min(withOverride, LIMITS.HARD_DAILY_INVITE_CAP)
    : isComment
      ? Math.min(withOverride, LIMITS.HARD_DAILY_COMMENT_CAP)
      : withOverride;

  const used = input.sentLast24h + input.pendingSameKind;
  const remaining = Math.max(0, cap - used);

  const notesUsed = (input.invitesWithNoteLast30d ?? 0) + (isInvite ? input.pendingSameKind : 0);
  const notesRemaining = Math.max(0, noteAllowance(input.isPremium) - notesUsed);

  const result = (allowed: boolean, reason: string | null): BudgetResult => ({
    cap,
    remaining,
    allowed,
    reason,
    band,
    warmupDay: day,
    warmupCap: ladderCap,
    multiplier: isInvite || isComment ? multiplier : 1,
    notesRemaining,
    noteAllowed: notesRemaining > 0,
  });

  // Order matters: the most serious reason wins, because the UI shows exactly
  // one and the user should see the one that requires their attention.
  if (input.status === 'restricted') {
    return result(
      false,
      'This account is restricted by the platform. PostFold will not send anything until you resolve it directly with LinkedIn.',
    );
  }
  if (input.status === 'disconnected') {
    return result(false, 'This account is disconnected. Reconnect it to resume sending.');
  }
  if (input.status === 'checkpointed') {
    return result(
      false,
      'LinkedIn is asking you to verify this account. Open LinkedIn, clear the checkpoint, then resume here.',
    );
  }
  if (input.checkpointUntil && input.checkpointUntil.getTime() > input.now.getTime()) {
    return result(
      false,
      `Cooling down after a platform warning. Sending resumes ${input.checkpointUntil.toISOString()}.`,
    );
  }
  if (!input.sendingEnabled) {
    return result(false, input.pausedReason ?? 'Sending is paused for this account.');
  }
  if (input.status === 'paused') {
    return result(false, input.pausedReason ?? 'This account is paused.');
  }

  if (isComment && band === 'critical') {
    return result(
      false,
      'Your connection acceptance rate has fallen below 15%. Commenting is on hold too - the platform already reads this account as spammy, and public comments are the most visible thing it does.',
    );
  }
  if (isInvite && band === 'critical') {
    return result(
      false,
      'Your connection acceptance rate has fallen below 15%. Invites are on hold — a low acceptance rate is what gets accounts restricted. Send fewer, more relevant invites.',
    );
  }
  if (isInvite && input.sentLast7d + input.pendingSameKind >= LIMITS.WEEKLY_INVITE_CAP) {
    return result(
      false,
      `Weekly invite limit reached (${LIMITS.WEEKLY_INVITE_CAP}). This resets on a rolling 7-day basis.`,
    );
  }
  if (remaining <= 0) {
    return result(
      false,
      isInvite
        ? `Daily invite limit reached (${cap} on warm-up day ${day}). Approved invites already in the queue count toward this.`
        : `Daily limit reached for this action (${cap}).`,
    );
  }

  return result(true, null);
}

/* ================================================================== *
 * 4. Timezone helpers
 * ================================================================== */

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/**
 * Constructing an Intl.DateTimeFormat is expensive and nextSlot() does it
 * thousands of times per sweep, so formatters are cached per zone. They are
 * stateless, so sharing one is safe.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Offset of `tz` from UTC, in ms, at the given instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  // Some ICU builds render midnight as hour 24.
  const hour = get('hour') % 24;
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  );
  return asIfUtc - instant.getTime();
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const shifted = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/**
 * Local wall-clock time in `timeZone` -> UTC instant.
 *
 * Two passes, because the offset we need depends on the instant we are trying
 * to find. On a DST spring-forward the requested wall time may not exist; we
 * return the instant just after the gap rather than pretending otherwise, and
 * callers re-validate the result against the window.
 */
function zonedToUtc(
  date: CalendarDate,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0, 0);
  let ts = naive - zoneOffsetMs(new Date(naive), timeZone);
  ts = naive - zoneOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

function addDays(date: CalendarDate, n: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + n));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function dayOfWeek(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/* ================================================================== *
 * 5. Pacing
 * ================================================================== */

export interface SendWindow {
  timezone: string;
  sendDays: number[];
  startHour: number;
  endHour: number;
}

export interface NextSlotInput {
  now: Date;
  window: SendWindow;
  /** Sends permitted per day. Controls how far apart slots are spread. */
  budget: number;
  /** The latest already-scheduled send for this account, if any. */
  lastScheduledAt?: Date | null;
  /** Injectable for tests. Must return [0, 1). */
  random?: () => number;
}

function normaliseWindow(w: SendWindow): {
  days: number[];
  startHour: number;
  endHour: number;
} {
  const days = [...new Set(w.sendDays.filter((d) => d >= 0 && d <= 6))].sort();
  const startHour = Math.min(23, Math.max(0, Math.floor(w.startHour)));
  const endHour = Math.min(24, Math.max(0, Math.floor(w.endHour)));
  return {
    days: days.length > 0 ? days : [...LIMITS.DEFAULT_SEND_DAYS],
    startHour,
    endHour: endHour > startHour ? endHour : startHour + 1,
  };
}

/**
 * Is `instant` inside the send window? The tests assert this over every slot
 * nextSlot() produces, so it is exported rather than duplicated there.
 */
export function isInsideWindow(instant: Date, w: SendWindow): boolean {
  const { days, startHour, endHour } = normaliseWindow(w);
  const p = localParts(instant, w.timezone);
  const dow = dayOfWeek({ year: p.year, month: p.month, day: p.day });
  if (!days.includes(dow)) return false;
  const minutes = p.hour * 60 + p.minute;
  return minutes >= startHour * 60 && minutes < endHour * 60;
}

/**
 * The next moment this account may send, given how much it is allowed to send
 * today and when it last sent.
 *
 * Guarantees, all covered by tests:
 *  - the result is inside the send window, in the account's own timezone,
 *    on one of its send days;
 *  - the result is at least MIN_LEAD_MINUTES in the future;
 *  - consecutive slots are at least MIN_GAP_MINUTES apart;
 *  - the result is never at the very end of the window (tail guard).
 */
export function nextSlot(input: NextSlotInput): Date {
  const { days, startHour, endHour } = normaliseWindow(input.window);
  const random = input.random ?? Math.random;

  const perDay = Math.max(1, Math.min(LIMITS.HARD_DAILY_INVITE_CAP, Math.floor(input.budget)));
  const windowMinutes = (endHour - startHour) * 60;

  const spacing = Math.min(
    LIMITS.MAX_GAP_MINUTES,
    Math.max(LIMITS.MIN_GAP_MINUTES, windowMinutes / perDay),
  );
  const jitter = 1 + (random() * 2 - 1) * LIMITS.JITTER_RATIO;
  const gapMinutes = Math.max(LIMITS.MIN_GAP_MINUTES, spacing * jitter);

  let earliest = new Date(input.now.getTime() + LIMITS.MIN_LEAD_MINUTES * 60_000);
  if (input.lastScheduledAt) {
    const afterLast = new Date(input.lastScheduledAt.getTime() + gapMinutes * 60_000);
    if (afterLast.getTime() > earliest.getTime()) earliest = afterLast;
  }

  const tailGuardMs = LIMITS.WINDOW_TAIL_GUARD_MINUTES * 60_000;
  const start = localParts(earliest, input.window.timezone);
  let cursor: CalendarDate = { year: start.year, month: start.month, day: start.day };

  // 400 days is well past any legal send-day configuration; the loop is
  // bounded so a pathological window can never hang the worker.
  for (let i = 0; i < 400; i++, cursor = addDays(cursor, 1)) {
    const date = cursor;
    if (!days.includes(dayOfWeek(date))) continue;

    const open = zonedToUtc(date, startHour, 0, input.window.timezone);
    const closeRaw = zonedToUtc(
      addDays(date, endHour >= 24 ? 1 : 0),
      endHour >= 24 ? 0 : endHour,
      0,
      input.window.timezone,
    );
    const close = new Date(closeRaw.getTime() - tailGuardMs);
    if (close.getTime() <= open.getTime()) continue;

    let candidate =
      earliest.getTime() > open.getTime() ? new Date(earliest.getTime()) : open;
    if (candidate.getTime() > close.getTime()) continue;

    // DST re-validation. zonedToUtc can land outside the window when the wall
    // time it was asked for does not exist. Nudge forward rather than trust it.
    let guard = 0;
    while (
      guard++ < 8 &&
      candidate.getTime() <= close.getTime() &&
      !isInsideWindow(candidate, input.window)
    ) {
      candidate = new Date(candidate.getTime() + 15 * 60_000);
    }
    if (candidate.getTime() > close.getTime() || !isInsideWindow(candidate, input.window)) {
      continue;
    }
    return candidate;
  }

  // Unreachable for any window with at least one send day, which
  // normaliseWindow guarantees.
  throw new Error('nextSlot: no send window found within 400 days');
}

/**
 * When something the user just approved should run.
 *
 * Unlike nextSlot() this ignores the send window entirely — the user is at the
 * keyboard and asked for it. What it does keep is the minimum gap: approving
 * five drafts in a row produces five spaced sends, not a burst, because a
 * burst is the pattern that gets an account flagged regardless of who asked
 * for it.
 */
export function soonSlot(input: {
  now: Date;
  lastScheduledAt?: Date | null;
  random?: () => number;
}): Date {
  const random = input.random ?? Math.random;
  // A little jitter so repeated approvals are not metronomic.
  const jitterMs = (random() * 2 - 1) * 60_000;
  let at = new Date(input.now.getTime() + LIMITS.MANUAL_APPROVAL_DELAY_MS + jitterMs);

  const floor = new Date(input.now.getTime() + LIMITS.MIN_LEAD_MINUTES * 60_000);
  if (at.getTime() < floor.getTime()) at = floor;

  if (input.lastScheduledAt) {
    const afterLast = new Date(
      input.lastScheduledAt.getTime() + LIMITS.MIN_GAP_MINUTES * 60_000,
    );
    if (afterLast.getTime() > at.getTime()) at = afterLast;
  }
  return at;
}

/* ================================================================== *
 * 6. Failure handling
 * ================================================================== */

export interface FailureOutcome {
  retry: boolean;
  retryDelayMs: number;
  /** Status to force on the account, or null to leave it alone. */
  accountStatus: AccountStatus | null;
  /** Flip sending_enabled off. Requires a human to turn back on. */
  disableSending: boolean;
  /** Set checkpoint_until to now + this. */
  cooldownMs: number | null;
  pausedReason: string | null;
}

export function backoffMs(attempts: number): number {
  const exp = LIMITS.BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(LIMITS.MAX_BACKOFF_MS, exp);
}

/**
 * What a failure means for the action and for the account. The worker does not
 * decide this; it applies it.
 */
export function outcomeForFailure(
  failureClass: FailureClass,
  attempts: number,
  retryAfterMs: number | null = null,
): FailureOutcome {
  const canRetry = attempts < LIMITS.MAX_ATTEMPTS;
  const base: FailureOutcome = {
    retry: false,
    retryDelayMs: 0,
    accountStatus: null,
    disableSending: false,
    cooldownMs: null,
    pausedReason: null,
  };

  switch (failureClass) {
    case 'transient':
      return { ...base, retry: canRetry, retryDelayMs: backoffMs(attempts) };

    case 'rate_limited':
      return {
        ...base,
        retry: canRetry,
        retryDelayMs: Math.max(retryAfterMs ?? 0, LIMITS.RATE_LIMIT_COOLDOWN_MS),
        cooldownMs: Math.max(retryAfterMs ?? 0, LIMITS.RATE_LIMIT_COOLDOWN_MS),
        pausedReason:
          'LinkedIn asked us to slow down. Sending is cooling off for an hour.',
      };

    case 'checkpoint':
      return {
        ...base,
        retry: false,
        accountStatus: 'checkpointed',
        disableSending: true,
        cooldownMs: LIMITS.CHECKPOINT_COOLDOWN_MS,
        pausedReason:
          'LinkedIn is asking you to verify this account. Open LinkedIn, clear the checkpoint, then resume here.',
      };

    case 'auth':
      return {
        ...base,
        retry: false,
        accountStatus: 'disconnected',
        disableSending: true,
        pausedReason: 'The LinkedIn session expired. Reconnect the account to resume.',
      };

    case 'invalid':
      // The request was bad, the account is fine. Fail the one action.
      return { ...base, retry: false };

    case 'permanent':
      return {
        ...base,
        retry: false,
        accountStatus: 'restricted',
        disableSending: true,
        pausedReason:
          'LinkedIn refused this action outright. PostFold has stopped sending on this account.',
      };
  }
}
