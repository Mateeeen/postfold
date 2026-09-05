/**
 * The engager pipeline. The important property is what it REFUSES to turn
 * into a suggestion.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { updateAccount } from '../src/db/accounts.js';
import { listSuggestions } from '../src/db/content.js';
import { syncEngagersForPost } from '../src/engagers.js';
import { FakeProvider } from '../src/providers/fake.js';
import { fixture } from './helpers.js';
import type { Fixture } from './helpers.js';

let current: Fixture | null = null;

afterEach(() => {
  current?.db.close();
  current = null;
});

const silent = { log: () => {} };

describe('syncEngagersForPost', () => {
  it('turns engagers into pending suggestions', async () => {
    const f = (current = await fixture());
    const result = await syncEngagersForPost(
      { accountId: f.account.id, postId: f.postId },
      new FakeProvider(silent),
      f.db,
    );

    expect(result.people).toBe(2);
    const pending = await listSuggestions(f.account.id, 'pending', f.db);
    expect(pending.map((s) => s.person.name).sort()).toContain('Dana Okafor');
  });

  it('never suggests the account owner to themselves', async () => {
    // Reacting to your own post is ordinary behaviour. It must not produce a
    // connection card inviting you to connect with yourself.
    const f = (current = await fixture());
    await updateAccount(f.account.id, { ownerPersonId: 'fake-person-1' }, f.db);

    await syncEngagersForPost(
      { accountId: f.account.id, postId: f.postId },
      new FakeProvider(silent),
      f.db,
    );

    const people = f.db.prepare('SELECT provider_person_id FROM people').all() as {
      provider_person_id: string;
    }[];
    expect(people.map((p) => p.provider_person_id)).not.toContain('fake-person-1');

    // Assert on identity, not name: the fixture has an unrelated person who
    // happens to share a display name with one of the fake engagers.
    const pending = await listSuggestions(f.account.id, 'pending', f.db);
    expect(pending.every((s) => s.person.providerPersonId !== 'fake-person-1')).toBe(true);
  });

  it('is safe to run twice', async () => {
    const f = (current = await fixture());
    const provider = new FakeProvider(silent);
    await syncEngagersForPost({ accountId: f.account.id, postId: f.postId }, provider, f.db);
    await syncEngagersForPost({ accountId: f.account.id, postId: f.postId }, provider, f.db);

    const n = f.db.prepare('SELECT COUNT(*) AS n FROM engagements').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('does not resurrect a dismissed person', async () => {
    const f = (current = await fixture());
    const provider = new FakeProvider(silent);
    await syncEngagersForPost({ accountId: f.account.id, postId: f.postId }, provider, f.db);

    f.db.prepare("UPDATE suggestions SET status = 'dismissed'").run();
    await syncEngagersForPost({ accountId: f.account.id, postId: f.postId }, provider, f.db);

    const pending = await listSuggestions(f.account.id, 'pending', f.db);
    expect(pending).toHaveLength(0);
  });
});
