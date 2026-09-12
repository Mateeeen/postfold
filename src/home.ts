/**
 * One queue.
 *
 * Posts, comments, invitations and withdrawals arrive from four different
 * tables with four different lifecycles, and the user does not care. What they
 * need to answer, without asking anyone:
 *
 *   is this waiting for me, or is it going out on its own?
 *   when?
 *   why is that one waiting?
 *   what went out without me?
 *
 * The first three are per-item and answered by the row. The fourth is a
 * once-a-day question about things that are already gone, which by definition
 * are not in a queue — that is the digest, and it is a yesterday object rather
 * than a rolling window. A summary that recalculates live becomes ambient, and
 * ambient things stop being read.
 *
 * Every string here is written for a person. The vocabulary is fixed: needs
 * you, posting in 2h, waiting, didn't connect. Never pending, never declined,
 * and never the name of a model.
 */

import { getAccount } from './db/accounts.js';
import type { Db } from './db/index.js';
import { getDb } from './db/index.js';
import { autopilotUnlock } from './unlock.js';

export type HomeState = 'needs_you' | 'going_out' | 'sent';
export type HomeKind = 'post' | 'comment' | 'invite' | 'withdraw';

export interface HomeItem {
  id: string;
  kind: HomeKind;
  state: HomeState;
  /** One line. Already truncated; the UI does not re-cut it. */
  preview: string;
  /** Who this is about, when it is about somebody. */
  person: { name: string; avatarUrl: string | null; profileUrl: string | null } | null;
  /** needs_you: why it is with you rather than gone. */
  reason: string | null;
  /** going_out: when. Drives the countdown. */
  goesOutAt: string | null;
  /** going_out: true when it leaves without anyone looking again. */
  unattended: boolean;
  /** sent: when, and how it turned out. */
  sentAt: string | null;
  outcome: string | null;
}

export interface Digest {
  /** The day being reported, YYYY-MM-DD. */
  day: string;
  posts: number;
  comments: number;
  invites: number;
  accepted: number;
  /** One sentence, ready to show. */
  line: string;
}

export interface Home {
  items: HomeItem[];
  digest: Digest | null;
  /** Per-type autopilot state, so the header can answer "is this on". */
  autopilot: Awaited<ReturnType<typeof autopilotUnlock>>;
}

const line = (text: string, max = 110): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
};

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/* --- Rows ------------------------------------------------------------- */

