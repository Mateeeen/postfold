/**
 * Failure classification is the part of the worker that protects the account.
 * Each FailureClass is injected through the FakeProvider and the resulting
 * action AND account state is asserted — getting this wrong means retrying
 * into a checkpoint, which is how accounts get restricted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getAccount, updateAccount } from '../src/db/accounts.js';
import { getAction } from '../src/db/actions.js';
import { getSuggestion } from '../src/db/content.js';
import { LIMITS } from '../src/policy.js';
import { FakeProvider } from '../src/providers/fake.js';
import { enqueue } from '../src/queue/scheduler.js';
import { claimNext, tick } from '../src/queue/worker.js';
import { fixture, invitePayload } from './helpers.js';
import type { Fixture } from './helpers.js';
import type { FailureClass } from '../src/types.js';

let current: Fixture | null = null;

afterEach(() => {
  current?.db.close();
  current = null;
});

const silent = { log: () => {} };

/** Queue one invite and return it with a time just past its slot. */
async function queuedInvite(f: Fixture): Promise<{ actionId: string; due: Date }> {
  const result = await enqueue(
    {
      accountId: f.account.id,
      payload: invitePayload(f.suggestion.id, f.person),
      dedupeKey: `invite:${f.suggestion.id}`,
    },
    f.db,
  );
  if (!result.ok) throw new Error(`enqueue refused: ${result.reason}`);
  return {
    actionId: result.action.id,
    due: new Date(result.action.scheduledAt.getTime() + 1000),
  };
}

