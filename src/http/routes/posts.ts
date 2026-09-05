import { Router } from 'express';
import { createPost, listPosts } from '../../db/content.js';
import { requestEngagerSync } from '../../engagers.js';
import { enqueue } from '../../queue/scheduler.js';
import { resolveAccountId } from '../auth.js';
import { asyncHandler, badRequest, notFound, param, refused } from '../util.js';

export const postsRouter = Router();

postsRouter.get(
  '/api/posts',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');
    res.json(await listPosts(accountId));
  }),
);

postsRouter.post(
  '/api/posts',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (text === '') return badRequest(res, 'A post needs some text.');

    const post = await createPost(accountId, text);

    // Everything goes through the scheduler, including our own posts: it is
    // the only writer to `actions` and the only thing that knows the budget.
    const result = await enqueue({
      accountId,
      payload: { kind: 'create_post', postId: post.id, text },
      dedupeKey: `post:${post.id}`,
      urgency: 'soon',
    });

    if (!result.ok) return refused(res, result.reason);
    res.status(201).json({ post, action: result.action });
  }),
);

postsRouter.post(
  '/api/posts/:urn/sync-engagers',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');

    const result = await requestEngagerSync({
      accountId,
      postUrn: decodeURIComponent(param(req, 'urn')),
    });

    if (!result.ok) return refused(res, result.reason);
    res.status(202).json({ action: result.action });
  }),
);
