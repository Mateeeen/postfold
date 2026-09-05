/**
 * The queue worker: claim -> execute -> classify -> back off.
 *
 * SINGLE WRITER. Postgres let us claim with `FOR UPDATE SKIP LOCKED`, which
 * SQLite has no equivalent for. Instead there is exactly one worker process,
 * and the claim runs inside BEGIN IMMEDIATE so it takes the write lock before
 * reading the row it is about to update. Running two of these against the same
 * database file is not a supported configuration — see README.md, "Scaling".
 *
 * Per-account concurrency is 1 regardless (invariant 5): the queue drains one
 * action at a time, paced by scheduled_at, because a burst of sends is exactly
 * the signal that gets an account restricted.
 */

import { getAccount, updateAccount } from '../db/accounts.js';
import { enqueue } from './scheduler.js';
import { LIMITS } from '../policy.js';
import {
  ACTION_COLUMNS,
  lastCompletedAt,
  listPendingActions,
  mapAction,
  markDone,
  markFailed,
  rescheduleAction,
} from '../db/actions.js';
import type { ActionRow } from '../db/actions.js';
import {
  getPost,
  getSuggestion,
  markEngagersSynced,
  markPostFailed,
  markPostPublished,
  recordInviteSent,
  setSuggestionStatus,
} from '../db/content.js';
import type { Db } from '../db/index.js';
import { encodeJson, getDb, immediateTransaction, nowIso } from '../db/index.js';
import { outcomeForFailure } from '../policy.js';
import { isProviderError, ProviderError } from '../provider.js';
import type { SocialProvider } from '../provider.js';
import { getProvider } from '../providers/index.js';
import { syncEngagersForPost } from '../engagers.js';
import { approveDraft, draftComments, syncTrends } from '../trends.js';
import { pollAcceptance, syncReplies } from '../replies.js';
import { dueForAutoApproval, getDraft, setDraftStatus } from '../db/drafts.js';
import type { Action, FailureClass } from '../types.js';

/**
 * Claim the next due action.
 *
 * `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` needs SQLite 3.35+.
 * The subselect rides the partial index on pending actions; without that index
 * this scans every terminal action the account has ever run.
 */
