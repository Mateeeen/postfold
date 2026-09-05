/**
 * Webhook signature verification and event handling.
 *
 * An unverified webhook can disable an account or move the acceptance rate,
 * which moves the daily cap. Rejecting a bad signature is not a formality.
 */

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getAccount, getAcceptance } from '../src/db/accounts.js';
import { recordInviteSent } from '../src/db/content.js';
import { unipileWebhooks } from '../src/providers/unipile.js';
import { handleEvent } from '../src/webhooks.js';
import { fixture } from './helpers.js';
import type { Fixture } from './helpers.js';

const SECRET = 'test-webhook-secret';

let current: Fixture | null = null;

afterEach(() => {
  current?.db.close();
  current = null;
});

function sign(body: string, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
}

/* ================================================================== *
 * Signature verification
 * ================================================================== */

describe('webhook signature verification', () => {
  const body = JSON.stringify({ event: 'new_relation', account_id: 'a' });

  it('accepts a correct signature', () => {
    expect(unipileWebhooks.verify(body, sign(body), SECRET)).toBe(true);
  });

  it('accepts a Buffer body identically', () => {
    expect(unipileWebhooks.verify(Buffer.from(body, 'utf8'), sign(body), SECRET)).toBe(true);
  });

  it('accepts a sha256= prefixed signature', () => {
    expect(unipileWebhooks.verify(body, `sha256=${sign(body)}`, SECRET)).toBe(true);
  });

  it('rejects a bad signature', () => {
    const wrong = sign(body).replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    expect(unipileWebhooks.verify(body, wrong, SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(unipileWebhooks.verify(body, sign(body, 'not-the-secret'), SECRET)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(unipileWebhooks.verify(body, null, SECRET)).toBe(false);
    expect(unipileWebhooks.verify(body, '', SECRET)).toBe(false);
  });

  it('rejects rather than throwing on a length mismatch', () => {
    // timingSafeEqual throws when the buffers differ in length; that must not
    // become a 500, which would look to the provider like a retryable error.
    expect(() => unipileWebhooks.verify(body, 'abc', SECRET)).not.toThrow();
    expect(unipileWebhooks.verify(body, 'abc', SECRET)).toBe(false);
  });

  it('rejects when the body has been altered in transit', () => {
    const signature = sign(body);
    const tampered = JSON.stringify({ event: 'new_relation', account_id: 'someone-else' });
    expect(unipileWebhooks.verify(tampered, signature, SECRET)).toBe(false);
  });

  it('is sensitive to whitespace, which is why the raw body is used', () => {
    const signature = sign(body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(unipileWebhooks.verify(reserialised, signature, SECRET)).toBe(false);
  });
});

/* ================================================================== *
 * Parsing
 * ================================================================== */

describe('webhook parsing', () => {
  it('parses an acceptance', () => {
    const event = unipileWebhooks.parse(
      JSON.stringify({
        event: 'new_relation',
        event_id: 'evt-1',
        account_id: 'acct',
        user_provider_id: 'person',
        date: '2026-01-01T00:00:00Z',
      }),
    );
    expect(event).toMatchObject({
      type: 'invite_accepted',
      providerAccountId: 'acct',
      providerPersonId: 'person',
      eventId: 'evt-1',
    });
  });

  it.each([
    ['CHECKPOINT', 'checkpointed'],
    ['CREDENTIALS', 'disconnected'],
    ['BLOCKED', 'restricted'],
    ['OK', 'active'],
  ])('maps account status %s to %s', (raw, expected) => {
    const event = unipileWebhooks.parse(
      JSON.stringify({ event: 'account_status', account_id: 'acct', status: raw }),
    );
    expect(event).toMatchObject({ type: 'account_status', status: expected });
  });

  it('returns unknown rather than throwing on unparseable input', () => {
    expect(unipileWebhooks.parse('not json at all')).toMatchObject({ type: 'unknown' });
  });

  it('returns unknown for an acceptance missing its person', () => {
    const event = unipileWebhooks.parse(
      JSON.stringify({ event: 'new_relation', account_id: 'acct' }),
    );
    expect(event.type).toBe('unknown');
  });
});

/* ================================================================== *
 * Handling
 * ================================================================== */

describe('handleEvent: acceptance', () => {
  async function withSentInvite(): Promise<Fixture> {
    const f = (current = await fixture());
    f.db
      .prepare(
        `INSERT INTO actions (id, account_id, kind, status, payload, scheduled_at, dedupe_key, created_at, updated_at)
         VALUES ('act-1', ?, 'send_invite', 'done', '{}', datetime('now'), 'seed', datetime('now'), datetime('now'))`,
      )
      .run(f.account.id);
    await recordInviteSent(
      {
        accountId: f.account.id,
        personId: f.person.id,
        actionId: 'act-1',
        providerInviteId: 'inv-1',
        sentAt: new Date(),
        withNote: true,
      },
      f.db,
    );
    return f;
  }

  it('moves the acceptance rate', async () => {
    const f = await withSentInvite();
    expect((await getAcceptance(f.account.id, f.db)).rate).toBe(0);

    const outcome = await handleEvent(
      {
        type: 'invite_accepted',
        providerAccountId: f.account.providerAccountId,
        providerPersonId: f.person.providerPersonId,
        occurredAt: new Date(),
        eventId: 'evt-1',
      },
      '{}',
      f.db,
    );

    expect(outcome.handled).toBe(true);
    const acceptance = await getAcceptance(f.account.id, f.db);
    expect(acceptance.accepted).toBe(1);
    expect(acceptance.rate).toBe(1);
  });

  it('ignores a replayed event', async () => {
    const f = await withSentInvite();
    const event = {
      type: 'invite_accepted' as const,
      providerAccountId: f.account.providerAccountId,
      providerPersonId: f.person.providerPersonId,
      occurredAt: new Date(),
      eventId: 'evt-1',
    };

    await handleEvent(event, '{}', f.db);
    const second = await handleEvent(event, '{}', f.db);

    expect(second.handled).toBe(false);
    expect(second.detail).toMatch(/duplicate/);
    // A replayed acceptance would inflate the rate and quietly raise the cap.
    expect((await getAcceptance(f.account.id, f.db)).accepted).toBe(1);
  });

  it('does not move the rate for a connection we did not send', async () => {
    const f = (current = await fixture());
    const outcome = await handleEvent(
      {
        type: 'invite_accepted',
        providerAccountId: f.account.providerAccountId,
        providerPersonId: f.person.providerPersonId,
        occurredAt: new Date(),
        eventId: 'evt-manual',
      },
      '{}',
      f.db,
    );

    expect(outcome.handled).toBe(true);
    expect(outcome.detail).toMatch(/acceptance rate unchanged/);
    expect((await getAcceptance(f.account.id, f.db)).sample).toBe(0);
  });

  it('ignores an event for an account we do not have', async () => {
    const f = (current = await fixture());
    const outcome = await handleEvent(
      {
        type: 'invite_accepted',
        providerAccountId: 'someone-elses-account',
        providerPersonId: 'x',
        occurredAt: new Date(),
        eventId: 'evt-x',
      },
      '{}',
      f.db,
    );
    expect(outcome.handled).toBe(false);
  });
});

describe('handleEvent: account status', () => {
  it('stops the account on a checkpoint before the worker walks into it', async () => {
    const f = (current = await fixture());

    await handleEvent(
      {
        type: 'account_status',
        providerAccountId: f.account.providerAccountId,
        status: 'checkpointed',
        reason: 'LinkedIn wants a verification code.',
        eventId: 'evt-cp',
      },
      '{}',
      f.db,
    );

    const account = await getAccount(f.account.id, f.db);
    expect(account?.status).toBe('checkpointed');
    expect(account?.sendingEnabled).toBe(false);
    expect(account?.pausedReason).toBe('LinkedIn wants a verification code.');
    expect(account?.checkpointUntil).not.toBeNull();
  });

  it('never re-enables sending from a webhook', async () => {
    // Recovering from a checkpoint requires a human. The platform saying
    // "you're fine now" is not evidence that the cause has been dealt with.
    const f = (current = await fixture());

    await handleEvent(
      {
        type: 'account_status',
        providerAccountId: f.account.providerAccountId,
        status: 'checkpointed',
        reason: null,
        eventId: 'evt-1',
      },
      '{}',
      f.db,
    );
    await handleEvent(
      {
        type: 'account_status',
        providerAccountId: f.account.providerAccountId,
        status: 'active',
        reason: null,
        eventId: 'evt-2',
      },
      '{}',
      f.db,
    );

    const account = await getAccount(f.account.id, f.db);
    expect(account?.sendingEnabled).toBe(false);
  });

  it('records the raw body for every event it accepts', async () => {
    const f = (current = await fixture());
    await handleEvent(
      {
        type: 'unknown',
        name: 'something.new',
        eventId: 'evt-unknown',
      },
      '{"raw":true}',
      f.db,
    );
    const row = f.db
      .prepare('SELECT body, type FROM webhook_events WHERE provider_event_id = ?')
      .get('evt-unknown') as { body: string; type: string };
    expect(row.body).toBe('{"raw":true}');
  });
});

describe('provider error classification', () => {
  // Classification decides whether we retry, whether the account is cooled
  // down, and whether a human is called. Reading the status code alone gets
  // the most consequential case wrong.
  const cases: [string, number, string, string][] = [
    [
      'a temporary provider limit is a rate limit, not a bad request',
      422,
      '{"type":"errors/cannot_resend_yet","detail":"You have reached a temporary provider limit."}',
      'rate_limited',
    ],
    [
      'an uninvitable recipient is genuinely invalid',
      422,
      '{"type":"errors/invalid_recipient","detail":"Recipient cannot be invited"}',
      'invalid',
    ],
    [
      'an unexpected server error is transient',
      500,
      '{"type":"errors/unexpected_error"}',
      'transient',
    ],
    [
      'a checkpoint in the body outranks the status code',
      422,
      '{"detail":"checkpoint required"}',
      'checkpoint',
    ],
    ['a 429 is a rate limit', 429, '{}', 'rate_limited'],
    ['a 401 is an auth failure', 401, '{}', 'auth'],
  ];

  it.each(cases)('%s', async (_label, status, body, expected) => {
    const { UnipileProvider } = await import('../src/providers/unipile.js');
    const provider = new UnipileProvider({
      baseUrl: 'https://example.invalid',
      apiKey: 'k',
      fetchImpl: (async () =>
        new Response(body, { status })) as unknown as typeof fetch,
    });

    await expect(
      provider.getAccountHealth({ providerAccountId: 'a' }),
    ).rejects.toMatchObject({ failureClass: expected });
  });
});
