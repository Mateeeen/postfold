/**
 * Posts, people, engagements, suggestions and invites.
 */

import type { Db } from './index.js';
import { fromIso, fromIsoRequired, getDb, newId, nowIso } from './index.js';
import type {
  EngagementKind,
  Invite,
  InviteStatus,
  Person,
  Post,
  PostStatus,
  Suggestion,
  SuggestionStatus,
} from '../types.js';

/* --- Posts ------------------------------------------------------------- */

interface PostRow {
  id: string;
  account_id: string;
  urn: string | null;
  text: string;
  status: string;
  published_at: string | null;
  engagers_synced_at: string | null;
}

const mapPost = (r: PostRow): Post => ({
  id: r.id,
  accountId: r.account_id,
  urn: r.urn,
  text: r.text,
  status: r.status as PostStatus,
  publishedAt: fromIso(r.published_at),
  engagersSyncedAt: fromIso(r.engagers_synced_at),
});

const POST_COLUMNS = `id, account_id, urn, text, status, published_at, engagers_synced_at`;

export async function createPost(
  accountId: string,
  text: string,
  db: Db = getDb(),
): Promise<Post> {
  const id = newId();
  db.prepare(
    `INSERT INTO posts (id, account_id, text, status, created_at)
     VALUES (@id, @accountId, @text, 'queued', @now)`,
  ).run({ id, accountId, text, now: nowIso() });
  const row = db.prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`).get(id) as PostRow;
  return mapPost(row);
}

export async function getPost(id: string, db: Db = getDb()): Promise<Post | null> {
  const row = db.prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`).get(id) as
    | PostRow
    | undefined;
  return row ? mapPost(row) : null;
}

export async function getPostByUrn(urn: string, db: Db = getDb()): Promise<Post | null> {
  const row = db.prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE urn = ?`).get(urn) as
    | PostRow
    | undefined;
  return row ? mapPost(row) : null;
}

export async function listPosts(
  accountId: string,
  db: Db = getDb(),
): Promise<Post[]> {
  const rows = db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM posts
        WHERE account_id = ?
        ORDER BY COALESCE(published_at, created_at) DESC
        LIMIT 100`,
    )
    .all(accountId) as PostRow[];
  return rows.map(mapPost);
}

export async function markPostPublished(
  id: string,
  urn: string,
  publishedAt: Date,
  db: Db = getDb(),
): Promise<void> {
  db.prepare(
    `UPDATE posts SET status = 'published', urn = @urn, published_at = @publishedAt
      WHERE id = @id`,
  ).run({ id, urn, publishedAt: publishedAt.toISOString() });
}

export async function markPostFailed(id: string, db: Db = getDb()): Promise<void> {
  db.prepare(`UPDATE posts SET status = 'failed' WHERE id = ?`).run(id);
}

export async function markEngagersSynced(
  id: string,
  at: Date,
  db: Db = getDb(),
): Promise<void> {
  db.prepare(`UPDATE posts SET engagers_synced_at = ? WHERE id = ?`).run(
    at.toISOString(),
    id,
  );
}

/* --- People ------------------------------------------------------------ */

interface PersonRow {
  id: string;
  account_id: string;
  provider_person_id: string;
  name: string;
  headline: string | null;
  profile_url: string | null;
}

const mapPerson = (r: PersonRow): Person => ({
  id: r.id,
  accountId: r.account_id,
  providerPersonId: r.provider_person_id,
  name: r.name,
  headline: r.headline,
  profileUrl: r.profile_url,
});

/**
 * Upsert by (account, provider id). ON CONFLICT DO UPDATE refreshes the
 * headline — people change jobs, and a stale headline in a connection note is
 * worse than no note at all.
 */
export async function upsertPerson(
  accountId: string,
  p: Omit<Person, 'id' | 'accountId'>,
  db: Db = getDb(),
): Promise<Person> {
  db.prepare(
    `INSERT INTO people (id, account_id, provider_person_id, name, headline, profile_url, created_at)
     VALUES (@id, @accountId, @providerPersonId, @name, @headline, @profileUrl, @now)
     ON CONFLICT (account_id, provider_person_id) DO UPDATE SET
       name = excluded.name,
       headline = COALESCE(excluded.headline, people.headline),
       profile_url = COALESCE(excluded.profile_url, people.profile_url)`,
  ).run({
    id: newId(),
    accountId,
    providerPersonId: p.providerPersonId,
    name: p.name,
    headline: p.headline,
    profileUrl: p.profileUrl,
    now: nowIso(),
  });

  const row = db
    .prepare(
      `SELECT id, account_id, provider_person_id, name, headline, profile_url
         FROM people WHERE account_id = ? AND provider_person_id = ?`,
    )
    .get(accountId, p.providerPersonId) as PersonRow;
  return mapPerson(row);
}

