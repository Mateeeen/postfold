import { Router } from 'express';
import { cancelAction, getAction, listPendingActions, listRecentActions } from '../../db/actions.js';
import { getPerson, setSuggestionStatus } from '../../db/content.js';
import { clearAutoApprove, setDraftStatus } from '../../db/drafts.js';
import { getAccountState } from '../../state.js';
import { resolveAccountId } from '../auth.js';
import { asyncHandler, notFound, param, refused } from '../util.js';
import type { Action } from '../../types.js';

export const queueRouter = Router();

/** Give the UI enough to label a row without a second round-trip. */
async function describe(action: Action): Promise<Record<string, unknown>> {
  const base = {
    id: action.id,
    kind: action.kind,
    status: action.status,
    scheduledAt: action.scheduledAt.toISOString(),
    completedAt: action.completedAt ? action.completedAt.toISOString() : null,
    attempts: action.attempts,
    lastError: action.lastError,
    lastFailureClass: action.lastFailureClass,
  };

  if (action.payload.kind === 'send_invite') {
    const person = await getPerson(action.payload.personId);
    return {
      ...base,
      label: person ? `Invite ${person.name}` : 'Invite',
      note: action.payload.note,
      person: person ? { name: person.name, headline: person.headline } : null,
    };
  }
  if (action.payload.kind === 'create_post') {
    return { ...base, label: 'Publish post', preview: action.payload.text.slice(0, 120) };
  }
  if (action.payload.kind === 'post_comment') {
    return {
      ...base,
      label: 'Post comment',
      preview: action.payload.text.slice(0, 120),
    };
  }
  if (action.payload.kind === 'sync_engagers') {
    return { ...base, label: 'Pull engagers' };
  }
  if (action.payload.kind === 'sync_replies') {
    return { ...base, label: 'Check replies' };
  }
  if (action.payload.kind === 'poll_acceptance') {
    return { ...base, label: 'Check accepted invites' };
  }
  if (action.payload.kind === 'sync_trends') {
    const terms = action.payload.terms;
    return {
      ...base,
      label: terms.length > 0 ? `Find posts (${terms.join(', ')})` : 'Find posts',
    };
  }

  // Exhaustiveness check. A new ActionKind now fails to compile here instead
  // of silently inheriting whatever label happened to be last in the chain —
  // which is exactly how sync_trends ended up displayed as "Pull engagers".
  const unreachable: never = action.payload;
  return { ...base, label: `Unknown action (${(unreachable as { kind: string }).kind})` };
}

queueRouter.get(
  '/api/queue',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');

    const [pending, recent] = await Promise.all([
      listPendingActions(accountId),
      listRecentActions(accountId, 25),
    ]);

    res.json({
      account: await getAccountState(accountId),
      pending: await Promise.all(pending.map(describe)),
      recent: await Promise.all(recent.map(describe)),
    });
  }),
);

queueRouter.delete(
  '/api/queue/:id',
  asyncHandler(async (req, res) => {
    const action = await getAction(param(req, 'id'));
    if (!action) return notFound(res, 'No such action');

    const accountId = await resolveAccountId(req);
    if (!accountId || accountId !== action.accountId) return notFound(res, 'No such action');

    // Only pending work can be cancelled. An in-flight action is already at
    // the provider; marking it cancelled here would tell the user we stopped
    // something we did not stop.
    const cancelled = await cancelAction(action.id);
    if (!cancelled) {
      return refused(
        res,
        action.status === 'in_flight'
          ? 'That action is already being sent and can no longer be cancelled.'
          : 'That action has already finished.',
      );
    }

    // Put the person back in front of the user rather than losing them.
    if (action.payload.kind === 'send_invite') {
      await setSuggestionStatus(action.payload.suggestionId, 'pending');
    }
    // Same for a cancelled comment: without this the draft stays 'queued'
    // forever — absent from the Drafts tab, and never offered again.
    if (action.payload.kind === 'post_comment') {
      await setDraftStatus(action.payload.draftId, 'pending', null, null);
      await clearAutoApprove(action.payload.draftId);
    }

    res.json({ ok: true, account: await getAccountState(accountId) });
  }),
);
