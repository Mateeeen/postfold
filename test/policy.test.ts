/**
 * policy.ts is the highest-value test target in this codebase. A regression
 * here does not throw an error - it ships account restrictions to users.
 */

import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_BANDS,
  LIMITS,
  acceptanceBand,
  backoffMs,
  budget,
  isInsideWindow,
  localParts,
  nextSlot,
  outcomeForFailure,
  soonSlot,
  warmupCap,
  warmupDay,
} from '../src/policy.js';
import type { BudgetInput } from '../src/policy.js';
import type { AccountStatus, FailureClass } from '../src/types.js';

const DAY = 86_400_000;

function baseBudgetInput(overrides: Partial<BudgetInput> = {}): BudgetInput {
  const now = new Date('2025-06-11T12:00:00Z'); // a Wednesday
  return {
    kind: 'send_invite',
    now,
    status: 'active',
    sendingEnabled: true,
    pausedReason: null,
    checkpointUntil: null,
    connectedAt: new Date(now.getTime() - 30 * DAY),
    sentLast24h: 0,
    sentLast7d: 0,
    pendingSameKind: 0,
    acceptanceRate: null,
    acceptanceSample: 0,
    dailyCapOverride: null,
    // Premium unless a test says otherwise: the free-tier note ceiling is far
    // lower than any cap of ours and would mask what these tests check.
    isPremium: true,
    invitesWithNoteLast30d: 0,
    ...overrides,
  };
}

/* ================================================================== *
 * Warm-up ladder
 * ================================================================== */

describe('warmupDay', () => {
  const connectedAt = new Date('2025-06-01T09:00:00Z');

  it.each([
    ['same instant', 0, 1],
    ['23h later', DAY - 3_600_000, 1],
    ['exactly 24h later', DAY, 2],
    ['6 days later', 6 * DAY, 7],
    ['60 days later', 60 * DAY, 61],
  ])('%s -> day %i', (_label, offsetMs, expected) => {
    expect(warmupDay(connectedAt, new Date(connectedAt.getTime() + (offsetMs as number)))).toBe(
      expected,
    );
  });

  it('clamps to day 1 for a clock that went backwards', () => {
    expect(warmupDay(connectedAt, new Date(connectedAt.getTime() - DAY))).toBe(1);
  });
});

describe('warmupCap', () => {
  it.each([
    [1, 5],
    [3, 5],
    [4, 10],
    [7, 10],
    [8, 15],
    [14, 15],
    [15, 20],
    [21, 20],
    [22, 25],
    [400, 25],
  ])('day %i -> %i invites', (day, cap) => {
    expect(warmupCap(day)).toBe(cap);
  });

  it('never exceeds the hard ceiling at any day', () => {
    for (let d = 1; d <= 500; d++) {
      expect(warmupCap(d)).toBeLessThanOrEqual(LIMITS.HARD_DAILY_INVITE_CAP);
    }
  });

  it('is monotonically non-decreasing', () => {
    for (let d = 2; d <= 500; d++) {
      expect(warmupCap(d)).toBeGreaterThanOrEqual(warmupCap(d - 1));
    }
  });
});

/* ================================================================== *
 * Acceptance bands
 * ================================================================== */

