import { Router } from 'express';
import { getAccount as getAccountByIdForSend } from '../../db/accounts.js';
import { getPerson, getSuggestion, listSuggestions, setSuggestionStatus } from '../../db/content.js';
import { LIMITS } from '../../policy.js';
import { getProvider } from '../../providers/index.js';
import { enqueue } from '../../queue/scheduler.js';
import { getAccountState } from '../../state.js';
import { resolveAccountId } from '../auth.js';
import { asyncHandler, badRequest, notFound, param, refused } from '../util.js';

export const suggestionsRouter = Router();

suggestionsRouter.get(
  '/api/suggestions',
  asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req);
    if (!accountId) return notFound(res, 'No account connected');

    const suggestions = await listSuggestions(accountId, 'pending');
    res.json({
      account: await getAccountState(accountId),
      suggestions: suggestions.map((s) => ({
        id: s.id,
        score: s.score,
        reason: s.reason,
        draftNote: s.draftNote,
        engagementKind: s.engagementKind,
        commentText: s.commentText,
        person: {
          id: s.person.id,
          name: s.person.name,
          headline: s.person.headline,
          profileUrl: s.person.profileUrl,
        },
      })),
      noteLimit: LIMITS.MAX_NOTE_CHARS,
    });
  }),
);

/**
 * Approve ONE suggestion, for one named person, with a note the user has seen.
 *
 * This is the only path from a suggestion to a connection request. There is no
 * bulk variant and there must never be one (invariant 4).
 */
suggestionsRouter.post(
  '/api/suggestions/:id/approve',
  asyncHandler(async (req, res) => {
    const suggestion = await getSuggestion(param(req, 'id'));
    if (!suggestion) return notFound(res, 'No such suggestion');
    if (suggestion.status !== 'pending') {
      return refused(res, 'That suggestion has already been decided.');
    }

    const accountId = await resolveAccountId(req);
    if (!accountId || accountId !== suggestion.accountId) {
      return notFound(res, 'No such suggestion');
    }

    const raw = req.body?.note;
    if (raw !== undefined && typeof raw !== 'string') {
      return badRequest(res, 'note must be a string');
    }
    const note = (typeof raw === 'string' ? raw : suggestion.draftNote).trim();
    if (note.length > LIMITS.MAX_NOTE_CHARS) {
      return badRequest(res, `Notes are limited to ${LIMITS.MAX_NOTE_CHARS} characters.`);
    }

    const person = await getPerson(suggestion.personId);
    if (!person) return notFound(res, 'No such person');

    // Sending an invite to an existing connection is not an API error — it
    // returns 200 and silently does nothing. Without this check we would
    // record an invite that can never be accepted, which drags the acceptance
    // rate down and throttles the account for no reason.
    const account = await getAccountByIdForSend(accountId);
    if (account) {
      try {
        const profile = await getProvider().getProfile({
          providerAccountId: account.providerAccountId,
          providerPersonId: person.providerPersonId,
        });
        if (profile.isSelf) {
          await setSuggestionStatus(suggestion.id, 'dismissed');
          return refused(res, 'That is your own account.');
        }
        if (profile.alreadyConnected) {
          await setSuggestionStatus(suggestion.id, 'dismissed');
          return refused(
            res,
            `You are already connected to ${person.name}. Nothing was sent.`,
          );
        }
      } catch {
        // A failed lookup must not block a legitimate invite; the worker
        // checks again immediately before sending.
      }
    }

    // Spend the monthly note allowance first, then fall back to note-less
    // invites — which carry a far higher platform ceiling. The note is dropped
    // rather than the invite refused, and the response says which happened so
    // the UI never has to guess.
    const state = await getAccountState(accountId);
    const noteAllowed = (state?.notesRemaining ?? 0) > 0;
    const sentNote = noteAllowed ? note : '';

    const result = await enqueue({
      accountId,
      payload: {
        kind: 'send_invite',
        suggestionId: suggestion.id,
        personId: person.id,
        providerPersonId: person.providerPersonId,
        note: sentNote,
      },
      // One invite per suggestion, forever, no matter how many times this
      // route is called.
      dedupeKey: `invite:${suggestion.id}`,
      urgency: 'soon',
    });

    if (!result.ok) {
      // The suggestion stays pending so the user can try again once the
      // account has room. The refusal text explains why it does not.
      return refused(res, result.reason);
    }

    await setSuggestionStatus(suggestion.id, 'queued', sentNote);
    res.status(202).json({
      action: { id: result.action.id, scheduledAt: result.action.scheduledAt },
      withNote: noteAllowed,
      account: await getAccountState(accountId),
    });
  }),
);

suggestionsRouter.post(
  '/api/suggestions/:id/dismiss',
  asyncHandler(async (req, res) => {
    const suggestion = await getSuggestion(param(req, 'id'));
    if (!suggestion) return notFound(res, 'No such suggestion');

    const accountId = await resolveAccountId(req);
    if (!accountId || accountId !== suggestion.accountId) {
      return notFound(res, 'No such suggestion');
    }

    await setSuggestionStatus(suggestion.id, 'dismissed');
    res.json({ ok: true });
  }),
);
