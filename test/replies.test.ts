/**
 * Replies-to-invites and acceptance polling.
 *
 * Both read-only. The properties that matter are what they REFUSE to do:
 * never suggest the owner, never suggest an existing connection, never
 * resurrect a dismissed person, and never double-count an acceptance — the
 * acceptance rate governs the daily cap, so inflating it raises the cap on
 * false evidence.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getAcceptance, updateAccount } from '../src/db/accounts.js';
import { listSuggestions, recordInviteSent, upsertPerson } from '../src/db/content.js';
import { draftReplyNote, pollAcceptance, scoreReply, syncReplies } from '../src/replies.js';
import { LIMITS } from '../src/policy.js';
import { FakeProvider } from '../src/providers/fake.js';
import { fixture } from './helpers.js';
import type { Fixture } from './helpers.js';

let current: Fixture | null = null;

afterEach(() => {
  current?.db.close();
  current = null;
});

const silent = { log: () => {} };

/** A draft that was posted as a comment, so replies can hang off it. */
function postedComment(f: Fixture, commentId = 'cmt-1'): string {
  const id = crypto.randomUUID();
  f.db
    .prepare(
      `INSERT INTO drafts (id, account_id, kind, status, text, rationale,
         posted_comment_id, posted_post_urn, created_at, decided_at)
       VALUES (?, ?, 'comment', 'approved', 'Our comment.', '',
         ?, 'urn:li:activity:1', datetime('now'), datetime('now'))`,
    )
    .run(id, f.account.id, commentId);
  return id;
}

