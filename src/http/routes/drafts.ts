import { Router } from 'express';
import {
  addKeyword,
  countPendingDrafts,
  deleteKeyword,
  getDraft,
  listDrafts,
  listKeywords,
  recentDiscoveredPosts,
  setKeywordEnabled,
} from '../../db/drafts.js';
import { LIMITS } from '../../policy.js';
import {
  lastCompletedAt,
  lastResult,
  listPendingActions,
  pullForward,
} from '../../db/actions.js';
import { enqueue } from '../../queue/scheduler.js';
import { getAccountState } from '../../state.js';
import { draftPost, postIdeas, approveDraft, dismissDraft, suggestKeywords } from '../../trends.js';
import { resolveAccountId } from '../auth.js';
import { asyncHandler, badRequest, notFound, param, refused } from '../util.js';

export const draftsRouter = Router();

/**
 * What the most recent search did. Answers "I pressed the button and nothing
 * appeared" without the user having to guess between: it never ran, it found
 * nothing, or it found posts the model declined to comment on.
 */
async function lastSearchSummary(accountId: string): Promise<{
  at: string;
  keywords: number;
  postsFound: number;
  drafted: number;
  declined: number;
  error: string | null;
} | null> {
  const last = await lastResult(accountId, 'sync_trends');
  if (!last) return null;
  const r = last.result ?? {};
  const num = (k: string): number => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return {
    at: last.at.toISOString(),
    keywords: num('keywords'),
    postsFound: num('postsFound'),
    drafted: num('drafted'),
    declined: num('declined'),
    error: typeof r['error'] === 'string' ? (r['error'] as string) : null,
  };
}

/* --- Drafts ------------------------------------------------------------ */

draftsRouter.get(
  '/api/drafts',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');

    const drafts = await listDrafts(accountId, 'pending');
    res.json({
      account: await getAccountState(accountId),
      // The countdown is the thing a user most needs to see; send the raw
      // timestamp and let the client render it live rather than freezing a
      // "in 3 hours" string at request time.
      drafts: drafts.map((d) => ({
        id: d.id,
        kind: d.kind,
        text: d.text,
        rationale: d.rationale,
        model: d.model,
        createdAt: d.createdAt.toISOString(),
        autoApproveAt: d.autoApproveAt ? d.autoApproveAt.toISOString() : null,
        imageUrl: d.imageUrl,
        sourcePost: d.sourcePost
          ? {
              urn: d.sourcePost.urn,
              text: d.sourcePost.text,
              authorName: d.sourcePost.authorName,
              authorHeadline: d.sourcePost.authorHeadline,
              reactions: d.sourcePost.reactions,
              comments: d.sourcePost.comments,
              keyword: d.sourcePost.keyword,
              // Constructed only when the platform gave us nothing; its own
              // share_url uses a different URN form than social_id, so we
              // never derive over the top of a real one.
              postUrl:
                d.sourcePost.postUrl ??
                `https://www.linkedin.com/feed/update/${d.sourcePost.urn}/`,
              authorUrl: d.sourcePost.authorPublicIdentifier
                ? `https://www.linkedin.com/in/${d.sourcePost.authorPublicIdentifier}`
                : null,
              authorAvatarUrl: d.sourcePost.authorAvatarUrl,
              postedAt: d.sourcePost.postedAt ? d.sourcePost.postedAt.toISOString() : null,
              attachments: d.sourcePost.attachments,
            }
          : null,
      })),
      commentLimit: LIMITS.MAX_COMMENT_CHARS,
      foldCharLimit: LIMITS.FOLD_CHAR_LIMIT,
      lastSearch: await lastSearchSummary(accountId),
      searchPending: (await listPendingActions(accountId)).some(
        (a) => a.kind === 'sync_trends',
      ),
    });
  }),
);

draftsRouter.post(
  '/api/drafts/:id/approve',
  asyncHandler(async (req, res) => {
    const draft = await getDraft(param(req, 'id'));
    if (!draft) return notFound(res, 'No such draft');

    const accountId = await resolveAccountId(req);
    if (!accountId || accountId !== draft.accountId) return notFound(res, 'No such draft');

    const raw = req.body?.text;
    if (raw !== undefined && typeof raw !== 'string') {
      return badRequest(res, 'text must be a string');
    }
    if (draft.kind === 'comment' && typeof raw === 'string' && raw.length > LIMITS.MAX_COMMENT_CHARS) {
      return badRequest(res, `Comments are limited to ${LIMITS.MAX_COMMENT_CHARS} characters.`);
    }

    const result = await approveDraft({
      draftId: draft.id,
      by: 'user',
      ...(typeof raw === 'string' ? { text: raw } : {}),
    });
    if (!result.ok) return refused(res, result.reason);

    res.status(202).json({
      action: { id: result.actionId, scheduledAt: result.scheduledAt },
      account: await getAccountState(accountId),
    });
  }),
);

draftsRouter.post(
  '/api/drafts/:id/dismiss',
  asyncHandler(async (req, res) => {
    const draft = await getDraft(param(req, 'id'));
    if (!draft) return notFound(res, 'No such draft');

    const accountId = await resolveAccountId(req);
    if (!accountId || accountId !== draft.accountId) return notFound(res, 'No such draft');

    await dismissDraft(draft.id);
    res.json({ ok: true });
  }),
);

/* --- Keywords ----------------------------------------------------------- */

