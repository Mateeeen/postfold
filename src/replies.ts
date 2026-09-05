/**
 * Replies to comments we left, and whether our invites got accepted.
 *
 * Both are read-only at the platform. Neither sends anything: replies become
 * *suggestions*, which a human still approves one at a time (invariant 4), and
 * polling only records a fact we were already going to be told by webhook.
 */

import { getAccount, getAcceptance } from './db/accounts.js';
import { markInviteAccepted, upsertPerson } from './db/content.js';
import type { Db } from './db/index.js';
import { getDb, nowIso } from './db/index.js';
import { LIMITS } from './policy.js';
import type { SocialProvider } from './provider.js';
import { getProvider } from './providers/index.js';

/* --- Replies to our comments ------------------------------------------- */

const REPLIES_PER_COMMENT = 20;

interface PostedComment {
  draftId: string;
  commentId: string;
  postUrn: string;
  text: string;
}

/** Comments we posted that are worth checking for replies. */
function recentPostedComments(accountId: string, db: Db): PostedComment[] {
  return db
    .prepare(
      `SELECT id AS draftId, posted_comment_id AS commentId,
              posted_post_urn AS postUrn, text
         FROM drafts
        WHERE account_id = ?
          AND kind = 'comment'
          AND posted_comment_id IS NOT NULL
          AND decided_at >= datetime('now', '-14 days')
        ORDER BY decided_at DESC
        LIMIT 20`,
    )
    .all(accountId) as PostedComment[];
}

export interface SyncRepliesResult {
  commentsChecked: number;
  repliesSeen: number;
  suggested: number;
  skippedConnected: number;
}

/**
 * Pull replies to our comments and turn the strangers among them into
 * connection suggestions.
 *
 * Someone who replied to you is a materially warmer lead than someone who
 * tapped Like on a post — they wrote something, to you, in public. That is
 * reflected in the score.
 */
export async function syncReplies(
  input: { accountId: string; draftIds?: string[] },
  provider: SocialProvider = getProvider(),
  db: Db = getDb(),
): Promise<SyncRepliesResult> {
  const account = await getAccount(input.accountId, db);
  if (!account) throw new Error(`Unknown account ${input.accountId}`);

  const all = recentPostedComments(input.accountId, db);
  const targets =
    input.draftIds && input.draftIds.length > 0
      ? all.filter((c) => input.draftIds!.includes(c.draftId))
      : all;

  const result: SyncRepliesResult = {
    commentsChecked: 0,
    repliesSeen: 0,
    suggested: 0,
    skippedConnected: 0,
  };

  for (const posted of targets) {
    let replies;
    try {
      replies = await provider.getPostComments({
        providerAccountId: account.providerAccountId,
        postUrn: posted.postUrn,
        commentId: posted.commentId,
        limit: REPLIES_PER_COMMENT,
      });
    } catch (err) {
      // One unreadable thread must not abort the rest.
      console.warn(`[replies] could not read replies to ${posted.commentId}`, err);
      continue;
    }
    result.commentsChecked++;

    for (const reply of replies) {
      if (!reply.authorProviderId) continue;
      result.repliesSeen++;

      // Our own replies in our own thread are not leads.
      if (account.ownerPersonId && reply.authorProviderId === account.ownerPersonId) continue;

      // Already connected: nothing to invite them to.
      if (reply.alreadyConnected) {
        result.skippedConnected++;
        continue;
      }

      const person = await upsertPerson(
        input.accountId,
        {
          providerPersonId: reply.authorProviderId,
          name: reply.authorName,
          headline: reply.authorHeadline,
          profileUrl: null,
        },
        db,
      );

      const note = draftReplyNote({
        name: person.name,
        theirReply: reply.text,
        ourComment: posted.text,
      });

      // ON CONFLICT DO NOTHING, not DO UPDATE: a person the user already
      // dismissed must not reappear because they replied again.
      const info = db
        .prepare(
          `INSERT INTO suggestions
             (id, account_id, person_id, post_id, discovered_post_id, source,
              score, reason, draft_note, status, created_at)
           VALUES (@id, @accountId, @personId, NULL, NULL, 'reply',
              @score, @reason, @note, 'pending', @now)
           ON CONFLICT (account_id, person_id) DO NOTHING`,
        )
        .run({
          id: crypto.randomUUID(),
          accountId: input.accountId,
          personId: person.id,
          score: scoreReply(reply.text),
          reason: `Replied to your comment: "${truncate(reply.text, 120)}"`,
          note,
          now: nowIso(),
        });
      if (info.changes > 0) result.suggested++;
    }
  }

  return result;
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

/**
 * Score a reply, 0..1. Higher than a reaction across the board — replying is a
 * far stronger signal — with more weight for substance and questions.
 */
export function scoreReply(text: string): number {
  let score = 0.55;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 25) score += 0.25;
  else if (words >= 8) score += 0.15;
  if (/\?/.test(text)) score += 0.1;
  return Math.min(1, Number(score.toFixed(3)));
}

/**
 * Note for someone who replied to us. Refers to the exchange, because that is
 * the only reason they would recognise the name.
 */
