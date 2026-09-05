/**
 * Trend discovery and machine-drafted text.
 *
 * Shape mirrors engagers.ts: pull material, turn it into proposals, stop.
 * Nothing here publishes and nothing here enqueues — a draft becomes an action
 * only via approveDraft(), which goes through scheduler.enqueue() like
 * everything else (invariant 3).
 *
 * The one difference from the warm-connection pipeline is that a draft may
 * carry an `autoApproveAt`, after which the sweep approves it without a human.
 * That is a deliberate product decision; invariant 4 still holds absolutely
 * for connection requests, which can never be auto-approved.
 */

import { getAccount } from './db/accounts.js';
import { createPost, listPosts } from './db/content.js';
import {
  createDraft,
  getDraft,
  listEnabledTerms,
  setDraftStatus,
  undraftedPosts,
  upsertDiscoveredPost,
  addKeyword,
} from './db/drafts.js';
import type { Db } from './db/index.js';
import { getDb } from './db/index.js';
import type { AuthorContext, LlmProvider, SourcePost } from './llm.js';
import { getLlm } from './llm/index.js';
import { autoApproveAt, LIMITS } from './policy.js';
import type { SocialProvider } from './provider.js';
import { getProvider } from './providers/index.js';
import { enqueue } from './queue/scheduler.js';
import type { DiscoveredPost, Draft } from './types.js';

/** How many posts to pull per keyword, and how many to draft against. */
const POSTS_PER_KEYWORD = 10;
const COMMENT_DRAFTS_PER_SYNC = 3;

/**
 * The user's own voice, assembled from what they have actually published.
 * Without this the model writes generic LinkedIn prose; with it, drafts at
 * least start from how this person really writes.
 */
async function authorContext(accountId: string, db: Db): Promise<AuthorContext> {
  const account = await getAccount(accountId, db);
  if (!account) throw new Error(`Unknown account ${accountId}`);
  const posts = await listPosts(accountId, db);
  return {
    name: account.displayName,
    headline: null,
    recentPosts: posts
      .filter((p) => p.status === 'published')
      .slice(0, 5)
      .map((p) => p.text),
  };
}

/** How many existing comments to show the model. */
const PRIOR_COMMENTS_PER_POST = 8;

const toSourcePost = (
  p: DiscoveredPost,
  priorComments: SourcePost['priorComments'] = [],
): SourcePost => ({
  text: p.text,
  authorName: p.authorName,
  authorHeadline: p.authorHeadline,
  reactions: p.reactions,
  comments: p.comments,
  keyword: p.keyword,
  priorComments,
});

/* --- Keyword bootstrapping --------------------------------------------- */

/**
 * Ask the model for starting keywords, derived from the user's own profile
 * and posts. Stored as 'derived' so a later regenerate may replace them —
 * anything the user typed is 'user' and is never touched.
 */
export async function suggestKeywords(
  accountId: string,
  llm: LlmProvider = getLlm(),
  db: Db = getDb(),
): Promise<string[]> {
  const author = await authorContext(accountId, db);
  const suggestions = await llm.suggestKeywords({ author });
  for (const s of suggestions) await addKeyword(accountId, s.term, 'derived', db);
  return suggestions.map((s) => s.term);
}

/* --- Discovery ---------------------------------------------------------- */

/**
 * Pull posts for every enabled keyword and record them. Read-only at the
 * platform; the caps on this exist to avoid hammering search, not because
 * searching endangers the account.
 */
export async function syncTrends(
  input: { accountId: string; terms?: string[] },
  provider: SocialProvider = getProvider(),
  db: Db = getDb(),
): Promise<{ keywords: number; posts: number }> {
  const account = await getAccount(input.accountId, db);
  if (!account) throw new Error(`Unknown account ${input.accountId}`);

  const terms =
    input.terms && input.terms.length > 0
      ? input.terms
      : await listEnabledTerms(input.accountId, db);

  let posts = 0;
  for (const keyword of terms) {
    const found = await provider.searchPosts({
      providerAccountId: account.providerAccountId,
      keyword,
      window: 'day',
      limit: POSTS_PER_KEYWORD,
    });

    for (const f of found) {
      // Never treat the user's own post as a comment target.
      if (account.ownerPersonId && f.authorProviderId === account.ownerPersonId) continue;
      await upsertDiscoveredPost(
        {
          accountId: input.accountId,
          urn: f.urn,
          keyword,
          text: f.text,
          authorName: f.authorName,
          authorHeadline: f.authorHeadline,
          authorProviderId: f.authorProviderId,
          reactions: f.reactions,
          comments: f.comments,
          postedAt: f.postedAt,
          postUrl: f.postUrl,
          authorPublicIdentifier: f.authorPublicIdentifier,
        },
        db,
      );
      posts++;
    }
  }

  return { keywords: terms.length, posts };
}

/* --- Drafting ----------------------------------------------------------- */

export interface DraftOptions {
  /** When true the draft carries a deadline and publishes itself if ignored. */
  autoApprove: boolean;
}

/**
 * Draft comments for the highest-engagement posts we have not replied to.
 *
 * A draft the model declines to write is simply not created — the pipeline
 * producing nothing on a given run is a correct outcome, not a failure.
 */