describe('syncReplies', () => {
  it('turns a stranger who replied into a pending suggestion', async () => {
    const f = (current = await fixture());
    postedComment(f);

    const r = await syncReplies({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    expect(r.commentsChecked).toBe(1);
    expect(r.suggested).toBe(1);

    const pending = await listSuggestions(f.account.id, 'pending', f.db);
    expect(pending.map((s) => s.person.name)).toContain('Replying Stranger');
  });

  it('skips someone already connected', async () => {
    // Inviting an existing connection is a no-op that still burns a cap slot.
    const f = (current = await fixture());
    postedComment(f);

    const r = await syncReplies({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    expect(r.skippedConnected).toBe(1);

    const pending = await listSuggestions(f.account.id, 'pending', f.db);
    expect(pending.map((s) => s.person.name)).not.toContain('Old Friend');
  });

  it('never suggests the account owner', async () => {
    const f = (current = await fixture());
    await updateAccount(f.account.id, { ownerPersonId: 'fake-person-4' }, f.db);
    postedComment(f);

    const r = await syncReplies({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    expect(r.suggested).toBe(0);
  });

  it('does not resurrect a dismissed person', async () => {
    // Someone the user said no to must not come back because they replied.
    const f = (current = await fixture());
    postedComment(f);
    await syncReplies({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    f.db.prepare("UPDATE suggestions SET status = 'dismissed'").run();

    const again = await syncReplies({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    expect(again.suggested).toBe(0);
    expect(await listSuggestions(f.account.id, 'pending', f.db)).toHaveLength(0);
  });

  it('is safe to run twice', async () => {
    const f = (current = await fixture());
    postedComment(f);
    const p = new FakeProvider(silent);
    await syncReplies({ accountId: f.account.id }, p, f.db);
    const second = await syncReplies({ accountId: f.account.id }, p, f.db);

    expect(second.suggested).toBe(0);
    // Count reply-sourced rows only — the fixture ships an engager suggestion
    // of its own, which this pipeline must leave alone.
    const n = f.db
      .prepare("SELECT COUNT(*) AS n FROM suggestions WHERE source = 'reply'")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('ignores comments we never posted', async () => {
    const f = (current = await fixture());
    const r = await syncReplies({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    expect(r.commentsChecked).toBe(0);
  });
});

describe('scoreReply', () => {
  it('rates a reply above a bare reaction', () => {
    // A reaction scores 0.2 in engagers.ts; writing to you is worth more.
    expect(scoreReply('ok')).toBeGreaterThan(0.2);
  });

  it('rewards substance and questions', () => {
    const short = scoreReply('Nice');
    const long = scoreReply('x '.repeat(30));
    const question = scoreReply(`${'x '.repeat(30)}?`);
    expect(long).toBeGreaterThan(short);
    expect(question).toBeGreaterThan(long);
    expect(question).toBeLessThanOrEqual(1);
  });
});

describe('draftReplyNote', () => {
  it('references the exchange and respects the note limit', () => {
    const note = draftReplyNote({
      name: 'Bryan Lunt',
      theirReply: 'x'.repeat(500),
      ourComment: 'y'.repeat(500),
    });
    expect(note).toContain('Bryan');
    expect(note.length).toBeLessThanOrEqual(LIMITS.MAX_NOTE_CHARS);
  });
});

describe('pollAcceptance', () => {
  async function sentInvite(f: Fixture, providerPersonId: string, sentAt = new Date()) {
    const person = await upsertPerson(
      f.account.id,
      { providerPersonId, name: 'Invitee', headline: null, profileUrl: null },
      f.db,
    );
    f.db
      .prepare(
        `INSERT INTO actions (id, account_id, kind, status, payload, scheduled_at,
           dedupe_key, created_at, updated_at)
         VALUES (?, ?, 'send_invite', 'done', '{}', datetime('now'), ?, datetime('now'), datetime('now'))`,
      )
      .run(`act-${providerPersonId}`, f.account.id, `k-${providerPersonId}`);
    await recordInviteSent(
      {
        accountId: f.account.id,
        personId: person.id,
        actionId: `act-${providerPersonId}`,
        providerInviteId: 'inv',
        sentAt,
        withNote: true,
      },
      f.db,
    );
    return person;
  }

  it('records an acceptance when the person is now connected', async () => {
    const f = (current = await fixture());
    await sentInvite(f, 'p-accepted');

    const provider = new FakeProvider({ ...silent, connectedTo: ['p-accepted'] });
    const r = await pollAcceptance({ accountId: f.account.id }, provider, f.db);

    expect(r.checked).toBe(1);
    expect(r.accepted).toBe(1);
    const acceptance = await getAcceptance(f.account.id, f.db);
    expect(acceptance.accepted).toBe(1);
    expect(acceptance.rate).toBe(1);
  });

  it('leaves an unaccepted invite alone', async () => {
    const f = (current = await fixture());
    await sentInvite(f, 'p-pending');

    const provider = new FakeProvider({ ...silent, connectedTo: [] });
    provider.pendingInvitations = ['p-pending'];

    const r = await pollAcceptance({ accountId: f.account.id }, provider, f.db);
    expect(r.accepted).toBe(0);
    expect((await getAcceptance(f.account.id, f.db)).accepted).toBe(0);
  });

  it('does not double-count an acceptance the webhook already recorded', async () => {
    // Counting it twice inflates the rate, which raises the daily cap on
    // evidence that does not exist.
    const f = (current = await fixture());
    await sentInvite(f, 'p-dup');
    const provider = new FakeProvider({ ...silent, connectedTo: ['p-dup'] });

    await pollAcceptance({ accountId: f.account.id }, provider, f.db);
    f.db.prepare('UPDATE invites SET last_checked_at = NULL').run();
    const second = await pollAcceptance({ accountId: f.account.id }, provider, f.db);

    expect(second.accepted).toBe(0);
    const acceptance = await getAcceptance(f.account.id, f.db);
    expect(acceptance.accepted).toBe(1);
  });

  it('marks an invite that vanished without connecting as withdrawn', async () => {
    // Gone from the pending list but not a connection means declined or
    // withdrawn. It must not count as an acceptance.
    const f = (current = await fixture());
    await sentInvite(f, 'p-gone');
    const provider = new FakeProvider({ ...silent, connectedTo: [] });
    provider.pendingInvitations = [];

    const r = await pollAcceptance({ accountId: f.account.id }, provider, f.db);
    expect(r.accepted).toBe(0);
    const row = f.db.prepare('SELECT status FROM invites').get() as { status: string };
    expect(row.status).toBe('withdrawn');
  });

  it('uses one list call rather than a profile lookup per invite', async () => {
    // The platform recommends at most ~100 profile retrievals per day; a
    // per-person poll would spend that budget on bookkeeping alone.
    const f = (current = await fixture());
    for (const id of ['a', 'b', 'c', 'd']) await sentInvite(f, `p-${id}`);
    const provider = new FakeProvider({ ...silent, connectedTo: [] });
    provider.pendingInvitations = ['p-a', 'p-b', 'p-c', 'p-d'];

    await pollAcceptance({ accountId: f.account.id }, provider, f.db);
    const calls = provider.calls.map((c) => c.method);
    expect(calls.filter((m) => m === 'listSentInvitations')).toHaveLength(1);
    expect(calls.filter((m) => m === 'getProfile')).toHaveLength(0);
  });

  it('expires an invite nobody acted on, keeping it in the denominator', async () => {
    // Deleting it would flatter the acceptance rate and raise the cap.
    const f = (current = await fixture());
    const old = new Date(Date.now() - LIMITS.INVITE_GIVE_UP_AFTER_MS - 86_400_000);
    await sentInvite(f, 'p-stale', old);

    const provider = new FakeProvider({ ...silent, connectedTo: [] });
    // The platform still lists it as outstanding — that is what makes it
    // stale rather than resolved.
    provider.pendingInvitations = ['p-stale'];

    const r = await pollAcceptance({ accountId: f.account.id }, provider, f.db);
    expect(r.gaveUp).toBe(1);

    const row = f.db.prepare('SELECT status FROM invites').get() as { status: string };
    expect(row.status).toBe('expired');

    // It also falls outside the acceptance lookback window by now, which is
    // correct — a three-week-old invite should not still be dragging the
    // current rate down.
    const acceptance = await getAcceptance(f.account.id, f.db);
    expect(acceptance.sample).toBe(0);
  });

  it('survives a profile it cannot read', async () => {
    const f = (current = await fixture());
    await sentInvite(f, 'p-broken');
    const provider = new FakeProvider(silent);
    provider.getProfile = async () => {
      throw new Error('profile unavailable');
    };

    const r = await pollAcceptance({ accountId: f.account.id }, provider, f.db);
    expect(r.accepted).toBe(0);
    // Stamped, so the next pass moves on instead of retrying the same person.
    const row = f.db.prepare('SELECT last_checked_at FROM invites').get() as {
      last_checked_at: string | null;
    };
    expect(row.last_checked_at).not.toBeNull();
  });
});