describe('acceptanceBand', () => {
  const sample = LIMITS.ACCEPTANCE_MIN_SAMPLE;

  it.each([
    [1.0, 'healthy', 1],
    [0.4, 'healthy', 1],
    [0.39, 'watch', 0.6],
    [0.25, 'watch', 0.6],
    [0.24, 'throttled', 0.3],
    [0.15, 'throttled', 0.3],
    [0.14, 'critical', 0],
    [0.0, 'critical', 0],
  ])('rate %f -> %s', (rate, band, multiplier) => {
    const result = acceptanceBand(rate as number, sample);
    expect(result.band).toBe(band);
    expect(result.multiplier).toBe(multiplier);
  });

  it('refuses to judge below the minimum sample', () => {
    // A new account with 2 sent and 0 accepted is new, not a spammer.
    expect(acceptanceBand(0, sample - 1)).toEqual({ band: 'unrated', multiplier: 1 });
    expect(acceptanceBand(0.9, sample - 1)).toEqual({ band: 'unrated', multiplier: 1 });
  });

  it('treats a null rate as unrated', () => {
    expect(acceptanceBand(null, 10_000).band).toBe('unrated');
  });

  it('has bands ordered strictly downward', () => {
    for (let i = 1; i < ACCEPTANCE_BANDS.length; i++) {
      expect(ACCEPTANCE_BANDS[i]!.minRate).toBeLessThan(ACCEPTANCE_BANDS[i - 1]!.minRate);
      expect(ACCEPTANCE_BANDS[i]!.multiplier).toBeLessThan(
        ACCEPTANCE_BANDS[i - 1]!.multiplier,
      );
    }
  });
});

/* ================================================================== *
 * budget()
 * ================================================================== */

describe('budget: warm-up days', () => {
  it.each([
    [1, 5],
    [4, 10],
    [8, 15],
    [15, 20],
    [22, 25],
  ])('day %i allows %i invites', (day, expectedCap) => {
    const now = new Date('2025-06-11T12:00:00Z');
    const result = budget(
      baseBudgetInput({ now, connectedAt: new Date(now.getTime() - (day - 1) * DAY) }),
    );
    expect(result.warmupDay).toBe(day);
    expect(result.cap).toBe(expectedCap);
    expect(result.remaining).toBe(expectedCap);
    expect(result.allowed).toBe(true);
  });
});