export async function draftComments(
  input: { accountId: string; options: DraftOptions },
  llm: LlmProvider = getLlm(),
  db: Db = getDb(),
  provider: SocialProvider = getProvider(),
): Promise<{ drafted: number; declined: number }> {
  const account = await getAccount(input.accountId, db);
  if (!account) throw new Error(`Unknown account ${input.accountId}`);
  const author = await authorContext(input.accountId, db);
  const candidates = await undraftedPosts(input.accountId, COMMENT_DRAFTS_PER_SYNC, db);

  let drafted = 0;
  let declined = 0;
  const now = new Date();

  for (const post of candidates) {
    // What is already under the post. A failure here is not fatal — drafting
    // without the thread is worse, not impossible.
    let priorComments: SourcePost['priorComments'] = [];
    try {
      priorComments = await provider.getPostComments({
        providerAccountId: account.providerAccountId,
        postUrn: post.urn,
        limit: PRIOR_COMMENTS_PER_POST,
      });
    } catch (err) {
      console.warn(`[trends] could not read comments on ${post.urn}`, err);
    }

    const result = await llm.draftComment({
      author,
      post: toSourcePost(post, priorComments),
      maxChars: LIMITS.MAX_COMMENT_CHARS,
    });

    if (!result.worthCommenting || result.text.trim() === '') {
      declined++;
      continue;
    }

    await createDraft(
      {
        accountId: input.accountId,
        kind: 'comment',
        text: result.text,
        rationale: result.rationale,
        discoveredPostId: post.id,
        model: llm.model,
        autoApproveAt: input.options.autoApprove ? autoApproveAt(now) : null,
      },
      db,
    );
    drafted++;
  }

  return { drafted, declined };
}

/** Draft one post from whatever is currently landing in the user's niche. */
export async function draftPost(
  input: { accountId: string; options: DraftOptions },
  llm: LlmProvider = getLlm(),
  db: Db = getDb(),
): Promise<Draft | null> {
  const author = await authorContext(input.accountId, db);
  const trending = await undraftedPosts(input.accountId, 5, db);
  if (trending.length === 0) return null;

  const result = await llm.draftPost({
    author,
    trending: trending.map((p) => toSourcePost(p)),
    foldCharLimit: LIMITS.FOLD_CHAR_LIMIT,
  });

  return createDraft(
    {
      accountId: input.accountId,
      kind: 'post',
      text: result.text,
      rationale: result.rationale,
      model: llm.model,
      autoApproveAt: input.options.autoApprove ? autoApproveAt(new Date()) : null,
    },
    db,
  );
}

/* --- Approval ----------------------------------------------------------- */

export type ApproveResult =
  | { ok: true; actionId: string; scheduledAt: Date }
  | { ok: false; reason: string };

/**
 * Turn a draft into queued work. The single path from draft to action, for
 * both a human clicking approve and the timer firing — so budget, pacing and
 * the sending_enabled check apply identically either way. An auto-approved
 * draft gets no special dispensation from policy.
 */
export async function approveDraft(
  input: { draftId: string; by: 'user' | 'timer'; text?: string },
  db: Db = getDb(),
): Promise<ApproveResult> {
  const draft = await getDraft(input.draftId, db);
  if (!draft) return { ok: false, reason: 'That draft no longer exists.' };
  if (draft.status !== 'pending') {
    return { ok: false, reason: 'That draft has already been decided.' };
  }

  const text = (input.text ?? draft.text).trim();
  if (text === '') return { ok: false, reason: 'A draft needs some text.' };

  // A human at the keyboard gets it in minutes; the 24h timer keeps normal
  // pacing, because an auto-approved comment firing at 03:00 local is exactly
  // the pattern the send window exists to prevent.
  const urgency = input.by === 'user' ? ('soon' as const) : ('paced' as const);

  let result;
  if (draft.kind === 'post') {
    // A post draft becomes a real posts row at approval time, not at draft
    // time — an unapproved draft should never appear in the published list.
    const post = await createPost(draft.accountId, text, db);
    result = await enqueue(
      {
        accountId: draft.accountId,
        payload: { kind: 'create_post', postId: post.id, text },
        dedupeKey: `draft-post:${draft.id}`,
        urgency,
      },
      db,
    );
  } else {
    if (!draft.discoveredPostId) {
      return { ok: false, reason: 'This comment draft has lost the post it replied to.' };
    }
    result = await enqueue(
      {
        accountId: draft.accountId,
        payload: {
          kind: 'post_comment',
          draftId: draft.id,
          postUrn: await sourceUrn(draft, db),
          text,
        },
        dedupeKey: `draft-comment:${draft.id}`,
        urgency,
      },
      db,
    );
  }

  if (!result.ok) return { ok: false, reason: result.reason };

  await setDraftStatus(draft.id, 'queued', input.by, text, db);
  return { ok: true, actionId: result.action.id, scheduledAt: result.action.scheduledAt };
}

async function sourceUrn(draft: Draft, db: Db): Promise<string> {
  const row = db
    .prepare(`SELECT urn FROM discovered_posts WHERE id = ?`)
    .get(draft.discoveredPostId) as { urn: string } | undefined;
  if (!row) throw new Error(`Draft ${draft.id} has no source post`);
  return row.urn;
}

export async function dismissDraft(id: string, db: Db = getDb()): Promise<void> {
  await setDraftStatus(id, 'dismissed', 'user', null, db);
}