export function draftReplyNote(input: {
  name: string;
  theirReply: string;
  ourComment: string;
}): string {
  const first = input.name.trim().split(/\s+/)[0] ?? input.name;
  let note =
    `Hi ${first} — thanks for replying to my comment. ` +
    `Enjoyed the exchange and would like to keep in touch.`;
  if (note.length > LIMITS.MAX_NOTE_CHARS) {
    note = `${note.slice(0, LIMITS.MAX_NOTE_CHARS - 1).trimEnd()}…`;
  }
  return note;
}

/* --- Acceptance polling ------------------------------------------------- */

export interface PollAcceptanceResult {
  checked: number;
  accepted: number;
  gaveUp: number;
}

interface PendingInviteRow {
  id: string;
  person_id: string;
  provider_person_id: string;
  sent_at: string;
}

/**
 * Ask whether invites we sent have been accepted.
 *
 * The webhook is the primary signal, but LinkedIn gives Unipile no real-time
 * event for this — deliveries can lag up to eight hours, and if webhooks are
 * not configured at all the acceptance rate never moves. Since the rate drives
 * the daily cap, a throttle with no data is a throttle that cannot engage.
 *
 * One call to the sent-invitations list answers "what is still outstanding";
 * anything missing from it is confirmed with a single profile read, because
 * the list alone cannot tell accepted from withdrawn. That keeps us well
 * inside the platform's ~100-profile-retrievals-per-day guidance.
 */
export async function pollAcceptance(
  input: { accountId: string; inviteIds?: string[] },
  provider: SocialProvider = getProvider(),
  db: Db = getDb(),
): Promise<PollAcceptanceResult> {
  const account = await getAccount(input.accountId, db);
  if (!account) throw new Error(`Unknown account ${input.accountId}`);

  const rows = db
    .prepare(
      `SELECT i.id, i.person_id, p.provider_person_id, i.sent_at
         FROM invites i
         JOIN people p ON p.id = i.person_id
        WHERE i.account_id = ? AND i.status = 'sent'
        ORDER BY i.sent_at ASC
        LIMIT 100`,
    )
    .all(input.accountId) as PendingInviteRow[];

  const targets =
    input.inviteIds && input.inviteIds.length > 0
      ? rows.filter((r) => input.inviteIds!.includes(r.id))
      : rows;

  const result: PollAcceptanceResult = { checked: 0, accepted: 0, gaveUp: 0 };
  if (targets.length === 0) return result;

  // ONE call tells us everything still outstanding, rather than a profile
  // lookup per person. The platform recommends at most ~100 profile
  // retrievals per account per day — a budget the per-person approach would
  // consume entirely, before the invite path's own profile checks.
  let stillPending: Set<string>;
  try {
    const pending = await provider.listSentInvitations({
      providerAccountId: account.providerAccountId,
      limit: 100,
    });
    stillPending = new Set(pending.map((p) => p.providerPersonId));
  } catch (err) {
    console.warn('[poll] could not list sent invitations', err);
    return result;
  }

  const now = Date.now();
  for (const row of targets) {
    result.checked++;
    const sentAt = new Date(row.sent_at).getTime();

    if (stillPending.has(row.provider_person_id)) {
      // Still outstanding. Give up on one nobody has acted on for weeks —
      // marking it expired rather than deleting keeps it in the denominator,
      // because forgetting it would flatter the rate and raise the cap.
      if (now - sentAt > LIMITS.INVITE_GIVE_UP_AFTER_MS) {
        db.prepare(
          `UPDATE invites SET status = 'expired', last_checked_at = ? WHERE id = ?`,
        ).run(nowIso(), row.id);
        result.gaveUp++;
      } else {
        db.prepare('UPDATE invites SET last_checked_at = ? WHERE id = ?').run(
          nowIso(),
          row.id,
        );
      }
      continue;
    }

    // No longer pending. That means accepted, withdrawn, or declined — the
    // list cannot tell us which, so confirm with one profile read before
    // moving the acceptance rate. Being wrong here raises the daily cap on
    // evidence that does not exist.
    try {
      const profile = await provider.getProfile({
        providerAccountId: account.providerAccountId,
        providerPersonId: row.provider_person_id,
      });
      if (profile.alreadyConnected) {
        const changed = await markInviteAccepted(
          input.accountId,
          row.provider_person_id,
          new Date(),
          db,
        );
        if (changed) result.accepted++;
      } else {
        db.prepare(
          `UPDATE invites SET status = 'withdrawn', last_checked_at = ? WHERE id = ?`,
        ).run(nowIso(), row.id);
      }
    } catch (err) {
      console.warn(`[poll] could not confirm ${row.provider_person_id}`, err);
    }
    db.prepare('UPDATE invites SET last_checked_at = ? WHERE id = ?').run(
      nowIso(),
      row.id,
    );
  }

  if (result.accepted > 0) {
    const acceptance = await getAcceptance(input.accountId, db);
    console.log(
      `[poll] acceptance now ${acceptance.accepted}/${acceptance.sample}` +
        (acceptance.rate !== null ? ` (${Math.round(acceptance.rate * 100)}%)` : ''),
    );
  }

  return result;
}