export async function getPerson(id: string, db: Db = getDb()): Promise<Person | null> {
  const row = db
    .prepare(
      `SELECT id, account_id, provider_person_id, name, headline, profile_url
         FROM people WHERE id = ?`,
    )
    .get(id) as PersonRow | undefined;
  return row ? mapPerson(row) : null;
}

/* --- Engagements ------------------------------------------------------- */

export async function recordEngagement(
  input: {
    postId: string;
    personId: string;
    kind: EngagementKind;
    commentText: string | null;
    occurredAt: Date;
  },
  db: Db = getDb(),
): Promise<void> {
  db.prepare(
    `INSERT INTO engagements (post_id, person_id, kind, comment_text, occurred_at, created_at)
     VALUES (@postId, @personId, @kind, @commentText, @occurredAt, @now)
     ON CONFLICT (post_id, person_id, kind) DO NOTHING`,
  ).run({
    postId: input.postId,
    personId: input.personId,
    kind: input.kind,
    commentText: input.commentText,
    occurredAt: input.occurredAt.toISOString(),
    now: nowIso(),
  });
}

/* --- Suggestions ------------------------------------------------------- */

interface SuggestionRow {
  id: string;
  account_id: string;
  person_id: string;
  post_id: string;
  score: number;
  reason: string;
  draft_note: string;
  status: string;
  created_at: string;
  decided_at: string | null;
}

const mapSuggestion = (r: SuggestionRow): Suggestion => ({
  id: r.id,
  accountId: r.account_id,
  personId: r.person_id,
  postId: r.post_id,
  score: r.score,
  reason: r.reason,
  draftNote: r.draft_note,
  status: r.status as SuggestionStatus,
  createdAt: fromIsoRequired(r.created_at),
  decidedAt: fromIso(r.decided_at),
});

const SUGGESTION_COLUMNS = `id, account_id, person_id, post_id, score, reason,
  draft_note, status, created_at, decided_at`;

export async function upsertSuggestion(
  input: {
    accountId: string;
    personId: string;
    postId: string;
    score: number;
    reason: string;
    draftNote: string;
  },
  db: Db = getDb(),
): Promise<void> {
  // If a suggestion for this person already exists we only refresh it while it
  // is still pending. A dismissed person stays dismissed; re-suggesting people
  // the user already said no to is the fastest way to lose their trust.
  db.prepare(
    `INSERT INTO suggestions (id, account_id, person_id, post_id, score, reason, draft_note, status, created_at)
     VALUES (@id, @accountId, @personId, @postId, @score, @reason, @draftNote, 'pending', @now)
     ON CONFLICT (account_id, person_id) DO UPDATE SET
       score = MAX(suggestions.score, excluded.score),
       reason = excluded.reason,
       post_id = excluded.post_id
     WHERE suggestions.status = 'pending'`,
  ).run({
    id: newId(),
    accountId: input.accountId,
    personId: input.personId,
    postId: input.postId,
    score: input.score,
    reason: input.reason,
    draftNote: input.draftNote,
    now: nowIso(),
  });
}

export interface SuggestionView extends Suggestion {
  person: Person;
  /** What they did on the post — comment text when there is one. */
  engagementKind: EngagementKind;
  commentText: string | null;
  postText: string;
}

export async function listSuggestions(
  accountId: string,
  status: SuggestionStatus = 'pending',
  db: Db = getDb(),
): Promise<SuggestionView[]> {
  const rows = db
    .prepare(
      `SELECT s.id, s.account_id, s.person_id, s.post_id, s.score, s.reason,
              s.draft_note, s.status, s.created_at, s.decided_at,
              p.id AS p_id, p.account_id AS p_account_id,
              p.provider_person_id, p.name, p.headline, p.profile_url,
              COALESCE(po.text, '') AS post_text,
              (SELECT kind FROM engagements e
                WHERE e.post_id = s.post_id AND e.person_id = s.person_id
                ORDER BY CASE kind WHEN 'comment' THEN 0 ELSE 1 END LIMIT 1) AS engagement_kind,
              (SELECT comment_text FROM engagements e
                WHERE e.post_id = s.post_id AND e.person_id = s.person_id
                  AND e.kind = 'comment' LIMIT 1) AS comment_text
         FROM suggestions s
         JOIN people p ON p.id = s.person_id
         LEFT JOIN posts po ON po.id = s.post_id
        WHERE s.account_id = ? AND s.status = ?
        ORDER BY s.score DESC, s.created_at ASC
        LIMIT 100`,
    )
    .all(accountId, status) as (SuggestionRow & {
    p_id: string;
    p_account_id: string;
    provider_person_id: string;
    name: string;
    headline: string | null;
    profile_url: string | null;
    post_text: string;
    engagement_kind: string | null;
    comment_text: string | null;
  })[];

  return rows.map((r) => ({
    ...mapSuggestion(r),
    person: mapPerson({
      id: r.p_id,
      account_id: r.p_account_id,
      provider_person_id: r.provider_person_id,
      name: r.name,
      headline: r.headline,
      profile_url: r.profile_url,
    }),
    engagementKind: (r.engagement_kind ?? 'reaction') as EngagementKind,
    commentText: r.comment_text,
    postText: r.post_text,
  }));
}

