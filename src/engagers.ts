/**
 * The warm-connection pipeline.
 *
 * After a post goes out we pull the people who engaged with it, rank them,
 * draft a short note for each, and stop. Suggestions are proposals. Nothing
 * here queues an invite, and nothing here may — a connection request is only
 * ever created by scheduler.enqueue(), called from the approve route, for one
 * named person the user explicitly approved. There is no bulk approve and no
 * auto approve (invariant 4).
 */

import { getPost, getPostByUrn, markEngagersSynced, recordEngagement, upsertPerson, upsertSuggestion } from './db/content.js';
import type { Db } from './db/index.js';
import { getDb } from './db/index.js';
import { getAccount } from './db/accounts.js';
import { LIMITS } from './policy.js';
import type { SocialProvider } from './provider.js';
import { getProvider } from './providers/index.js';
import { enqueue } from './queue/scheduler.js';
import type { EngagementKind, Person } from './types.js';

/* --- Ranking ----------------------------------------------------------- */

export interface RankInput {
  kind: EngagementKind;
  commentText: string | null;
  headline: string | null;
  occurredAt: Date;
  now: Date;
}

/**
 * Score a warm lead, 0..1.
 *
 * Someone who wrote a paragraph under your post is a materially better
 * connection than someone who tapped Like. The weights are a product judgement
 * about relevance, not a safety limit, which is why they live here and not in
 * policy.ts.
 */
export function scoreEngager(input: RankInput): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  if (input.kind === 'comment') {
    score += 0.5;
    const words = (input.commentText ?? '').trim().split(/\s+/).filter(Boolean).length;
    if (words >= 15) {
      score += 0.2;
      reasons.push('left a substantial comment');
    } else if (words >= 4) {
      score += 0.1;
      reasons.push('commented');
    } else {
      reasons.push('commented briefly');
    }
    if (/\?/.test(input.commentText ?? '')) {
      score += 0.1;
      reasons.push('asked a question');
    }
  } else {
    score += 0.2;
    reasons.push('reacted to your post');
  }

  if (input.headline && input.headline.trim() !== '') {
    score += 0.05;
  }

  const ageHours = (input.now.getTime() - input.occurredAt.getTime()) / 3_600_000;
  if (ageHours <= 24) {
    score += 0.15;
    reasons.push('engaged in the last day');
  } else if (ageHours <= 72) {
    score += 0.05;
  }

  return {
    score: Math.min(1, Number(score.toFixed(3))),
    reason: reasons.join(', ') || 'engaged with your post',
  };
}

/* --- Note drafting ----------------------------------------------------- */

function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? name;
  return first.replace(/[^\p{L}\p{N}'’-]/gu, '');
}

/**
 * Draft a short connection note. Deliberately plain: notes that read like
 * marketing copy are the ones that don't get accepted, and acceptance rate is
 * the number the whole account-safety model rides on.
 *
 * The user edits this before approving. It is a starting point, not output.
 */
export function draftNote(input: {
  person: Pick<Person, 'name' | 'headline'>;
  kind: EngagementKind;
  commentText: string | null;
  postText: string;
}): string {
  const name = firstName(input.person.name);
  const topic = input.postText
    .split('\n')[0]
    ?.trim()
    .replace(/[.!?]+$/, '')
    .slice(0, 60);

  let note: string;
  if (input.kind === 'comment' && input.commentText) {
    note = `Hi ${name} — thanks for the comment on my post about ${topic}. Good point, and I'd like to keep in touch.`;
  } else {
    note = `Hi ${name} — thanks for reading my post on ${topic}. Always glad to connect with people working on similar things.`;
  }

  if (note.length > LIMITS.MAX_NOTE_CHARS) {
    note = note.slice(0, LIMITS.MAX_NOTE_CHARS - 1).trimEnd() + '…';
  }
  return note;
}

/* --- Pipeline ---------------------------------------------------------- */

/**
 * Ask for a post's engagers to be pulled. Goes through the queue like
 * everything else, so the pull is paced and counted.
 */
export async function requestEngagerSync(
  input: { accountId: string; postUrn: string },
  db: Db = getDb(),
): Promise<ReturnType<typeof enqueue>> {
  const post = await getPostByUrn(input.postUrn, db);
  if (!post) {
    return Promise.resolve({
      ok: false as const,
      reason: 'That post is not in PostFold yet.',
      budget: null,
    });
  }

  // Don't re-pull the same post every time the user refreshes.
  if (
    post.engagersSyncedAt &&
    Date.now() - post.engagersSyncedAt.getTime() < LIMITS.ENGAGER_SYNC_MIN_INTERVAL_MS
  ) {
    return Promise.resolve({
      ok: false as const,
      reason: 'Engagers for this post were pulled recently. Try again shortly.',
      budget: null,
    });
  }

  return enqueue(
    {
      accountId: input.accountId,
      payload: { kind: 'sync_engagers', postId: post.id, postUrn: input.postUrn },
      dedupeKey: `sync:${post.id}:${Math.floor(Date.now() / LIMITS.ENGAGER_SYNC_MIN_INTERVAL_MS)}`,
      // User pressed a button; don't make them wait for the send window.
      urgency: 'soon',
    },
    db,
  );
}

/**
 * Pull engagers for one post and turn them into pending suggestions.
 * Called by the worker; safe to run repeatedly (every write is an upsert).
 */
export async function syncEngagersForPost(
  input: { accountId: string; postId: string },
  provider: SocialProvider = getProvider(),
  db: Db = getDb(),
): Promise<{ people: number; suggestions: number }> {
  const account = await getAccount(input.accountId, db);
  if (!account) throw new Error(`Unknown account ${input.accountId}`);

  const post = await getPost(input.postId, db);
  if (!post || !post.urn) {
    throw new Error(`Post ${input.postId} has not been published yet`);
  }

  const result = await provider.listEngagers({
    providerAccountId: account.providerAccountId,
    postUrn: post.urn,
  });

  const byProviderId = new Map<string, Person>();
  for (const p of result.people) {
    // Never suggest the account owner to themselves. Reacting to your own post
    // is ordinary behaviour and must not turn you into a connection card.
    if (account.ownerPersonId && p.providerPersonId === account.ownerPersonId) continue;
    byProviderId.set(p.providerPersonId, await upsertPerson(input.accountId, p, db));
  }

  const now = new Date();
  let suggestions = 0;

  for (const e of result.engagements) {
    const person = byProviderId.get(e.providerPersonId);
    if (!person) continue;

    await recordEngagement(
      {
        postId: post.id,
        personId: person.id,
        kind: e.kind,
        commentText: e.commentText,
        occurredAt: e.occurredAt,
      },
      db,
    );

    const { score, reason } = scoreEngager({
      kind: e.kind,
      commentText: e.commentText,
      headline: person.headline,
      occurredAt: e.occurredAt,
      now,
    });

    await upsertSuggestion(
      {
        accountId: input.accountId,
        personId: person.id,
        postId: post.id,
        score,
        reason,
        draftNote: draftNote({
          person,
          kind: e.kind,
          commentText: e.commentText,
          postText: post.text,
        }),
      },
      db,
    );
    suggestions++;
  }

  await markEngagersSynced(post.id, now, db);
  return { people: byProviderId.size, suggestions };
}
