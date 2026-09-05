/**
 * Test fixtures. Every test gets its own in-memory database, migrated from the
 * real db/*.sql — so a schema change that breaks the app breaks the tests too.
 */

import { createAccount, updateAccount } from '../src/db/accounts.js';
import { createPost, markPostPublished, upsertPerson, upsertSuggestion } from '../src/db/content.js';
import { openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { migrate } from '../src/scripts/migrate.js';
import type { Account, Person, Suggestion } from '../src/types.js';

export function freshDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db, 'db');
  return db;
}

export interface Fixture {
  db: Db;
  account: Account;
  person: Person;
  suggestion: Suggestion;
  postId: string;
}

export async function fixture(
  options: { connectedDaysAgo?: number; timezone?: string; premium?: boolean } = {},
): Promise<Fixture> {
  const db = freshDb();

  const account = await createAccount(
    {
      userId: 'user_test',
      providerAccountId: 'provider-acct-1',
      displayName: 'Test Creator',
      // Default to a mature account so warm-up is not the thing under test
      // unless a test asks for it.
      connectedAt: new Date(Date.now() - (options.connectedDaysAgo ?? 60) * 86_400_000),
      timezone: options.timezone ?? 'UTC',
    },
    db,
  );

  // Default to premium so tests exercise our own caps; the free-tier note
  // ceiling (5/month) is lower than anything else and has dedicated tests.
  await updateAccount(account.id, { isPremium: options.premium ?? true }, db);

  const post = await createPost(account.id, 'Most LinkedIn posts die at the fold.', db);
  await markPostPublished(post.id, 'urn:test:post:1', new Date(), db);

  const person = await upsertPerson(
    account.id,
    {
      providerPersonId: 'provider-person-1',
      name: 'Dana Okafor',
      headline: 'Head of Growth at Meridian',
      profileUrl: null,
    },
    db,
  );

  await upsertSuggestion(
    {
      accountId: account.id,
      personId: person.id,
      postId: post.id,
      score: 0.9,
      reason: 'left a substantial comment',
      draftNote: 'Hi Dana — thanks for the comment.',
    },
    db,
  );

  const suggestion = db
    .prepare(
      `SELECT id, account_id, person_id, post_id, score, reason, draft_note, status,
              created_at, decided_at
         FROM suggestions WHERE account_id = ?`,
    )
    .get(account.id) as {
    id: string;
    account_id: string;
    person_id: string;
    post_id: string;
    score: number;
    reason: string;
    draft_note: string;
    status: string;
    created_at: string;
    decided_at: string | null;
  };

  return {
    db,
    account,
    person,
    postId: post.id,
    suggestion: {
      id: suggestion.id,
      accountId: suggestion.account_id,
      personId: suggestion.person_id,
      postId: suggestion.post_id,
      score: suggestion.score,
      reason: suggestion.reason,
      draftNote: suggestion.draft_note,
      status: suggestion.status as Suggestion['status'],
      createdAt: new Date(suggestion.created_at),
      decidedAt: null,
    },
  };
}

/** Add another person + pending suggestion, for multi-approval tests. */
export async function addSuggestion(
  f: Fixture,
  n: number,
): Promise<{ person: Person; suggestionId: string }> {
  const person = await upsertPerson(
    f.account.id,
    {
      providerPersonId: `provider-person-${n}`,
      name: `Person ${n}`,
      headline: null,
      profileUrl: null,
    },
    f.db,
  );
  await upsertSuggestion(
    {
      accountId: f.account.id,
      personId: person.id,
      postId: f.postId,
      score: 0.5,
      reason: 'reacted to your post',
      draftNote: `Hi Person ${n}.`,
    },
    f.db,
  );
  const row = f.db
    .prepare('SELECT id FROM suggestions WHERE person_id = ?')
    .get(person.id) as { id: string };
  return { person, suggestionId: row.id };
}

/** The invite payload for a given suggestion/person pair. */
export function invitePayload(
  suggestionId: string,
  person: Person,
  note = 'Hi there.',
): {
  kind: 'send_invite';
  suggestionId: string;
  personId: string;
  providerPersonId: string;
  note: string;
} {
  return {
    kind: 'send_invite',
    suggestionId,
    personId: person.id,
    providerPersonId: person.providerPersonId,
    note,
  };
}
