/**
 * Seed one test account, one published post, and two engagers with pending
 * suggestions, so the queue can be exercised without any real credentials.
 *
 * Idempotent — safe to re-run.
 */

import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { createAccount, getAccount } from '../db/accounts.js';
import {
  createPost,
  markPostPublished,
  upsertPerson,
  recordEngagement,
  upsertSuggestion,
} from '../db/content.js';
import { openDatabase, setDb } from '../db/index.js';
import { draftNote, scoreEngager } from '../engagers.js';
import { LIMITS } from '../policy.js';

const SEED_PROVIDER_ACCOUNT = 'fake-account-1';
const SEED_POST_URN = 'urn:fake:post:seed-1';

async function main(): Promise<void> {
  const db = openDatabase(config.databasePath);
  setDb(db);

  const account = await createAccount(
    {
      userId: config.singleUserId,
      providerAccountId: SEED_PROVIDER_ACCOUNT,
      displayName: 'Test Creator',
      // Day 4 of warm-up: past the opening rung, so the ladder is visible in
      // the UI without waiting a week.
      connectedAt: new Date(Date.now() - 3 * 86_400_000),
      timezone: 'Europe/London',
      sendDays: [...LIMITS.DEFAULT_SEND_DAYS],
    },
    db,
  );

  const existingPost = db
    .prepare('SELECT id FROM posts WHERE urn = ?')
    .get(SEED_POST_URN) as { id: string } | undefined;

  const post = existingPost
    ? { id: existingPost.id, text: '' }
    : await createPost(
        account.id,
        "Most LinkedIn posts die at the fold.\n\nYou get about 210 characters before \"…see more\" swallows the rest. Everything that earns the click has to happen above that line — and almost nobody checks where the line actually falls.",
        db,
      );

  if (!existingPost) {
    await markPostPublished(post.id, SEED_POST_URN, new Date(Date.now() - 3_600_000), db);
  }

  const postText = (
    db.prepare('SELECT text FROM posts WHERE id = ?').get(post.id) as { text: string }
  ).text;

  const seedPeople = [
    {
      providerPersonId: 'fake-person-1',
      name: 'Dana Okafor',
      headline: 'Head of Growth at Meridian',
      profileUrl: 'https://www.linkedin.com/in/example-dana',
      kind: 'comment' as const,
      commentText:
        'The fold point is the thing nobody optimises for. How are you measuring where it actually lands?',
    },
    {
      providerPersonId: 'fake-person-2',
      name: 'Sam Ree',
      headline: 'Founder, Tinyshop',
      profileUrl: 'https://www.linkedin.com/in/example-sam',
      kind: 'reaction' as const,
      commentText: null,
    },
  ];

  const now = new Date();
  for (const sp of seedPeople) {
    const person = await upsertPerson(
      account.id,
      {
        providerPersonId: sp.providerPersonId,
        name: sp.name,
        headline: sp.headline,
        profileUrl: sp.profileUrl,
      },
      db,
    );

    const occurredAt = new Date(now.getTime() - 30 * 60_000);
    await recordEngagement(
      {
        postId: post.id,
        personId: person.id,
        kind: sp.kind,
        commentText: sp.commentText,
        occurredAt,
      },
      db,
    );

    const { score, reason } = scoreEngager({
      kind: sp.kind,
      commentText: sp.commentText,
      headline: person.headline,
      occurredAt,
      now,
    });

    await upsertSuggestion(
      {
        accountId: account.id,
        personId: person.id,
        postId: post.id,
        score,
        reason,
        draftNote: draftNote({
          person,
          kind: sp.kind,
          commentText: sp.commentText,
          postText,
        }),
      },
      db,
    );
  }

  const check = await getAccount(account.id, db);
  console.log(`Seeded account ${check?.id} (${check?.displayName}, tz ${check?.timezone})`);
  console.log(`  provider account id: ${SEED_PROVIDER_ACCOUNT}`);
  console.log(`  post: ${SEED_POST_URN}`);
  console.log(`  suggestions: ${seedPeople.length} pending`);
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