draftsRouter.get(
  '/api/keywords',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');
    res.json({
      keywords: await listKeywords(accountId),
      pendingDrafts: await countPendingDrafts(accountId),
    });
  }),
);

draftsRouter.post(
  '/api/keywords',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');

    const term = typeof req.body?.term === 'string' ? req.body.term.trim() : '';
    if (term === '') return badRequest(res, 'A keyword needs some text.');
    if (term.length > 100) return badRequest(res, 'That keyword is too long.');

    await addKeyword(accountId, term, 'user');
    res.status(201).json({ keywords: await listKeywords(accountId) });
  }),
);

draftsRouter.post(
  '/api/keywords/suggest',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');
    // Only ever adds 'derived' terms; anything the user typed is untouched.
    const terms = await suggestKeywords(accountId);
    res.json({ added: terms, keywords: await listKeywords(accountId) });
  }),
);

draftsRouter.post(
  '/api/keywords/:id/toggle',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');
    const enabled = req.body?.enabled !== false;
    await setKeywordEnabled(param(req, 'id'), enabled);
    res.json({ keywords: await listKeywords(accountId) });
  }),
);

draftsRouter.delete(
  '/api/keywords/:id',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');
    await deleteKeyword(param(req, 'id'));
    res.json({ keywords: await listKeywords(accountId) });
  }),
);

/* --- Trend sync --------------------------------------------------------- */

/** Angles worth writing about. Cheap and disposable; the user picks one. */
draftsRouter.get(
  '/api/ideas',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');
    res.json({ ideas: await postIdeas(accountId) });
  }),
);

/**
 * The posts worth engaging with, newest and most-engaged first.
 *
 * The same discovered posts the comment drafter works from, surfaced as a feed
 * rather than only as the drafts that came out of it - seeing what was found
 * is how you tell whether the keywords are any good.
 */
draftsRouter.get(
  '/api/feed',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');

    const posts = await recentDiscoveredPosts(
      accountId,
      20,
      new Date(Date.now() - LIMITS.POST_CONTEXT_WINDOW_MS),
    );

    res.json({
      posts: posts.map((p) => ({
        id: p.id,
        urn: p.urn,
        text: p.text,
        keyword: p.keyword,
        authorName: p.authorName,
        authorHeadline: p.authorHeadline,
        authorAvatarUrl: p.authorAvatarUrl,
        authorUrl: p.authorPublicIdentifier
          ? `https://www.linkedin.com/in/${p.authorPublicIdentifier}`
          : null,
        reactions: p.reactions,
        comments: p.comments,
        postedAt: p.postedAt ? p.postedAt.toISOString() : null,
        postUrl: p.postUrl ?? `https://www.linkedin.com/feed/update/${p.urn}/`,
        attachments: p.attachments,
      })),
    });
  }),
);

/**
 * Write a post now, on request.
 *
 * Deliberately bypasses the once-a-day guard. That guard exists to stop the
 * automation nagging - drafting a replacement the moment you reject one - and
 * it counts drafts rather than publishes for exactly that reason. Neither
 * concern applies when a person presses a button and waits for the result.
 * The queue's create_post budget still caps what can actually be published.
 */
draftsRouter.post(
  '/api/drafts/post-now',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');

    const idea =
      typeof req.body?.idea === 'string' && req.body.idea.trim() !== ''
        ? req.body.idea.trim()
        : undefined;

    const draft = await draftPost({ accountId, options: { autoApprove: false }, idea });
    if (!draft) {
      return refused(
        res,
        'No recent posts to work from yet. Run a search first so there is something to react to.',
      );
    }
    res.status(201).json({ draft });
  }),
);

draftsRouter.post(
  '/api/trends/sync',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');

    // A search already waiting is the answer to "search now" — say when.
    const pending = (await listPendingActions(accountId)).find(
      (a) => a.kind === 'sync_trends',
    );
    if (pending) {
      // The automation queues its own search, often for tomorrow's window.
      // Refusing on that basis makes the button dead through no fault of the
      // user, so bring the queued one forward instead of turning them away.
      // Searching is read-only, so there is no pacing reason to make them wait.
      const moved = await pullForward(pending.id, new Date());
      return res.status(202).json({
        created: false,
        action: {
          id: pending.id,
          scheduledAt: moved ? new Date().toISOString() : pending.scheduledAt.toISOString(),
        },
      });
    }

    // Rate-limit the button explicitly rather than leaning on a dedupe key —
    // a deduped enqueue looks identical to a successful one, which is how this
    // button previously did nothing without saying so.
    const last = await lastCompletedAt(accountId, 'sync_trends');
    if (last) {
      const waited = Date.now() - last.getTime();
      if (waited < LIMITS.TREND_SYNC_MIN_INTERVAL_MS) {
        const mins = Math.ceil((LIMITS.TREND_SYNC_MIN_INTERVAL_MS - waited) / 60_000);
        return refused(
          res,
          `Searched ${Math.round(waited / 60_000)} minutes ago. You can search again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        );
      }
    }

    const result = await enqueue({
      accountId,
      payload: { kind: 'sync_trends', terms: [] },
      dedupeKey: `trends:${accountId}:${Date.now()}`,
      urgency: 'soon',
    });

    if (!result.ok) return refused(res, result.reason);
    res.status(202).json({
      created: result.created,
      action: { id: result.action.id, scheduledAt: result.action.scheduledAt },
    });
  }),
);
