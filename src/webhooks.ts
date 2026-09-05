/**
 * Inbound provider events.
 *
 * The vendor's JSON is translated into an `InboundEvent` by the adapter before
 * it gets here; this file only knows our own event union. What it does with
 * them matters for safety:
 *
 *  - `invite_accepted` moves the acceptance rate, which moves the daily cap.
 *  - `account_status` is how a checkpoint reaches us BEFORE the worker walks
 *    into it. Acting on it immediately is the difference between one failed
 *    action and a restricted account.
 */

import { getAcceptance, updateAccount } from './db/accounts.js';
import type { AccountRow } from './db/accounts.js';
import { getPostByUrn, markInviteAccepted } from './db/content.js';
import type { Db } from './db/index.js';
import { getDb, newId, nowIso } from './db/index.js';
import { LIMITS } from './policy.js';
import type { InboundEvent } from './provider.js';

export interface WebhookOutcome {
  handled: boolean;
  detail: string;
}

function accountByProviderId(db: Db, providerAccountId: string): AccountRow | undefined {
  return db
    .prepare(
      `SELECT id, user_id, provider_account_id, display_name, status, sending_enabled,
              paused_reason, connected_at, timezone, send_days, window_start_hour,
              window_end_hour, daily_cap_override, checkpoint_until, owner_person_id
         FROM accounts WHERE provider_account_id = ?`,
    )
    .get(providerAccountId) as AccountRow | undefined;
}

/**
 * Record the raw event first, then handle it. Returns false when we have seen
 * this event id before — providers retry, and a replayed acceptance would
 * inflate the acceptance rate and quietly raise the daily cap.
 */
function recordEvent(db: Db, event: InboundEvent, rawBody: string): boolean {
  if (!event.eventId) {
    db.prepare(
      `INSERT INTO webhook_events (id, provider_event_id, type, body, received_at)
       VALUES (?, NULL, ?, ?, ?)`,
    ).run(newId(), event.type, rawBody, nowIso());
    return true;
  }
  const info = db
    .prepare(
      `INSERT INTO webhook_events (id, provider_event_id, type, body, received_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provider_event_id) DO NOTHING`,
    )
    .run(newId(), event.eventId, event.type, rawBody, nowIso());
  return info.changes > 0;
}

export async function handleEvent(
  event: InboundEvent,
  rawBody: string,
  db: Db = getDb(),
): Promise<WebhookOutcome> {
  if (!recordEvent(db, event, rawBody)) {
    return { handled: false, detail: 'duplicate event, ignored' };
  }

  switch (event.type) {
    case 'invite_accepted': {
      const account = accountByProviderId(db, event.providerAccountId);
      if (!account) return { handled: false, detail: 'unknown account' };

      const matched = await markInviteAccepted(
        account.id,
        event.providerPersonId,
        event.occurredAt,
        db,
      );
      if (!matched) {
        // A connection the user made by hand. Not ours; must not move the rate.
        return { handled: true, detail: 'no matching invite; acceptance rate unchanged' };
      }

      const acceptance = await getAcceptance(account.id, db);
      return {
        handled: true,
        detail: `acceptance now ${acceptance.accepted}/${acceptance.sample}` +
          (acceptance.sample < LIMITS.ACCEPTANCE_MIN_SAMPLE ? ' (below sample threshold)' : ''),
      };
    }

    case 'account_status': {
      const account = accountByProviderId(db, event.providerAccountId);
      if (!account) return { handled: false, detail: 'unknown account' };

      const stopping = event.status !== 'active';
      await updateAccount(
        account.id,
        {
          status: event.status,
          // Anything other than "active" disables sending. We never re-enable
          // it from a webhook — coming back requires a human, because the
          // platform saying "you're fine now" is not evidence that whatever
          // triggered the checkpoint has been dealt with.
          ...(stopping ? { sendingEnabled: false } : {}),
          pausedReason: stopping
            ? event.reason ?? 'The provider reported a problem with this account.'
            : null,
          ...(event.status === 'checkpointed'
            ? { checkpointUntil: new Date(Date.now() + LIMITS.CHECKPOINT_COOLDOWN_MS) }
            : {}),
        },
        db,
      );
      return { handled: true, detail: `account marked ${event.status}` };
    }

    case 'post_published': {
      const post = await getPostByUrn(event.urn, db);
      if (post) return { handled: true, detail: 'post already recorded' };
      return { handled: true, detail: 'post not tracked by PostFold' };
    }

    case 'unknown':
      return { handled: false, detail: `unhandled event: ${event.name}` };
  }
}