describe('claimNext', () => {
  it('does not claim an action before its scheduled time', async () => {
    const f = (current = await fixture());
    await queuedInvite(f);
    expect(await claimNext(new Date(), f.db)).toBeNull();
  });

  it('claims a due action exactly once', async () => {
    const f = (current = await fixture());
    const { due } = await queuedInvite(f);

    const first = await claimNext(due, f.db);
    const second = await claimNext(due, f.db);

    expect(first).not.toBeNull();
    expect(first?.status).toBe('in_flight');
    expect(first?.attempts).toBe(1);
    // Single-writer model: the row is gone from the pending set immediately.
    expect(second).toBeNull();
  });

  it('claims the earliest due action first', async () => {
    const f = (current = await fixture());
    const a = await enqueue(
      {
        accountId: f.account.id,
        payload: invitePayload(f.suggestion.id, f.person),
        dedupeKey: 'invite:a',
      },
      f.db,
    );
    const b = await enqueue(
      {
        accountId: f.account.id,
        payload: { kind: 'create_post', postId: f.postId, text: 'hi' },
        dedupeKey: 'post:b',
      },
      f.db,
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const earliest =
      a.action.scheduledAt <= b.action.scheduledAt ? a.action.id : b.action.id;
    const claimed = await claimNext(
      new Date(Math.max(a.action.scheduledAt.getTime(), b.action.scheduledAt.getTime()) + 1000),
      f.db,
    );
    expect(claimed?.id).toBe(earliest);
  });
});

describe('tick: success', () => {
  it('sends the invite, records it, and marks the suggestion approved', async () => {
    const f = (current = await fixture());
    const { actionId, due } = await queuedInvite(f);
    const provider = new FakeProvider(silent);

    expect(await tick(provider, due, f.db)).toBe(true);

    const action = await getAction(actionId, f.db);
    expect(action?.status).toBe('done');
    expect(action?.completedAt).not.toBeNull();

    const invite = f.db.prepare('SELECT status, person_id FROM invites').get() as {
      status: string;
      person_id: string;
    };
    expect(invite.status).toBe('sent');
    expect(invite.person_id).toBe(f.person.id);

    expect((await getSuggestion(f.suggestion.id, f.db))?.status).toBe('approved');
    // getProfile first: the already-connected guard runs before every send.
    expect(provider.calls.map((c) => c.method)).toEqual(['getProfile', 'sendInvite']);
  });

  it('returns false when nothing is due', async () => {
    const f = (current = await fixture());
    expect(await tick(new FakeProvider(silent), new Date(), f.db)).toBe(false);
  });
});

describe('tick: failure classification', () => {
  interface Expectation {
    actionStatus: string;
    accountStatus: string;
    sendingEnabled: number;
    checkpointSet: boolean;
    rescheduled: boolean;
  }

  const cases: [FailureClass, Expectation][] = [
    [
      'transient',
      {
        actionStatus: 'pending',
        accountStatus: 'active',
        sendingEnabled: 1,
        checkpointSet: false,
        rescheduled: true,
      },
    ],
    [
      'rate_limited',
      {
        actionStatus: 'pending',
        accountStatus: 'active',
        sendingEnabled: 1,
        checkpointSet: true,
        rescheduled: true,
      },
    ],
    [
      'checkpoint',
      {
        actionStatus: 'failed',
        accountStatus: 'checkpointed',
        sendingEnabled: 0,
        checkpointSet: true,
        rescheduled: false,
      },
    ],
    [
      'auth',
      {
        actionStatus: 'failed',
        accountStatus: 'disconnected',
        sendingEnabled: 0,
        checkpointSet: false,
        rescheduled: false,
      },
    ],
    [
      'invalid',
      {
        actionStatus: 'failed',
        accountStatus: 'active',
        sendingEnabled: 1,
        checkpointSet: false,
        rescheduled: false,
      },
    ],
    [
      'permanent',
      {
        actionStatus: 'failed',
        accountStatus: 'restricted',
        sendingEnabled: 0,
        checkpointSet: false,
        rescheduled: false,
      },
    ],
  ];

  it.each(cases)('%s', async (failureClass, expected) => {
    const f = (current = await fixture());
    const { actionId, due } = await queuedInvite(f);

    const provider = new FakeProvider({ ...silent, failWith: failureClass, sticky: true });
    await tick(provider, due, f.db);

    const action = await getAction(actionId, f.db);
    expect(action?.status, 'action status').toBe(expected.actionStatus);
    expect(action?.lastFailureClass).toBe(failureClass);
    expect(action?.lastError).toContain(failureClass);
    expect(action?.attempts).toBe(1);

    if (expected.rescheduled) {
      expect(action!.scheduledAt.getTime()).toBeGreaterThan(due.getTime());
      expect(action?.claimedAt).toBeNull();
    }

    const account = await getAccount(f.account.id, f.db);
    expect(account?.status, 'account status').toBe(expected.accountStatus);
    expect(account?.sendingEnabled ? 1 : 0, 'sending enabled').toBe(expected.sendingEnabled);
    expect(account?.checkpointUntil !== null, 'checkpoint set').toBe(expected.checkpointSet);

    // No invite may be recorded for a failed send — it would move the
    // acceptance rate on the strength of a send that never happened.
    const invites = f.db.prepare('SELECT COUNT(*) AS n FROM invites').get() as { n: number };
    expect(invites.n).toBe(0);
  });

  it('returns a terminally failed invite to the user rather than losing it', async () => {
    const f = (current = await fixture());
    const { due } = await queuedInvite(f);
    await tick(new FakeProvider({ ...silent, failWith: 'invalid' }), due, f.db);
    expect((await getSuggestion(f.suggestion.id, f.db))?.status).toBe('pending');
  });

  it('gives up after the attempt ceiling', async () => {
    const f = (current = await fixture());
    const { actionId, due } = await queuedInvite(f);
    const provider = new FakeProvider({ ...silent, failWith: 'transient', sticky: true });

    let now = due;
    for (let i = 0; i < LIMITS.MAX_ATTEMPTS + 2; i++) {
      const action = await getAction(actionId, f.db);
      if (!action || action.status === 'failed') break;
      now = new Date(action.scheduledAt.getTime() + 1000);
      await tick(provider, now, f.db);
    }

    const action = await getAction(actionId, f.db);
    expect(action?.status).toBe('failed');
    expect(action?.attempts).toBe(LIMITS.MAX_ATTEMPTS);
  });

  it('backs off further on each retry', async () => {
    const f = (current = await fixture());
    const { actionId, due } = await queuedInvite(f);
    const provider = new FakeProvider({ ...silent, failWith: 'transient', sticky: true });

    await tick(provider, due, f.db);
    const first = (await getAction(actionId, f.db))!;
    const firstDelay = first.scheduledAt.getTime() - due.getTime();

    const secondDue = new Date(first.scheduledAt.getTime() + 1000);
    await tick(provider, secondDue, f.db);
    const second = (await getAction(actionId, f.db))!;
    const secondDelay = second.scheduledAt.getTime() - secondDue.getTime();

    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it('classifies a non-ProviderError as transient rather than losing the action', async () => {
    const f = (current = await fixture());
    const { actionId, due } = await queuedInvite(f);

    const leaky = new FakeProvider(silent);
    leaky.sendInvite = async () => {
      throw new Error('some library blew up');
    };

    await tick(leaky, due, f.db);
    const action = await getAction(actionId, f.db);
    expect(action?.status).toBe('pending');
    expect(action?.lastFailureClass).toBe('transient');
  });
});

describe('tick: sending_enabled is checked before every send', () => {
  it('holds a claimed action when sending was disabled after it was queued', async () => {
    // Invariant 6. Between enqueue and execution the user may have paused, or
    // a checkpoint may have landed via webhook.
    const f = (current = await fixture());
    const { actionId, due } = await queuedInvite(f);

    await updateAccount(
      f.account.id,
      { sendingEnabled: false, pausedReason: 'Paused by you.' },
      f.db,
    );

    const provider = new FakeProvider(silent);
    expect(await tick(provider, due, f.db)).toBe(true);

    expect(provider.calls).toHaveLength(0);
    const action = await getAction(actionId, f.db);
    expect(action?.status).toBe('pending');
    expect(action?.scheduledAt.getTime()).toBeGreaterThan(due.getTime());
    expect(action?.lastError).toContain('Paused by you.');
  });

  it('holds while the account is cooling down', async () => {
    const f = (current = await fixture());
    const { actionId, due } = await queuedInvite(f);

    const until = new Date(due.getTime() + 3_600_000);
    await updateAccount(f.account.id, { checkpointUntil: until }, f.db);

    const provider = new FakeProvider(silent);
    await tick(provider, due, f.db);

    expect(provider.calls).toHaveLength(0);
    const action = await getAction(actionId, f.db);
    expect(action?.scheduledAt.getTime()).toBe(until.getTime());
  });

  it('does not send on a checkpointed account', async () => {
    const f = (current = await fixture());
    const { due } = await queuedInvite(f);
    await updateAccount(f.account.id, { status: 'checkpointed' }, f.db);

    const provider = new FakeProvider(silent);
    await tick(provider, due, f.db);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('tick: posts', () => {
  it('publishes and records the returned urn', async () => {
    const f = (current = await fixture());
    const result = await enqueue(
      {
        accountId: f.account.id,
        payload: { kind: 'create_post', postId: f.postId, text: 'hello world' },
        dedupeKey: `post:${f.postId}`,
      },
      f.db,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await tick(
      new FakeProvider(silent),
      new Date(result.action.scheduledAt.getTime() + 1000),
      f.db,
    );

    const post = f.db.prepare('SELECT status, urn FROM posts WHERE id = ?').get(f.postId) as {
      status: string;
      urn: string;
    };
    expect(post.status).toBe('published');
    expect(post.urn).toMatch(/^urn:fake:post:/);
  });

  it('marks the post failed when publishing fails terminally', async () => {
    const f = (current = await fixture());
    const result = await enqueue(
      {
        accountId: f.account.id,
        payload: { kind: 'create_post', postId: f.postId, text: 'hello world' },
        dedupeKey: `post:${f.postId}`,
      },
      f.db,
    );
    if (!result.ok) return;

    await tick(
      new FakeProvider({ ...silent, failWith: 'invalid' }),
      new Date(result.action.scheduledAt.getTime() + 1000),
      f.db,
    );

    const post = f.db.prepare('SELECT status FROM posts WHERE id = ?').get(f.postId) as {
      status: string;
    };
    expect(post.status).toBe('failed');
  });
});

describe('tick: already-connected guard', () => {
  it('does not send to an existing connection, and records no invite', async () => {
    // The provider returns 200 for an invite to a first-degree connection and
    // silently does nothing. Recording it would put a phantom invite in the
    // acceptance-rate denominator and throttle the account for no reason.
    const f = (current = await fixture());
    const { actionId, due } = await queuedInvite(f);

    const provider = new FakeProvider({
      ...silent,
      connectedTo: [f.person.providerPersonId],
    });
    await tick(provider, due, f.db);

    expect(provider.calls.map((c) => c.method)).toEqual(['getProfile']);
    const invites = f.db.prepare('SELECT COUNT(*) AS n FROM invites').get() as { n: number };
    expect(invites.n).toBe(0);

    const action = await getAction(actionId, f.db);
    expect(action?.status).toBe('failed');
    expect(action?.lastFailureClass).toBe('invalid');

    // The account is untouched — this is a bad request, not a bad account.
    const account = await getAccount(f.account.id, f.db);
    expect(account?.status).toBe('active');
    expect(account?.sendingEnabled).toBe(true);

    // And the person is off the list rather than back in the queue.
    expect((await getSuggestion(f.suggestion.id, f.db))?.status).toBe('dismissed');
  });

  it('sends normally when not connected', async () => {
    const f = (current = await fixture());
    const { due } = await queuedInvite(f);
    const provider = new FakeProvider({ ...silent, connectedTo: [] });
    await tick(provider, due, f.db);
    expect(provider.calls.map((c) => c.method)).toEqual(['getProfile', 'sendInvite']);
  });
});