export async function getSuggestion(
  id: string,
  db: Db = getDb(),
): Promise<Suggestion | null> {
  const row = db
    .prepare(`SELECT ${SUGGESTION_COLUMNS} FROM suggestions WHERE id = ?`)
    .get(id) as SuggestionRow | undefined;
  return row ? mapSuggestion(row) : null;
}

export async function setSuggestionStatus(
  id: string,
  status: SuggestionStatus,
  note: string | null = null,
  db: Db = getDb(),
): Promise<void> {
  db.prepare(
    `UPDATE suggestions
        SET status = @status,
            decided_at = @now,
            draft_note = COALESCE(@note, draft_note)
      WHERE id = @id`,
  ).run({ id, status, note, now: nowIso() });
}

/* --- Invites ----------------------------------------------------------- */

interface InviteRow {
  id: string;
  account_id: string;
  person_id: string;
  action_id: string;
  status: string;
  sent_at: string;
  accepted_at: string | null;
}

const mapInvite = (r: InviteRow): Invite => ({
  id: r.id,
  accountId: r.account_id,
  personId: r.person_id,
  actionId: r.action_id,
  status: r.status as InviteStatus,
  sentAt: fromIsoRequired(r.sent_at),
  acceptedAt: fromIso(r.accepted_at),
});

export async function recordInviteSent(
  input: {
    accountId: string;
    personId: string;
    actionId: string;
    providerInviteId: string;
    sentAt: Date;
    withNote: boolean;
  },
  db: Db = getDb(),
): Promise<void> {
  db.prepare(
    `INSERT INTO invites (id, account_id, person_id, action_id, provider_invite_id, status, sent_at, with_note)
     VALUES (@id, @accountId, @personId, @actionId, @providerInviteId, 'sent', @sentAt, @withNote)
     ON CONFLICT (account_id, person_id) DO UPDATE SET
       action_id = excluded.action_id,
       provider_invite_id = excluded.provider_invite_id,
       sent_at = excluded.sent_at,
       status = 'sent',
       accepted_at = NULL`,
  ).run({
    id: newId(),
    accountId: input.accountId,
    personId: input.personId,
    actionId: input.actionId,
    providerInviteId: input.providerInviteId,
    sentAt: input.sentAt.toISOString(),
    withNote: input.withNote ? 1 : 0,
  });
}

/**
 * Mark an invite accepted, addressed by provider person id because that is all
 * an inbound webhook knows about. Returns false when we have no matching
 * invite — a connection the user made by hand, which must not move the
 * acceptance rate.
 */
export async function markInviteAccepted(
  accountId: string,
  providerPersonId: string,
  acceptedAt: Date,
  db: Db = getDb(),
): Promise<boolean> {
  const info = db
    .prepare(
      `UPDATE invites
          SET status = 'accepted', accepted_at = @acceptedAt
        WHERE account_id = @accountId
          AND status = 'sent'
          AND person_id = (SELECT id FROM people
                            WHERE account_id = @accountId AND provider_person_id = @providerPersonId)`,
    )
    .run({ accountId, providerPersonId, acceptedAt: acceptedAt.toISOString() });
  return info.changes > 0;
}

export async function listInvites(
  accountId: string,
  db: Db = getDb(),
): Promise<Invite[]> {
  const rows = db
    .prepare(
      `SELECT id, account_id, person_id, action_id, status, sent_at, accepted_at
         FROM invites WHERE account_id = ? ORDER BY sent_at DESC LIMIT 200`,
    )
    .all(accountId) as InviteRow[];
  return rows.map(mapInvite);
}