describe('budget: acceptance bands throttle invites', () => {
  const sample = LIMITS.ACCEPTANCE_MIN_SAMPLE;

  it.each([
    [0.8, 'healthy', 25, true],
    [0.3, 'watch', 15, true],
    [0.2, 'throttled', 7, true],
    [0.05, 'critical', 0, false],
  ])('rate %f -> band %s, cap %i', (rate, band, cap, allowed) => {
    const result = budget(
      baseBudgetInput({ acceptanceRate: rate as number, acceptanceSample: sample }),
    );
    expect(result.band).toBe(band);
    expect(result.cap).toBe(cap);
    expect(result.allowed).toBe(allowed);
  });

  it('does not throttle posts on acceptance rate', () => {
    // Publishing your own post is not what gets an account flagged.
    const result = budget(
      baseBudgetInput({ kind: 'create_post', acceptanceRate: 0.05, acceptanceSample: sample }),
    );
    expect(result.cap).toBe(LIMITS.DAILY_POST_CAP);
    expect(result.allowed).toBe(true);
  });

  it('gives a critical account a reason naming the acceptance rate', () => {
    const result = budget(baseBudgetInput({ acceptanceRate: 0.01, acceptanceSample: sample }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/acceptance rate/i);
  });
});

describe('budget: paused and unhealthy states', () => {
  const cases: [string, Partial<BudgetInput>, RegExp][] = [
    ['restricted', { status: 'restricted' as AccountStatus }, /restricted/i],
    ['disconnected', { status: 'disconnected' as AccountStatus }, /disconnected/i],
    ['checkpointed', { status: 'checkpointed' as AccountStatus }, /verify/i],
    [
      'paused',
      { status: 'paused' as AccountStatus, pausedReason: 'Taking a week off' },
      /week off/,
    ],
    ['sending-off', { sendingEnabled: false, pausedReason: 'Paused by you' }, /Paused by you/],
    ['cooldown', { checkpointUntil: new Date('2025-06-11T18:00:00Z') }, /Cooling down/i],
  ];

  it.each(cases)('%s refuses with a user-facing reason', (_label, patch, pattern) => {
    const result = budget(baseBudgetInput(patch));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(pattern);
  });

  it('ignores an expired cooldown', () => {
    const result = budget(baseBudgetInput({ checkpointUntil: new Date('2025-06-11T06:00:00Z') }));
    expect(result.allowed).toBe(true);
  });

  it('reports the most serious reason when several apply', () => {
    // Restricted outranks paused: it is the one needing the user's attention.
    const result = budget(
      baseBudgetInput({
        status: 'restricted',
        sendingEnabled: false,
        pausedReason: 'Paused by you',
      }),
    );
    expect(result.reason).toMatch(/restricted/i);
  });
});

describe('budget: counting', () => {
  it('counts pending work against the cap', () => {
    // Otherwise a user approves 40 suggestions in a minute and the queue
    // happily promises to send all of them.
    const result = budget(baseBudgetInput({ sentLast24h: 5, pendingSameKind: 10 }));
    expect(result.cap).toBe(25);
    expect(result.remaining).toBe(10);
    expect(result.allowed).toBe(true);
  });

  it('refuses once sent + pending reach the cap', () => {
    const result = budget(baseBudgetInput({ sentLast24h: 20, pendingSameKind: 5 }));
    expect(result.remaining).toBe(0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Daily invite limit/i);
  });

  it('never reports negative remaining', () => {
    const result = budget(baseBudgetInput({ sentLast24h: 99 }));
    expect(result.remaining).toBe(0);
  });

  it('enforces the weekly cap independently of the daily one', () => {
    const result = budget(
      baseBudgetInput({ sentLast24h: 0, sentLast7d: LIMITS.WEEKLY_INVITE_CAP }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Weekly invite limit/i);
  });
});

describe('budget: overrides', () => {
  it('lowers a cap', () => {
    const result = budget(baseBudgetInput({ dailyCapOverride: { send_invite: 3 } }));
    expect(result.cap).toBe(3);
  });

  it('cannot raise a cap above policy', () => {
    // An override is a safety valve, not a bypass.
    const result = budget(
      baseBudgetInput({
        connectedAt: new Date('2025-06-11T12:00:00Z'), // day 1, cap 5
        dailyCapOverride: { send_invite: 500 },
      }),
    );
    expect(result.cap).toBe(5);
  });

  it('cannot raise a cap above the hard ceiling on a mature account', () => {
    const result = budget(baseBudgetInput({ dailyCapOverride: { send_invite: 9999 } }));
    expect(result.cap).toBe(LIMITS.HARD_DAILY_INVITE_CAP);
  });

  it('clamps a negative override to zero rather than inverting it', () => {
    const result = budget(baseBudgetInput({ dailyCapOverride: { send_invite: -10 } }));
    expect(result.cap).toBe(0);
    expect(result.allowed).toBe(false);
  });
});

/* ================================================================== *
 * nextSlot() - the part that has already shipped two real bugs
 * ================================================================== */

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'America/Santiago', // DST transition at local midnight
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata', // +05:30
  'Asia/Tokyo', // no DST
  'Australia/Sydney', // southern-hemisphere DST
  'Pacific/Chatham', // +12:45 / +13:45
];

const WINDOW = (timezone: string) => ({
  timezone,
  sendDays: [...LIMITS.DEFAULT_SEND_DAYS],
  startHour: LIMITS.DEFAULT_WINDOW_START_HOUR,
  endHour: LIMITS.DEFAULT_WINDOW_END_HOUR,
});

/** Deterministic replacements for Math.random, including both extremes. */
const RANDOMS: (() => number)[] = [() => 0, () => 0.5, () => 0.999999];

describe('nextSlot: every result lands inside the send window', () => {
  for (const timezone of TIMEZONES) {
    it(`${timezone}: full week x budgets 1-25 x jitter extremes`, () => {
      const window = WINDOW(timezone);
      let checked = 0;

      // A full week of start days, sampled across the whole 24h clock so that
      // "now" lands before, inside and after the window in every zone.
      for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        for (const hour of [0, 3, 8, 9, 12, 16, 17, 20, 23]) {
          const now = new Date(Date.UTC(2025, 5, 8 + dayOffset, hour, 37, 0));
          for (let b = 1; b <= LIMITS.HARD_DAILY_INVITE_CAP; b++) {
            for (const random of RANDOMS) {
              const slot = nextSlot({ now, window, budget: b, random });

              expect(
                isInsideWindow(slot, window),
                `${timezone} b=${b} now=${now.toISOString()} -> ${slot.toISOString()} ` +
                  `(local ${JSON.stringify(localParts(slot, timezone))})`,
              ).toBe(true);
              expect(slot.getTime()).toBeGreaterThanOrEqual(
                now.getTime() + LIMITS.MIN_LEAD_MINUTES * 60_000,
              );
              checked++;
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
    });
  }
});

describe('nextSlot: DST transitions', () => {
  // Spring forward, fall back, southern-hemisphere transitions, and Santiago,
  // whose change happens at local midnight.
  const transitions: [string, string][] = [
    ['America/New_York', '2025-03-09T00:00:00Z'],
    ['America/New_York', '2025-11-02T00:00:00Z'],
    ['Europe/London', '2025-03-30T00:00:00Z'],
    ['Europe/London', '2025-10-26T00:00:00Z'],
    ['Australia/Sydney', '2025-10-05T00:00:00Z'],
    ['Australia/Sydney', '2025-04-06T00:00:00Z'],
    ['America/Santiago', '2025-09-07T00:00:00Z'],
    ['Pacific/Chatham', '2025-09-28T00:00:00Z'],
  ];

  it.each(transitions)('%s around %s', (timezone, iso) => {
    const window = WINDOW(timezone);
    const base = new Date(iso).getTime();
    for (let h = -36; h <= 36; h++) {
      const now = new Date(base + h * 3_600_000);
      for (let b = 1; b <= 25; b += 6) {
        for (const random of RANDOMS) {
          const slot = nextSlot({ now, window, budget: b, random });
          expect(
            isInsideWindow(slot, window),
            `${timezone} now=${now.toISOString()} -> ${slot.toISOString()}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe('nextSlot: spacing', () => {
  const timezone = 'Europe/London';
  const window = WINDOW(timezone);

  it('never schedules two sends closer than the minimum gap', () => {
    for (let b = 1; b <= 25; b++) {
      let cursor = new Date('2025-06-09T08:00:00Z'); // Monday, before the window
      let last: Date | null = null;
      for (let i = 0; i < 40; i++) {
        const slot = nextSlot({
          now: cursor,
          window,
          budget: b,
          lastScheduledAt: last,
          random: () => 0, // most aggressive jitter
        });
        if (last) {
          const gapMinutes = (slot.getTime() - last.getTime()) / 60_000;
          expect(gapMinutes, `budget ${b}, slot ${i}`).toBeGreaterThanOrEqual(
            LIMITS.MIN_GAP_MINUTES,
          );
        }
        expect(isInsideWindow(slot, window)).toBe(true);
        last = slot;
        cursor = slot;
      }
    }
  });

  it('spreads a full day of sends rather than bursting', () => {
    // A burst is the signal that gets an account restricted.
    let cursor = new Date('2025-06-09T08:00:00Z');
    let last: Date | null = null;
    const slots: Date[] = [];
    for (let i = 0; i < 10; i++) {
      const slot = nextSlot({
        now: cursor,
        window,
        budget: 10,
        lastScheduledAt: last,
        random: () => 0.5, // no jitter
      });
      slots.push(slot);
      last = slot;
      cursor = slot;
    }
    const first = slots[0]!.getTime();
    const lastSlot = slots.at(-1)!.getTime();
    expect((lastSlot - first) / 60_000).toBeGreaterThan(6 * 48);
  });

  it('rolls to the next send day when the window has no room left', () => {
    // Friday 16:58 London - inside the window, but inside the tail guard.
    const now = new Date('2025-06-13T15:58:00Z');
    const slot = nextSlot({ now, window, budget: 5, random: () => 0.5 });
    expect(isInsideWindow(slot, window)).toBe(true);
    const p = localParts(slot, timezone);
    // Saturday and Sunday are not send days, so this must be Monday.
    expect(new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()).toBe(1);
  });

  it('respects a custom send-day set', () => {
    const weekendOnly = { ...WINDOW('Asia/Tokyo'), sendDays: [0, 6] };
    for (let d = 0; d < 7; d++) {
      const slot = nextSlot({
        now: new Date(Date.UTC(2025, 5, 8 + d, 4, 0, 0)),
        window: weekendOnly,
        budget: 3,
        random: () => 0.5,
      });
      expect(isInsideWindow(slot, weekendOnly)).toBe(true);
    }
  });

  it('falls back to the default send days when given none', () => {
    const noDays = { ...WINDOW('UTC'), sendDays: [] };
    const slot = nextSlot({
      now: new Date('2025-06-11T12:00:00Z'),
      window: noDays,
      budget: 5,
      random: () => 0.5,
    });
    expect(isInsideWindow(slot, WINDOW('UTC'))).toBe(true);
  });

  it('never returns a slot in the last minutes of the window', () => {
    const utcWindow = WINDOW('UTC');
    for (let m = 0; m < 60; m++) {
      const now = new Date(Date.UTC(2025, 5, 11, 16, m, 0));
      const slot = nextSlot({ now, window: utcWindow, budget: 25, random: () => 0 });
      const p = localParts(slot, 'UTC');
      const minutesIntoDay = p.hour * 60 + p.minute;
      expect(minutesIntoDay).toBeLessThanOrEqual(
        utcWindow.endHour * 60 - LIMITS.WINDOW_TAIL_GUARD_MINUTES,
      );
    }
  });
});

/* ================================================================== *
 * Failure handling
 * ================================================================== */

describe('outcomeForFailure', () => {
  it('retries transient failures with growing backoff', () => {
    const first = outcomeForFailure('transient', 1);
    const third = outcomeForFailure('transient', 3);
    expect(first.retry).toBe(true);
    expect(third.retryDelayMs).toBeGreaterThan(first.retryDelayMs);
    expect(first.accountStatus).toBeNull();
  });

  it('stops retrying at the attempt ceiling', () => {
    expect(outcomeForFailure('transient', LIMITS.MAX_ATTEMPTS).retry).toBe(false);
  });

  it('cools the account down on rate limiting', () => {
    const outcome = outcomeForFailure('rate_limited', 1);
    expect(outcome.retry).toBe(true);
    expect(outcome.cooldownMs).toBe(LIMITS.RATE_LIMIT_COOLDOWN_MS);
  });

  it('honours a longer provider-supplied cooldown', () => {
    const long = 4 * LIMITS.RATE_LIMIT_COOLDOWN_MS;
    expect(outcomeForFailure('rate_limited', 1, long).cooldownMs).toBe(long);
  });

  it('never shortens the cooldown below policy on a small retry-after', () => {
    expect(outcomeForFailure('rate_limited', 1, 1_000).cooldownMs).toBe(
      LIMITS.RATE_LIMIT_COOLDOWN_MS,
    );
  });

  it('stops the account dead on a checkpoint and does not retry', () => {
    const outcome = outcomeForFailure('checkpoint', 1);
    expect(outcome.retry).toBe(false);
    expect(outcome.accountStatus).toBe('checkpointed');
    expect(outcome.disableSending).toBe(true);
    expect(outcome.cooldownMs).toBe(LIMITS.CHECKPOINT_COOLDOWN_MS);
  });

  it('leaves the account alone for an invalid request', () => {
    const outcome = outcomeForFailure('invalid', 1);
    expect(outcome.retry).toBe(false);
    expect(outcome.accountStatus).toBeNull();
    expect(outcome.disableSending).toBe(false);
  });

  it.each<[FailureClass]>([['checkpoint'], ['auth'], ['permanent']])(
    '%s disables sending and requires a human',
    (fc) => {
      const outcome = outcomeForFailure(fc, 1);
      expect(outcome.retry).toBe(false);
      expect(outcome.disableSending).toBe(true);
      expect(outcome.pausedReason).toBeTruthy();
    },
  );
});

describe('backoffMs', () => {
  it('is capped', () => {
    expect(backoffMs(50)).toBe(LIMITS.MAX_BACKOFF_MS);
  });

  it('is non-decreasing', () => {
    for (let a = 2; a < 20; a++) {
      expect(backoffMs(a)).toBeGreaterThanOrEqual(backoffMs(a - 1));
    }
  });
});

describe('soonSlot', () => {
  const now = new Date('2026-09-03T20:30:00Z'); // well outside any send window

  it('runs about five minutes out, ignoring the send window', () => {
    const at = soonSlot({ now, random: () => 0.5 });
    const mins = (at.getTime() - now.getTime()) / 60_000;
    expect(mins).toBeGreaterThan(3);
    expect(mins).toBeLessThan(7);
  });

  it('never lands sooner than the minimum lead, at any jitter', () => {
    for (const random of [() => 0, () => 0.5, () => 0.999999]) {
      const at = soonSlot({ now, random });
      expect(at.getTime() - now.getTime()).toBeGreaterThanOrEqual(
        LIMITS.MIN_LEAD_MINUTES * 60_000,
      );
    }
  });

  it('still spaces consecutive approvals by the minimum gap', () => {
    // Approving five drafts at once must not fire five sends at once — a burst
    // is the flagged pattern regardless of who asked for it.
    let last: Date | null = null;
    for (let i = 0; i < 5; i++) {
      const at = soonSlot({ now, lastScheduledAt: last, random: () => 0 });
      if (last) {
        expect((at.getTime() - last.getTime()) / 60_000).toBeGreaterThanOrEqual(
          LIMITS.MIN_GAP_MINUTES,
        );
      }
      last = at;
    }
  });

  it('does not roll to the next send day the way nextSlot does', () => {
    // The whole point: a 20:30 approval sends at 20:35, not 09:00 tomorrow.
    const at = soonSlot({ now, random: () => 0.5 });
    expect(at.getUTCDate()).toBe(now.getUTCDate());
  });
});

describe('budget: note allowance', () => {
  // Strategy: spend the note allowance, then keep inviting WITHOUT a note,
  // which carries a far higher platform ceiling. Running out of notes must
  // never stop invites.
  it('reports notes remaining and does not refuse when they run out', () => {
    const spent = budget(
      baseBudgetInput({ isPremium: false, invitesWithNoteLast30d: LIMITS.FREE_WITH_NOTE_MONTHLY_CAP }),
    );
    expect(spent.notesRemaining).toBe(0);
    expect(spent.noteAllowed).toBe(false);
    // The invite itself is still allowed — it just goes without a note.
    expect(spent.allowed).toBe(true);
  });

  it('counts down as notes are used', () => {
    const r = budget(baseBudgetInput({ isPremium: false, invitesWithNoteLast30d: 2 }));
    expect(r.notesRemaining).toBe(LIMITS.FREE_WITH_NOTE_MONTHLY_CAP - 2);
    expect(r.noteAllowed).toBe(true);
  });

  it('counts queued invites against the allowance', () => {
    // Otherwise approving five at once spends one note five times.
    const r = budget(
      baseBudgetInput({ isPremium: false, invitesWithNoteLast30d: 3, pendingSameKind: 2 }),
    );
    expect(r.notesRemaining).toBe(0);
  });

  it('gives a premium account the larger allowance', () => {
    const free = budget(baseBudgetInput({ isPremium: false }));
    const paid = budget(baseBudgetInput({ isPremium: true }));
    expect(paid.notesRemaining).toBe(LIMITS.PREMIUM_WITH_NOTE_MONTHLY_CAP);
    expect(paid.notesRemaining).toBeGreaterThan(free.notesRemaining);
  });

  it('treats unknown tier as free', () => {
    const r = budget(baseBudgetInput({ isPremium: null }));
    expect(r.notesRemaining).toBe(LIMITS.FREE_WITH_NOTE_MONTHLY_CAP);
  });

  it('never reports a negative allowance', () => {
    const r = budget(baseBudgetInput({ isPremium: false, invitesWithNoteLast30d: 999 }));
    expect(r.notesRemaining).toBe(0);
  });
});
