/**
 * scheduler.enqueue() is the only writer to the actions table (invariant 3),
 * which makes it the only place the daily cap is actually enforced.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { backfillNoteUsage, getUsage, updateAccount } from '../src/db/accounts.js';
import { isInsideWindow, LIMITS } from '../src/policy.js';
import { enqueue } from '../src/queue/scheduler.js';
import { getAccountState } from '../src/state.js';
import { addSuggestion, fixture, invitePayload } from './helpers.js';
import type { Fixture } from './helpers.js';

let current: Fixture | null = null;

afterEach(() => {
  current?.db.close();
  current = null;
});

async function setup(options?: {
  connectedDaysAgo?: number;
  timezone?: string;
  premium?: boolean;
}) {
  current = await fixture(options);
  return current;
}

describe('enqueue: happy path', () => {
  it('queues an invite inside the send window', async () => {
    const f = await setup({ timezone: 'Europe/London' });
    const result = await enqueue(
      {
        accountId: f.account.id,
        payload: invitePayload(f.suggestion.id, f.person),
        dedupeKey: `invite:${f.suggestion.id}`,
      },
      f.db,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.action.status).toBe('pending');
    expect(
      isInsideWindow(result.action.scheduledAt, {
        timezone: 'Europe/London',
        sendDays: [...LIMITS.DEFAULT_SEND_DAYS],
        startHour: LIMITS.DEFAULT_WINDOW_START_HOUR,
        endHour: LIMITS.DEFAULT_WINDOW_END_HOUR,
      }),
    ).toBe(true);
  });

  it('always schedules into the future, never immediately', async () => {
    const f = await setup();
    const before = Date.now();
    const result = await enqueue(
      {
        accountId: f.account.id,
        payload: invitePayload(f.suggestion.id, f.person),
        dedupeKey: `invite:${f.suggestion.id}`,
      },
      f.db,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.scheduledAt.getTime()).toBeGreaterThan(before);
  });

  it('stores the payload as JSON and reads it back intact', async () => {
    const f = await setup();
    const note = 'Hi Dana — "quoted", \\ backslashed, emoji 👋';
    const result = await enqueue(
      {
        accountId: f.account.id,
        payload: invitePayload(f.suggestion.id, f.person, note),
        dedupeKey: `invite:${f.suggestion.id}`,
      },
      f.db,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.payload).toMatchObject({ kind: 'send_invite', note });
  });
});

describe('enqueue: idempotency', () => {
  it('creates one action for duplicate calls with the same dedupe key', async () => {
    const f = await setup();
    const input = {
      accountId: f.account.id,
      payload: invitePayload(f.suggestion.id, f.person),
      dedupeKey: `invite:${f.suggestion.id}`,
    };

    const first = await enqueue(input, f.db);
    const second = await enqueue(input, f.db);
    const third = await enqueue(input, f.db);

    expect(first.ok && first.created).toBe(true);
    expect(second.ok && second.created).toBe(false);
    expect(third.ok && third.created).toBe(false);
    if (first.ok && second.ok) expect(second.action.id).toBe(first.action.id);

    const count = f.db.prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('does not spend budget on a duplicate', async () => {
    const f = await setup({ connectedDaysAgo: 0 }); // day 1, cap 5
    const input = {
      accountId: f.account.id,
      payload: invitePayload(f.suggestion.id, f.person),
      dedupeKey: `invite:${f.suggestion.id}`,
    };
    for (let i = 0; i < 20; i++) await enqueue(input, f.db);

    const count = f.db.prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('enqueue: budget enforcement', () => {
  it('counts pending work against the cap and refuses over it', async () => {
    // Day 1: cap is 5. Nothing has been sent, so all five must come from the
    // pending count alone.
    const f = await setup({ connectedDaysAgo: 0 });

    const outcomes: boolean[] = [];
    for (let i = 1; i <= 8; i++) {
      const { person, suggestionId } = await addSuggestion(f, i);
      const result = await enqueue(
        {
          accountId: f.account.id,
          payload: invitePayload(suggestionId, person),
          dedupeKey: `invite:${suggestionId}`,
        },
        f.db,
      );
      outcomes.push(result.ok);
    }

    expect(outcomes).toEqual([true, true, true, true, true, false, false, false]);

    const count = f.db.prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number };
    expect(count.n).toBe(5);
  });

  it('returns the policy reason verbatim when it refuses', async () => {
    const f = await setup({ connectedDaysAgo: 0 });
    for (let i = 1; i <= 5; i++) {
      const { person, suggestionId } = await addSuggestion(f, i);
      await enqueue(
        {
          accountId: f.account.id,
          payload: invitePayload(suggestionId, person),
          dedupeKey: `invite:${suggestionId}`,
        },
        f.db,
      );
    }

    const { person, suggestionId } = await addSuggestion(f, 99);
    const result = await enqueue(
      {
        accountId: f.account.id,
        payload: invitePayload(suggestionId, person),
        dedupeKey: `invite:${suggestionId}`,
      },
      f.db,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // This string is shown to the user unmodified, as the body of a 409.
    expect(result.reason).toMatch(/Daily invite limit reached \(5 on warm-up day 1\)/);
    expect(result.reason).toMatch(/queue count toward this/);
  });

  it('refuses when sending is disabled, and inserts nothing', async () => {
    const f = await setup();
    await updateAccount(
      f.account.id,
      { sendingEnabled: false, pausedReason: 'Paused by you.' },
      f.db,
    );

    const result = await enqueue(
      {
        accountId: f.account.id,
        payload: invitePayload(f.suggestion.id, f.person),
        dedupeKey: `invite:${f.suggestion.id}`,
      },
      f.db,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('Paused by you.');
    const count = f.db.prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it.each([
    ['checkpointed', /verify/i],
    ['restricted', /restricted/i],
    ['disconnected', /disconnected/i],
  ] as const)('refuses on a %s account', async (status, pattern) => {
    const f = await setup();
    await updateAccount(f.account.id, { status }, f.db);

    const result = await enqueue(
      {
        accountId: f.account.id,
        payload: invitePayload(f.suggestion.id, f.person),
        dedupeKey: `invite:${f.suggestion.id}`,
      },
      f.db,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(pattern);
  });

  it('refuses for an account that does not exist', async () => {
    const f = await setup();
    const result = await enqueue(
      {
        accountId: 'no-such-account',
        payload: invitePayload(f.suggestion.id, f.person),
        dedupeKey: 'invite:nope',
      },
      f.db,
    );
    expect(result.ok).toBe(false);
  });

  it('applies caps per kind, not globally', async () => {
    const f = await setup({ connectedDaysAgo: 0 });

    // Use up the invite budget for day 1.
    for (let i = 1; i <= 5; i++) {
      const { person, suggestionId } = await addSuggestion(f, i);
      await enqueue(
        {
          accountId: f.account.id,
          payload: invitePayload(suggestionId, person),
          dedupeKey: `invite:${suggestionId}`,
        },
        f.db,
      );
    }

    // Posting is a different kind with its own cap and must still work.
    const post = await enqueue(
      {
        accountId: f.account.id,
        payload: { kind: 'create_post', postId: f.postId, text: 'hello' },
        dedupeKey: `post:${f.postId}`,
      },
      f.db,
    );
    expect(post.ok).toBe(true);
  });
});

describe('enqueue: pacing across actions', () => {
  it('spaces queued invites out rather than stacking them', async () => {
    const f = await setup();
    const times: number[] = [];

    for (let i = 1; i <= 6; i++) {
      const { person, suggestionId } = await addSuggestion(f, i);
      const result = await enqueue(
        {
          accountId: f.account.id,
          payload: invitePayload(suggestionId, person),
          dedupeKey: `invite:${suggestionId}`,
        },
        f.db,
      );
      expect(result.ok).toBe(true);
      if (result.ok) times.push(result.action.scheduledAt.getTime());
    }

    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const gapMinutes = (times[i]! - times[i - 1]!) / 60_000;
      expect(gapMinutes).toBeGreaterThanOrEqual(LIMITS.MIN_GAP_MINUTES);
    }
  });

  it('spaces a post against a pending invite — concurrency is 1', async () => {
    const f = await setup();
    const invite = await enqueue(
      {
        accountId: f.account.id,
        payload: invitePayload(f.suggestion.id, f.person),
        dedupeKey: `invite:${f.suggestion.id}`,
      },
      f.db,
    );
    const post = await enqueue(
      {
        accountId: f.account.id,
        payload: { kind: 'create_post', postId: f.postId, text: 'hello' },
        dedupeKey: `post:${f.postId}`,
      },
      f.db,
    );

    expect(invite.ok && post.ok).toBe(true);
    if (!invite.ok || !post.ok) return;
    const gapMinutes =
      Math.abs(post.action.scheduledAt.getTime() - invite.action.scheduledAt.getTime()) / 60_000;
    expect(gapMinutes).toBeGreaterThanOrEqual(LIMITS.MIN_GAP_MINUTES);
  });
});

describe('enqueue: urgency', () => {
  it('schedules a user-approved action minutes out, outside the send window', async () => {
    const f = await setup({ timezone: 'Asia/Karachi' });
    // 20:30 Karachi — well past the 17:00 window close.
    const now = new Date('2026-09-03T15:30:00Z');

    const result = await enqueue(
      {
        accountId: f.account.id,
        payload: invitePayload(f.suggestion.id, f.person),
        dedupeKey: `invite:${f.suggestion.id}`,
        urgency: 'soon',
        now,
      },
      f.db,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mins = (result.action.scheduledAt.getTime() - now.getTime()) / 60_000;
    expect(mins).toBeLessThan(15);
  });

  it('is not dragged behind a paced action sitting in tomorrow\u2019s window', async () => {
    // The bug this guards: soonSlot chained off MAX(scheduled_at) across all
    // pending work, so one paced action tomorrow pushed every manual approval
    // to tomorrow + 8 minutes.
    const f = await setup({ timezone: 'Asia/Karachi' });
    const now = new Date('2026-09-03T15:30:00Z');

    const paced = await enqueue(
      {
        accountId: f.account.id,
        payload: { kind: 'create_post', postId: f.postId, text: 'paced' },
        dedupeKey: 'post:paced',
        now,
      },
      f.db,
    );
    expect(paced.ok).toBe(true);
    if (!paced.ok) return;
    // Confirm the fixture really did roll into the next window.
    expect(paced.action.scheduledAt.getTime() - now.getTime()).toBeGreaterThan(6 * 3_600_000);

    const soon = await enqueue(
      {
        accountId: f.account.id,
        payload: invitePayload(f.suggestion.id, f.person),
        dedupeKey: `invite:${f.suggestion.id}`,
        urgency: 'soon',
        now,
      },
      f.db,
    );
    expect(soon.ok).toBe(true);
    if (!soon.ok) return;
    const mins = (soon.action.scheduledAt.getTime() - now.getTime()) / 60_000;
    expect(mins).toBeLessThan(15);
  });

  it('still spaces several approvals made back to back', async () => {
    const f = await setup({ timezone: 'Asia/Karachi' });
    const now = new Date('2026-09-03T15:30:00Z');
    const times: number[] = [];

    for (let i = 1; i <= 4; i++) {
      const { person, suggestionId } = await addSuggestion(f, i);
      const r = await enqueue(
        {
          accountId: f.account.id,
          payload: invitePayload(suggestionId, person),
          dedupeKey: `invite:${suggestionId}`,
          urgency: 'soon',
          now,
        },
        f.db,
      );
      expect(r.ok).toBe(true);
      if (r.ok) times.push(r.action.scheduledAt.getTime());
    }

    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      expect((times[i]! - times[i - 1]!) / 60_000).toBeGreaterThanOrEqual(LIMITS.MIN_GAP_MINUTES);
    }
  });
});

describe('enqueue: retry after a terminal attempt', () => {
  it('lets the same work be queued again after it failed', async () => {
    // A failed action must not hold its dedupe key forever — that made one
    // bad send permanently unrepeatable, and returned the stale failed action
    // to the caller as if it were freshly queued.
    const f = await setup();
    const input = {
      accountId: f.account.id,
      payload: invitePayload(f.suggestion.id, f.person),
      dedupeKey: `invite:${f.suggestion.id}`,
    };

    const first = await enqueue(input, f.db);
    expect(first.ok && first.created).toBe(true);
    if (!first.ok) return;

    f.db.prepare("UPDATE actions SET status = 'failed' WHERE id = ?").run(first.action.id);

    const second = await enqueue(input, f.db);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(true);
    expect(second.action.id).not.toBe(first.action.id);
    expect(second.action.scheduledAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('still dedupes against a live or completed attempt', async () => {
    const f = await setup();
    const input = {
      accountId: f.account.id,
      payload: invitePayload(f.suggestion.id, f.person),
      dedupeKey: `invite:${f.suggestion.id}`,
    };
    const first = await enqueue(input, f.db);
    if (!first.ok) return;

    expect((await enqueue(input, f.db)).ok).toBe(true);
    f.db.prepare("UPDATE actions SET status = 'done' WHERE id = ?").run(first.action.id);
    const third = await enqueue(input, f.db);
    expect(third.ok && third.created).toBe(false);

    const n = f.db.prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe('note backfill', () => {
  it('counts pre-existing invites against the monthly allowance', async () => {
    // A fresh deployment has an empty invites table but the platform still
    // remembers what was sent. Without this, a free account believes it has
    // all five notes left and overspends a real limit.
    const f = await setup({ premium: false });

    const before = await getUsage(f.account.id, 'send_invite', f.db);
    expect(before.invitesWithNoteLast30d).toBe(0);

    await backfillNoteUsage(f.account.id, 2, f.db);

    const after = await getUsage(f.account.id, 'send_invite', f.db);
    expect(after.invitesWithNoteLast30d).toBe(2);

    const state = await getAccountState(f.account.id, new Date(), f.db);
    expect(state?.notesRemaining).toBe(LIMITS.FREE_WITH_NOTE_MONTHLY_CAP - 2);
  });

  it('is idempotent — it sets the count, it does not add to it', async () => {
    const f = await setup({ premium: false });
    await backfillNoteUsage(f.account.id, 2, f.db);
    await backfillNoteUsage(f.account.id, 2, f.db);
    const usage = await getUsage(f.account.id, 'send_invite', f.db);
    expect(usage.invitesWithNoteLast30d).toBe(2);
  });

  it('leaves the acceptance rate alone', async () => {
    // The backfill must never look like a sent invite, or it would drag the
    // acceptance rate down and throttle the account on invented evidence.
    const f = await setup({ premium: false });
    await backfillNoteUsage(f.account.id, 5, f.db);
    const usage = await getUsage(f.account.id, 'send_invite', f.db);
    expect(usage.acceptanceSample).toBe(0);
    expect(usage.acceptanceRate).toBeNull();
  });
});