interface DraftRow {
  id: string;
  kind: string;
  status: string;
  text: string;
  auto_approve_at: string | null;
  gaps: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

function draftItems(accountId: string, db: Db): HomeItem[] {
  const rows = db
    .prepare(
      `SELECT id, kind, status, text, auto_approve_at, gaps, created_at,
              decided_at, decided_by
         FROM drafts
        WHERE account_id = ? AND status IN ('pending', 'queued', 'approved')
        ORDER BY created_at DESC
        LIMIT 60`,
    )
    .all(accountId) as DraftRow[];

  return rows.map((r) => {
    const kind: HomeKind = r.kind === 'comment' ? 'comment' : 'post';

    if (r.status === 'pending') {
      // Why it is here rather than gone. An open gap is the common reason and
      // the one the user can act on, so it is named specifically.
      const open = (() => {
        try {
          const gaps = JSON.parse(r.gaps ?? '[]') as { value: string | null }[];
          return gaps.filter((g) => g.value === null).length;
        } catch {
          return 0;
        }
      })();

      return {
        id: r.id,
        kind,
        state: 'needs_you' as const,
        preview: line(r.text),
        person: null,
        reason:
          open > 0
            ? `${open} ${open === 1 ? 'blank' : 'blanks'} only you can fill`
            : 'Waiting for your yes',
        goesOutAt: r.auto_approve_at,
        unattended: false,
        sentAt: null,
        outcome: null,
      };
    }

    // Queued or already out.
    const out = r.status === 'approved';
    return {
      id: r.id,
      kind,
      state: (out ? 'sent' : 'going_out') as HomeState,
      preview: line(r.text),
      person: null,
      reason: null,
      goesOutAt: out ? null : r.decided_at,
      unattended: r.decided_by === 'timer',
      sentAt: out ? r.decided_at : null,
      outcome: out ? 'Posted' : null,
    };
  });
}

interface PersonRow {
  id: string;
  name: string;
  avatar_url: string | null;
  profile_url: string | null;
  reason: string | null;
  source: string | null;
  status: string;
  sent_at: string | null;
  scheduled_at: string | null;
}

function peopleItems(accountId: string, db: Db): HomeItem[] {
  const items: HomeItem[] = [];

  // Waiting on a human: one person at a time, never a list to bulk-action.
  const suggestions = db
    .prepare(
      `SELECT s.id, p.name, p.avatar_url, p.profile_url, s.reason, s.source
         FROM suggestions s JOIN people p ON p.id = s.person_id
        WHERE s.account_id = ? AND s.status = 'pending'
        ORDER BY s.score DESC LIMIT 40`,
    )
    .all(accountId) as PersonRow[];

  for (const s of suggestions) {
    items.push({
      id: s.id,
      kind: 'invite',
      state: 'needs_you',
      // Why this person is here at all. The reply case is the stronger signal
      // and says so: they read something of yours and answered it.
      preview:
        s.reason && s.reason.trim() !== ''
          ? line(s.reason, 90)
          : s.source === 'reply'
            ? 'Replied to your comment'
            : 'Engaged with your post',
      person: { name: s.name, avatarUrl: s.avatar_url, profileUrl: s.profile_url },
      reason: 'Nothing is sent until you say yes to this person',
      goesOutAt: null,
      unattended: false,
      sentAt: null,
      outcome: null,
    });
  }

  // Already asked. "Waiting" is neutral — most invitations sit here for days,
  // and "didn't connect" is used rather than "declined" because we frequently
  // cannot tell a refusal from someone who never opened LinkedIn.
  const invites = db
    .prepare(
      `SELECT i.id, p.name, p.avatar_url, p.profile_url, i.status, i.sent_at
         FROM invites i JOIN people p ON p.id = i.person_id
        WHERE i.account_id = ?
        ORDER BY i.sent_at DESC LIMIT 40`,
    )
    .all(accountId) as PersonRow[];

  const outcomes: Record<string, string> = {
    sent: 'Waiting',
    accepted: 'Connected',
    declined: "Didn't connect",
    withdrawn: 'Taken back',
    expired: "Didn't connect",
  };

  for (const i of invites) {
    items.push({
      id: i.id,
      kind: 'invite',
      state: 'sent',
      preview: `Invitation to ${i.name}`,
      person: { name: i.name, avatarUrl: i.avatar_url, profileUrl: i.profile_url },
      reason: null,
      goesOutAt: null,
      unattended: false,
      sentAt: i.sent_at,
      outcome: outcomes[i.status] ?? 'Waiting',
    });
  }

  return items;
}

function queuedItems(accountId: string, db: Db): HomeItem[] {
  // Actions with no draft behind them: withdrawals, and invitations already
  // approved and waiting for their slot.
  const rows = db
    .prepare(
      `SELECT a.id, a.kind, a.scheduled_at, p.name, p.avatar_url, p.profile_url
         FROM actions a
         LEFT JOIN people p ON p.id = json_extract(a.payload, '$.personId')
        WHERE a.account_id = ? AND a.status = 'pending'
          AND a.kind IN ('send_invite', 'withdraw_invite')
        ORDER BY a.scheduled_at ASC LIMIT 40`,
    )
    .all(accountId) as (PersonRow & { kind: string })[];

  return rows.map((r) => ({
    id: r.id,
    kind: (r.kind === 'withdraw_invite' ? 'withdraw' : 'invite') as HomeKind,
    state: 'going_out' as const,
    preview:
      r.kind === 'withdraw_invite'
        ? `Taking back the invitation to ${r.name ?? 'someone'}`
        : `Invitation to ${r.name ?? 'someone'}`,
    person: r.name
      ? { name: r.name, avatarUrl: r.avatar_url, profileUrl: r.profile_url }
      : null,
    reason: null,
    goesOutAt: r.scheduled_at,
    unattended: r.kind === 'withdraw_invite',
    sentAt: null,
    outcome: null,
  }));
}

/* --- Digest ----------------------------------------------------------- */

function digestFor(accountId: string, now: Date, db: Db): Digest | null {
  const account = db
    .prepare('SELECT digest_dismissed_on FROM accounts WHERE id = ?')
    .get(accountId) as { digest_dismissed_on: string | null } | undefined;

  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
  if (!account || account.digest_dismissed_on === yesterday) return null;

  // Unattended only. Anything the user approved themselves is not news.
  const drafts = db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM drafts
        WHERE account_id = ? AND decided_by = 'timer'
          AND date(decided_at) = ?
        GROUP BY kind`,
    )
    .all(accountId, yesterday) as { kind: string; n: number }[];

  const posts = drafts.find((d) => d.kind === 'post')?.n ?? 0;
  const comments = drafts.find((d) => d.kind === 'comment')?.n ?? 0;

  const invites = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM invites WHERE account_id = ? AND date(sent_at) = ?`,
      )
      .get(accountId, yesterday) as { n: number }
  ).n;

  const accepted = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM invites
          WHERE account_id = ? AND status = 'accepted' AND date(sent_at) = ?`,
      )
      .get(accountId, yesterday) as { n: number }
  ).n;

  if (posts + comments + invites === 0) return null;

  const parts: string[] = [];
  if (posts > 0) parts.push(`${posts} ${posts === 1 ? 'post' : 'posts'}`);
  if (comments > 0) parts.push(`${comments} ${comments === 1 ? 'comment' : 'comments'}`);
  if (invites > 0) parts.push(`${invites} ${invites === 1 ? 'invitation' : 'invitations'}`);

  return {
    day: yesterday,
    posts,
    comments,
    invites,
    accepted,
    line:
      `Yesterday, without you: ${parts.join(', ')}`
      + (accepted > 0 ? ` — ${accepted} connected.` : '.'),
  };
}

/** Mark the day's summary read. It does not come back. */
export async function dismissDigest(
  accountId: string,
  day: string,
  db: Db = getDb(),
): Promise<void> {
  db.prepare('UPDATE accounts SET digest_dismissed_on = ? WHERE id = ?').run(day, accountId);
}

/* --- The queue -------------------------------------------------------- */

const ORDER: Record<HomeState, number> = { needs_you: 0, going_out: 1, sent: 2 };

export async function home(
  accountId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<Home> {
  const account = await getAccount(accountId, db);
  if (!account) throw new Error(`Unknown account ${accountId}`);

  const items = [
    ...draftItems(accountId, db),
    ...peopleItems(accountId, db),
    ...queuedItems(accountId, db),
  ].sort((a, b) => {
    // Needs-you first, then whatever leaves soonest, then the record.
    if (ORDER[a.state] !== ORDER[b.state]) return ORDER[a.state] - ORDER[b.state];
    const at = a.goesOutAt ?? a.sentAt ?? '';
    const bt = b.goesOutAt ?? b.sentAt ?? '';
    return a.state === 'sent' ? bt.localeCompare(at) : at.localeCompare(bt);
  });

  return {
    items,
    digest: digestFor(accountId, now, db),
    autopilot: await autopilotUnlock(accountId, now, db),
  };
}
