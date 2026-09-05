import { Router } from 'express';
import { LIMITS } from '../../policy.js';
import {
  backfillNoteUsage,
  createAccount,
  listAccounts,
  updateAccount,
} from '../../db/accounts.js';
import { getAccountOwner, listConnectableAccounts } from '../../providers/index.js';
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

/**
 * Accounts linked at the provider that this instance could adopt.
 *
 * Onboarding has to be reachable over HTTP: on a deployed instance the
 * database lives on a volume the connect CLI cannot touch.
 */
accountsRouter.get(
  '/api/accounts/connectable',
  asyncHandler(async (req, res) => {
    const linked = await listConnectableAccounts();
    const existing = await listAccounts(req.userId);
    const known = new Set(existing.map((a) => a.providerAccountId));
    res.json({
      accounts: linked.map((a) => ({
        providerAccountId: a.providerAccountId,
        displayName: a.displayName,
        network: a.network,
        health: a.health,
        alreadyConnected: known.has(a.providerAccountId),
      })),
    });
  }),
);

/**
 * Adopt a linked provider account.
 *
 * Mirrors scripts/connect.ts deliberately: `connectedAt` is now, so the
 * warm-up ladder starts at day 1 on this instance regardless of how old the
 * platform account is, and sending starts OFF until a human turns it on.
 */
accountsRouter.post(
  '/api/accounts/connect',
  asyncHandler(async (req, res) => {
    const wanted =
      typeof req.body?.providerAccountId === 'string'
        ? req.body.providerAccountId.trim()
        : '';
    if (wanted === '') return badRequest(res, 'providerAccountId is required.');

    const timezone =
      typeof req.body?.timezone === 'string' && req.body.timezone.trim() !== ''
        ? req.body.timezone.trim()
        : 'UTC';

    const linked = await listConnectableAccounts();
    const target = linked.find((a) => a.providerAccountId === wanted);
    if (!target) return notFound(res, 'No linked account with that id.');

    const account = await createAccount({
      userId: req.userId,
      providerAccountId: target.providerAccountId,
      displayName: target.displayName,
      connectedAt: new Date(),
      timezone,
    });

    let ownerPersonId: string | null = null;
    let isPremium: boolean | null = null;
    let headline: string | null = null;
    try {
      const owner = await getAccountOwner(target.providerAccountId);
      ownerPersonId = owner?.providerPersonId ?? null;
      isPremium = owner?.isPremium ?? null;
      headline = owner?.headline ?? null;
    } catch {
      // Not fatal: self-filtering and tier-aware caps degrade, the account works.
    }

    await updateAccount(account.id, {
      ownerPersonId,
      isPremium,
      headline,
      sendingEnabled: false,
      status: target.health.status === 'active' ? 'paused' : target.health.status,
      pausedReason:
        'Newly connected. Check the account state, then press Resume to start sending.',
    });

    res.status(201).json(await getAccountState(account.id));
  }),
);

// NOTE: literal paths must be declared BEFORE '/api/accounts/:id', or
// Express matches them as an id — '/api/accounts/connectable' returned
// 404 'No such account' until this was ordered correctly.
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

/**
 * Record invites sent before this instance existed.
 *
 * Without this a fresh deployment believes the full monthly note allowance is
 * unspent, while the platform disagrees — and the difference is silently
 * overspending a limit that is only five on a free account.
 */
accountsRouter.post(
  '/api/accounts/:id/backfill-invites',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    if (!(await ownsAccount(req, id))) return notFound(res, 'No such account');

    const count = Number(req.body?.withNoteLast30d);
    if (!Number.isInteger(count) || count < 0 || count > 200) {
      return badRequest(res, 'withNoteLast30d must be an integer between 0 and 200.');
    }

    const inserted = await backfillNoteUsage(id, count);
    res.json({ inserted, account: await getAccountState(id) });
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