export async function claimNext(
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<Action | null> {
  const nowStr = now.toISOString();
  const row = immediateTransaction(db, () =>
    db
      .prepare(
        `UPDATE actions
            SET status = 'in_flight', claimed_at = @now, attempts = attempts + 1, updated_at = @now
          WHERE id = (
            SELECT id FROM actions
             WHERE status = 'pending' AND scheduled_at <= @now
             ORDER BY scheduled_at ASC
             LIMIT 1
          )
          RETURNING ${ACTION_COLUMNS}`,
      )
      .get({ now: nowStr }) as ActionRow | undefined,
  );
  return row ? mapAction(row) : null;
}

/** Attach a summary to a completed action. Best-effort; never fails the run. */
function recordResult(actionId: string, summary: unknown, db: Db): void {
  try {
    db.prepare('UPDATE actions SET result = ? WHERE id = ?').run(
      encodeJson(summary),
      actionId,
    );
  } catch (err) {
    console.warn('[worker] could not record action result', err);
  }
}

async function execute(
  action: Action,
  provider: SocialProvider,
  db: Db,
): Promise<void> {
  const account = await getAccount(action.accountId, db);
  if (!account) throw new Error(`Account ${action.accountId} disappeared`);

  const payload = action.payload;
  switch (payload.kind) {
    case 'create_post': {
      const res = await provider.publishPost({
        providerAccountId: account.providerAccountId,
        text: payload.text,
      });
      await markPostPublished(payload.postId, res.urn, res.publishedAt, db);
      return;
    }

    case 'send_invite': {
      // Re-check immediately before sending: hours may have passed since the
      // user approved, and they may have connected in the meantime. An invite
      // to an existing connection returns 200 and does nothing, so the only
      // way to avoid recording a phantom invite is to not send it.
      const profile = await provider.getProfile({
        providerAccountId: account.providerAccountId,
        providerPersonId: payload.providerPersonId,
      });
      if (profile.alreadyConnected || profile.isSelf) {
        await setSuggestionStatus(payload.suggestionId, 'dismissed', null, db);
        throw new ProviderError(
          profile.isSelf
            ? 'That is your own account.'
            : 'Already connected to this person; nothing was sent.',
          'invalid',
        );
      }

      const res = await provider.sendInvite({
        providerAccountId: account.providerAccountId,
        providerPersonId: payload.providerPersonId,
        note: payload.note,
      });
      await recordInviteSent(
        {
          accountId: action.accountId,
          personId: payload.personId,
          actionId: action.id,
          providerInviteId: res.providerInviteId,
          sentAt: res.sentAt,
          withNote: payload.note.trim().length > 0,
        },
        db,
      );
      return;
    }

    case 'post_comment': {
      const res = await provider.postComment({
        providerAccountId: account.providerAccountId,
        postUrn: payload.postUrn,
        text: payload.text,
      });
      await setDraftStatus(payload.draftId, 'approved', null, null, db);
      // Remember which comment this became, so its replies can be read later.
      db.prepare(
        'UPDATE drafts SET posted_comment_id = ?, posted_post_urn = ? WHERE id = ?',
      ).run(res.providerCommentId, payload.postUrn, payload.draftId);
      return;
    }

    case 'sync_replies': {
      const r = await syncReplies(
        { accountId: action.accountId, draftIds: payload.draftIds },
        provider,
        db,
      );
      recordResult(action.id, r, db);
      return;
    }

    case 'poll_acceptance': {
      const r = await pollAcceptance(
        { accountId: action.accountId, inviteIds: payload.inviteIds },
        provider,
        db,
      );
      recordResult(action.id, r, db);
      return;
    }

    case 'sync_trends': {
      const found = await syncTrends(
        { accountId: action.accountId, terms: payload.terms },
        provider,
        db,
      );
      // Drafting is a separate concern from discovery, and it calls a model
      // rather than the platform - a failure there must not mark the discovery
      // action failed and retry the search.
      let drafted = 0;
      let declined = 0;
      let draftError: string | null = null;
      try {
        const r = await draftComments(
          { accountId: action.accountId, options: { autoApprove: true } },
          undefined,
          db,
          provider,
        );
        drafted = r.drafted;
        declined = r.declined;
      } catch (err) {
        draftError = err instanceof Error ? err.message : String(err);
        console.error('[worker] drafting failed after a successful sync', err);
      }

      // Recorded so the UI can say what happened rather than leaving the user
      // to infer it from an empty list.
      recordResult(action.id, {
        keywords: found.keywords,
        postsFound: found.posts,
        drafted,
        declined,
        ...(draftError ? { error: draftError } : {}),
      }, db);
      return;
    }

    case 'sync_engagers': {
      await syncEngagersForPost(
        { accountId: action.accountId, postId: payload.postId },
        provider,
        db,
      );
      const post = await getPost(payload.postId, db);
      if (post) await markEngagersSynced(post.id, new Date(), db);
      return;
    }
  }
}

async function onFailure(
  action: Action,
  failureClass: FailureClass,
  message: string,
  retryAfterMs: number | null,
  // The clock is injected rather than read here. Backoff and cooldowns are
  // both measured from it, so a test that simulates a due time gets timings
  // relative to that time instead of relative to wall-clock now.
  now: Date,
  db: Db,
): Promise<void> {
  const outcome = outcomeForFailure(failureClass, action.attempts, retryAfterMs);

  if (outcome.accountStatus || outcome.disableSending || outcome.cooldownMs) {
    await updateAccount(
      action.accountId,
      {
        ...(outcome.accountStatus ? { status: outcome.accountStatus } : {}),
        ...(outcome.disableSending ? { sendingEnabled: false } : {}),
        ...(outcome.pausedReason ? { pausedReason: outcome.pausedReason } : {}),
        ...(outcome.cooldownMs
          ? { checkpointUntil: new Date(now.getTime() + outcome.cooldownMs) }
          : {}),
      },
      db,
    );
  }

  if (outcome.retry) {
    // Postgres computed this as `now() + ($2 || ' milliseconds')::interval`.
    // SQLite has no millisecond interval literal, so the timestamp is computed
    // here and bound as an ISO string.
    const retryAt = new Date(now.getTime() + outcome.retryDelayMs);
    await rescheduleAction(action.id, retryAt, failureClass, message, db);
    return;
  }

  await markFailed(action.id, failureClass, message, db);

  // Terminal failures leave the rest of the domain consistent.
  if (action.payload.kind === 'create_post') {
    await markPostFailed(action.payload.postId, db);
  }
  if (action.payload.kind === 'post_comment') {
    // Hand the draft back rather than losing it. The deadline is cleared:
    // something that already failed to send once must not silently try again
    // on a timer.
    const draft = await getDraft(action.payload.draftId, db);
    if (draft?.status === 'queued') {
      await setDraftStatus(action.payload.draftId, 'pending', null, null, db);
      db.prepare('UPDATE drafts SET auto_approve_at = NULL WHERE id = ?').run(
        action.payload.draftId,
      );
    }
  }
  if (action.payload.kind === 'send_invite') {
    // Put it back in front of the user rather than silently losing it — but
    // only if execution has not already decided its fate. A suggestion
    // dismissed because we turned out to be connected must stay dismissed.
    const suggestion = await getSuggestion(action.payload.suggestionId, db);
    if (suggestion?.status === 'queued') {
      await setSuggestionStatus(action.payload.suggestionId, 'pending', null, db);
    }
  }
}

/**
 * Run one action if one is due. Returns true when it did work.
 */
export async function tick(
  provider: SocialProvider = getProvider(),
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<boolean> {
  const action = await claimNext(now, db);
  if (!action) return false;

  // Invariant 6: sending_enabled is checked before EVERY send, not just at
  // enqueue time. Between enqueue and execution the user may have paused, or a
  // checkpoint may have landed via webhook.
  const account = await getAccount(action.accountId, db);
  if (!account || !account.sendingEnabled || account.status !== 'active') {
    const reason = account?.pausedReason ?? 'Sending is disabled for this account.';
    await rescheduleAction(
      action.id,
      new Date(now.getTime() + 15 * 60_000),
      'transient',
      `Held: ${reason}`,
      db,
    );
    return true;
  }
  if (account.checkpointUntil && account.checkpointUntil.getTime() > now.getTime()) {
    await rescheduleAction(
      action.id,
      account.checkpointUntil,
      'transient',
      'Held: account cooling down.',
      db,
    );
    return true;
  }

  try {
    await execute(action, provider, db);
    await markDone(action.id, db);
    if (action.payload.kind === 'send_invite') {
      await setSuggestionStatus(action.payload.suggestionId, 'approved', null, db);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isProviderError(err)) {
      await onFailure(action, err.failureClass, message, err.retryAfterMs, now, db);
    } else {
      // Anything that is not a ProviderError has leaked past the adapter.
      // Treat as transient (the safe reading) but it indicates a bug.
      console.error('[worker] unclassified error — adapter leak?', err);
      await onFailure(action, 'transient', message, null, now, db);
    }
  }
  return true;
}

/**
 * Promote drafts whose deadline has passed.
 *
 * Auto-approval goes through approveDraft() like a human click does, so it is
 * subject to exactly the same budget, pacing and sending_enabled checks. A
 * timer cannot push work past a cap that a person could not.
 *
 * A refusal leaves the draft pending WITHOUT its deadline: if policy says no
 * today, the draft goes back to waiting for a human rather than retrying
 * itself every minute until the cap resets.
 */
export async function sweepAutoApprovals(
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<{ approved: number; held: number }> {
  const due = await dueForAutoApproval(now, db);
  let approved = 0;
  let held = 0;

  for (const draft of due) {
    const result = await approveDraft({ draftId: draft.id, by: 'timer' }, db);
    if (result.ok) {
      approved++;
      console.log(`[sweep] auto-approved ${draft.kind} draft ${draft.id}`);
    } else {
      held++;
      db.prepare('UPDATE drafts SET auto_approve_at = NULL WHERE id = ?').run(draft.id);
      console.warn(`[sweep] held ${draft.id}: ${result.reason}`);
    }
  }

  return { approved, held };
}

/**
 * Keep the read-only background work ticking over.
 *
 * Acceptance polling in particular has to happen on its own: the daily invite
 * cap is derived from the acceptance rate, and without a webhook configured
 * nothing else would ever move that number. Scheduled through enqueue() like
 * everything else, so it inherits the jitter — Unipile's guidance is
 * explicitly "a few times a day with random delay, not at fixed time".
 */
export async function scheduleMaintenance(
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  const accounts = db
    .prepare("SELECT id FROM accounts WHERE sending_enabled = 1 OR status = 'active'")
    .all() as { id: string }[];

  for (const { id } of accounts) {
    const pending = await listPendingActions(id, db);

    if (!pending.some((a) => a.kind === 'poll_acceptance')) {
      const last = await lastCompletedAt(id, 'poll_acceptance', db);
      const due =
        !last || now.getTime() - last.getTime() >= LIMITS.ACCEPTANCE_POLL_INTERVAL_MS;
      const anyPending = db
        .prepare("SELECT COUNT(*) AS n FROM invites WHERE account_id = ? AND status = 'sent'")
        .get(id) as { n: number };

      // No outstanding invites means nothing to poll for.
      if (due && anyPending.n > 0) {
        await enqueue(
          {
            accountId: id,
            payload: { kind: 'poll_acceptance', inviteIds: [] },
            dedupeKey: `poll:${id}:${Math.floor(now.getTime() / LIMITS.ACCEPTANCE_POLL_INTERVAL_MS)}`,
            now,
          },
          db,
        );
      }
    }

    if (!pending.some((a) => a.kind === 'sync_replies')) {
      const last = await lastCompletedAt(id, 'sync_replies', db);
      const due =
        !last || now.getTime() - last.getTime() >= LIMITS.ACCEPTANCE_POLL_INTERVAL_MS;
      const haveComments = db
        .prepare(
          `SELECT COUNT(*) AS n FROM drafts
            WHERE account_id = ? AND posted_comment_id IS NOT NULL
              AND decided_at >= datetime('now','-14 days')`,
        )
        .get(id) as { n: number };

      if (due && haveComments.n > 0) {
        await enqueue(
          {
            accountId: id,
            payload: { kind: 'sync_replies', draftIds: [] },
            dedupeKey: `replies:${id}:${Math.floor(now.getTime() / LIMITS.ACCEPTANCE_POLL_INTERVAL_MS)}`,
            now,
          },
          db,
        );
      }
    }
  }
}

export interface WorkerHandle {
  stop: () => void;
}

/** Poll loop. One process only. */
export function startWorker(
  options: { intervalMs?: number; provider?: SocialProvider } = {},
): WorkerHandle {
  const intervalMs = options.intervalMs ?? 5_000;
  const provider = options.provider ?? getProvider();
  let stopped = false;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        // The sweep runs first: a draft that came due should enter the queue
        // before this pass drains it, not a poll interval later.
        await sweepAutoApprovals();
        await scheduleMaintenance();

        // Drain everything that is due, then sleep.
        let worked = true;
        while (worked && !stopped) worked = await tick(provider);
      } catch (err) {
        console.error('[worker] tick failed', err);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  void loop();
  console.log(`[worker] started at ${nowIso()} (provider: ${provider.name})`);
  return { stop: () => { stopped = true; } };
}
