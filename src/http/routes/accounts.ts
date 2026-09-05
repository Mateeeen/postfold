import { Router } from 'express';
import { LIMITS } from '../../policy.js';
import { listAccounts, updateAccount } from '../../db/accounts.js';
import { getAccountState } from '../../state.js';
import { ownsAccount, resolveAccountId } from '../auth.js';
import { asyncHandler, badRequest, notFound, param, refused } from '../util.js';

export const accountsRouter = Router();

/**
 * Display constants the frontend needs, served from policy.ts.
 *
 * The fold position and the note limit are hardcoded nowhere else — invariant
 * 1 applies to the frontend too. A composer that thinks the fold is at 200
 * characters while policy says 210 is a composer that lies to the user.
 */
accountsRouter.get('/api/config', (_req, res) => {
  res.json({
    foldCharLimit: LIMITS.FOLD_CHAR_LIMIT,
    foldLineLimit: LIMITS.FOLD_LINE_LIMIT,
    noteLimit: LIMITS.MAX_NOTE_CHARS,
    hardDailyInviteCap: LIMITS.HARD_DAILY_INVITE_CAP,
  });
});

/** The whole header strip in one call. */
accountsRouter.get(
  '/api/accounts',
  asyncHandler(async (req, res) => {
    const accounts = await listAccounts(req.userId);
    const states = await Promise.all(accounts.map((a) => getAccountState(a.id)));
    res.json(states.filter(Boolean));
  }),
);

accountsRouter.get(
  '/api/accounts/:id',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id') === 'default' ? await resolveAccountId(req) : param(req, 'id');
    if (!id || !(await ownsAccount(req, id))) return notFound(res, 'No such account');
    const state = await getAccountState(id);
    if (!state) return notFound(res, 'No such account');
    res.json(state);
  }),
);

accountsRouter.post(
  '/api/accounts/:id/pause',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    if (!(await ownsAccount(req, id))) return notFound(res, 'No such account');

    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim() !== ''
        ? req.body.reason.trim()
        : 'Paused by you.';

    await updateAccount(id, { status: 'paused', sendingEnabled: false, pausedReason: reason });
    res.json(await getAccountState(id));
  }),
);

accountsRouter.post(
  '/api/accounts/:id/resume',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    if (!(await ownsAccount(req, id))) return notFound(res, 'No such account');

    const state = await getAccountState(id);
    if (!state) return notFound(res, 'No such account');

    // Resuming out of a checkpoint or a restriction is not ours to do. The
    // platform stopped this account; a button in our UI is not evidence that
    // whatever caused it has been dealt with.
    if (state.status === 'checkpointed' || state.status === 'restricted') {
      return refused(
        res,
        state.pausedReason ??
          'This account was stopped by LinkedIn. Resolve it on LinkedIn first, then reconnect here.',
      );
    }
    if (state.status === 'disconnected') {
      return refused(res, 'This account is disconnected. Reconnect it to resume sending.');
    }

    await updateAccount(id, {
      status: 'active',
      sendingEnabled: true,
      pausedReason: null,
      checkpointUntil: null,
    });
    res.json(await getAccountState(id));
  }),
);

/** Lower a daily cap. Raising one is not possible; see policy.budget(). */
accountsRouter.post(
  '/api/accounts/:id/cap',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    if (!(await ownsAccount(req, id))) return notFound(res, 'No such account');

    const value = req.body?.send_invite;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      return badRequest(res, 'send_invite must be a number or null');
    }

    await updateAccount(id, {
      dailyCapOverride: value === null ? null : { send_invite: Math.max(0, Math.floor(value)) },
    });
    res.json(await getAccountState(id));
  }),
);
