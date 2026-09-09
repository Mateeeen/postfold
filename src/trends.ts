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
  addKeyword,
  countDraftsSince,
  createDraft,
  getDiscoveredPost,
  getDraft,
  listEnabledTerms,
  recentDiscoveredPosts,
  setDraftStatus,
  undraftedPosts,
  upsertDiscoveredPost,
} from './db/drafts.js';
import type { Db } from './db/index.js';
import { getDb } from './db/index.js';
import type { AuthorContext, LlmProvider, SourcePost } from './llm.js';
import { getLlm } from './llm/index.js';
import type { ImageProvider } from './images.js';
import { getImages } from './images/index.js';
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
/** How many of the owner's own posts to use as voice samples. */
const VOICE_SAMPLES = 5;

/**
 * Who we are writing as.
 *
 * The samples come from the owner's real LinkedIn posts, not from the posts
 * published through this tool. The latter was the original source and it is
 * close to useless: a fresh install has none, so the drafter was told "no
 * samples available" and wrote in nobody's voice. That is what generic
 * drafts look like from the inside.
 *
 * A provider failure is not fatal. Falling back to locally published posts is
 * worse than the real thing and better than nothing, and drafting still has
 * the headline either way.
 */
async function authorContext(
  accountId: string,
  db: Db,
  provider: SocialProvider = getProvider(),
): Promise<AuthorContext> {
  const account = await getAccount(accountId, db);
  if (!account) throw new Error(`Unknown account ${accountId}`);

  let samples: string[] = [];
  if (account.ownerPersonId) {
    try {
      const authored = await provider.listAuthoredPosts({
        providerAccountId: account.providerAccountId,
        providerPersonId: account.ownerPersonId,
        limit: VOICE_SAMPLES * 2,
      });
      samples = authored
        // A repost is someone else's writing. As a voice sample it teaches
        // the drafter to imitate the wrong person.
        .filter((p) => !p.isRepost && p.text.trim() !== '')
        .slice(0, VOICE_SAMPLES)
        .map((p) => p.text);
    } catch (err) {
      console.warn(`[trends] could not read own posts for ${accountId}`, err);
    }
  }

  if (samples.length === 0) {
    const posts = await listPosts(accountId, db);
    samples = posts
      .filter((p) => p.status === 'published')
      .slice(0, VOICE_SAMPLES)
      .map((p) => p.text);
  }

  return {
    // The stored headline is the only line of context that says what field
    // this person is in. It was hardcoded null here while being fetched and
    // persisted correctly, so the drafter never knew.
    name: account.displayName,
    headline: account.headline,
    recentPosts: samples,
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
          authorAvatarUrl: f.authorAvatarUrl,
          attachments: f.attachments,
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
  const author = await authorContext(input.accountId, db, provider);
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
  input: { accountId: string; options: DraftOptions; idea?: string },
  llm: LlmProvider = getLlm(),
  db: Db = getDb(),
  images: ImageProvider = getImages(),
): Promise<Draft | null> {
  const author = await authorContext(input.accountId, db);
  const trending = await recentDiscoveredPosts(
    input.accountId,
    LIMITS.POST_CONTEXT_SAMPLES,
    new Date(Date.now() - LIMITS.POST_CONTEXT_WINDOW_MS),
    db,
  );
  if (trending.length === 0) return null;

  const result = await llm.draftPost({
    author,
    trending: trending.map((p) => toSourcePost(p)),
    foldCharLimit: LIMITS.FOLD_CHAR_LIMIT,
    idea: input.idea,
  });

  // An image is a bonus, never a precondition. If drawing fails the words are
  // still worth publishing, so the failure is logged and the draft goes on
  // without one.
  let image: { url: string; prompt: string } | null = null;
  try {
    // Prefer a trending post that carried an image: something that performed
    // visually is a better steer for what this subject looks like than one
    // that was text only.
    const visual = trending.find((p) => p.attachments.length > 0) ?? trending[0];
    const drawn = await images.draw({
      prompt: imagePromptFor(result.text, visual?.text),
    });
    if (drawn) image = { url: drawn.url, prompt: drawn.prompt };
  } catch (err) {
    console.warn('[trends] image generation failed; posting without one', err);
  }

  return createDraft(
    {
      accountId: input.accountId,
      kind: 'post',
      text: result.text,
      rationale: result.rationale,
      model: llm.model,
      autoApproveAt: input.options.autoApprove ? autoApproveAt(new Date()) : null,
      imageUrl: image?.url ?? null,
      imagePrompt: image?.prompt ?? null,
    },
    db,
  );
}

/**
 * What to draw for a post.
 *
 * Deliberately not "illustrate this post". Feeds are full of generated images
 * that try to depict an abstract claim literally and land somewhere between
 * stock photography and a fever dream. Asking for a restrained, abstract
 * treatment of the subject produces something that reads as considered, and
 * the negative instructions matter more than the positive ones: text rendered
 * into an image is the single clearest sign it was generated.
 */
export function imagePromptFor(postText: string, inspiration?: string): string {
  const subject = postText.replace(/\s+/g, ' ').trim().slice(0, 300);
  // What the field is currently posting about, taken from a trending post
  // that carried an image of its own. Not that image - no vision model is
  // available on this key, and a post's words describe its subject more
  // reliably than a caption of its picture would anyway.
  const echo = inspiration?.replace(/\s+/g, ' ').trim().slice(0, 200);
  return [
    'Editorial illustration for a professional article about:',
    subject,
    '',
    'Style: restrained abstract geometric composition, limited palette of two',
    'or three colours, generous negative space, matte finish, subtle grain.',
    'Feels like a considered magazine illustration.',
    'No text, no words, no letters, no numbers, no logos, no watermarks.',
    'No people, no faces, no hands. Not a photograph. Not clip art.',
    'No stock-photo handshakes, lightbulbs, rocket ships, or brains.',
    ...(echo
      ? [
          '',
          'A post doing well on this subject right now covers:',
          echo,
          'Draw the same territory, not that post.',
        ]
      : []),
  ].join('\n');
}

/**
 * The day's post, if today has not had one.
 *
 * One a day is the product's cadence, and it is enforced here rather than
 * left to the queue's create_post budget. The budget would refuse the second
 * post only after the model had already written it - paying for tokens and
 * putting a draft in front of the user that can never be sent.
 *
 * Counting drafts rather than published posts is deliberate: a draft the user
 * rejected still used today's slot. Otherwise rejecting one would immediately
 * produce a replacement, which is nagging rather than automation.
 *
 * Returns null when today is already spoken for. That is a normal outcome.
 */
export async function draftDailyPost(
  input: { accountId: string; options: DraftOptions },
  llm: LlmProvider = getLlm(),
  db: Db = getDb(),
  now: Date = new Date(),
  images: ImageProvider = getImages(),
): Promise<Draft | null> {
  const since = new Date(now.getTime() - LIMITS.DAILY_POST_INTERVAL_MS);
  if ((await countDraftsSince(input.accountId, 'post', since, db)) > 0) return null;
  return draftPost(input, llm, db, images);
}

/**
 * Draft a comment for one specific post, on request.
 *
 * draftComments() walks the whole candidate list; this is the same work for a
 * post the user is looking at right now. It deliberately does not check
 * whether a draft already exists - the caller asked for this one, and
 * refusing silently is how a button ends up doing nothing.
 */
export async function draftCommentFor(
  input: { accountId: string; discoveredPostId: string; options: DraftOptions },
  llm: LlmProvider = getLlm(),
  db: Db = getDb(),
  provider: SocialProvider = getProvider(),
): Promise<Draft | null> {
  const account = await getAccount(input.accountId, db);
  if (!account) throw new Error(`Unknown account ${input.accountId}`);

  const post = await getDiscoveredPost(input.discoveredPostId, db);
  if (!post) return null;

  const author = await authorContext(input.accountId, db, provider);

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

  if (!result.worthCommenting || result.text.trim() === '') return null;

  return createDraft(
    {
      accountId: input.accountId,
      kind: 'comment',
      text: result.text,
      rationale: result.rationale,
      discoveredPostId: post.id,
      model: llm.model,
      autoApproveAt: input.options.autoApprove ? autoApproveAt(new Date()) : null,
    },
    db,
  );
}

/** Angles worth writing about, from what the field is discussing right now. */
export async function postIdeas(
  accountId: string,
  count = 3,
  llm: LlmProvider = getLlm(),
  db: Db = getDb(),
): Promise<string[]> {
  const author = await authorContext(accountId, db);
  const trending = await recentDiscoveredPosts(
    accountId,
    LIMITS.POST_CONTEXT_SAMPLES,
    new Date(Date.now() - LIMITS.POST_CONTEXT_WINDOW_MS),
    db,
  );
  if (trending.length === 0) return [];
  return llm.suggestPostIdeas({
    author,
    trending: trending.map((p) => toSourcePost(p)),
    count,
  });
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
        payload: {
          kind: 'create_post',
          postId: post.id,
          text,
          imageUrl: draft.imageUrl,
        },
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
