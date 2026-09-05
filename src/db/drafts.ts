/**
 * Keywords, discovered posts, and drafts.
 *
 * Note there is no insert-into-actions here either. A draft becomes an action
 * only through scheduler.enqueue(), called from the approve path — invariant 3
 * holds for machine-written text exactly as it does for invites.
 */

import type { Db } from './index.js';
import { fromIso, fromIsoRequired, getDb, intToBool, newId, nowIso } from './index.js';
import type {
  DiscoveredPost,
  Draft,
  DraftKind,
  DraftStatus,
  Keyword,
} from '../types.js';

/* --- Keywords ---------------------------------------------------------- */

interface KeywordRow {
  id: string;
  account_id: string;
  term: string;
  source: string;
  enabled: number;
}

const mapKeyword = (r: KeywordRow): Keyword => ({
  id: r.id,
  accountId: r.account_id,
  term: r.term,
  source: r.source as 'user' | 'derived',
  enabled: intToBool(r.enabled),
});

export async function listKeywords(
  accountId: string,
  db: Db = getDb(),
): Promise<Keyword[]> {
  const rows = db
    .prepare(
      `SELECT id, account_id, term, source, enabled FROM keywords
        WHERE account_id = ? ORDER BY source DESC, term ASC`,
    )
    .all(accountId) as KeywordRow[];
  return rows.map(mapKeyword);
}

export async function listEnabledTerms(
  accountId: string,
  db: Db = getDb(),
): Promise<string[]> {
  const rows = db
    .prepare(`SELECT term FROM keywords WHERE account_id = ? AND enabled = 1`)
    .all(accountId) as { term: string }[];
  return rows.map((r) => r.term);
}

/**
 * A user-typed keyword outranks a derived one: if the model later proposes the
 * same term, it must not downgrade the row's provenance, because a regenerate
 * is allowed to replace derived terms and never user ones.
 */
export async function addKeyword(
  accountId: string,
  term: string,
  source: 'user' | 'derived',
  db: Db = getDb(),
): Promise<void> {
  const clean = term.trim();
  if (clean === '') return;
  db.prepare(
    `INSERT INTO keywords (id, account_id, term, source, enabled, created_at)
     VALUES (@id, @accountId, @term, @source, 1, @now)
     ON CONFLICT (account_id, term) DO UPDATE SET
       enabled = 1,
       source = CASE WHEN keywords.source = 'user' THEN 'user' ELSE excluded.source END`,
  ).run({ id: newId(), accountId, term: clean, source, now: nowIso() });
}

export async function setKeywordEnabled(
  id: string,
  enabled: boolean,
  db: Db = getDb(),
): Promise<void> {
  db.prepare(`UPDATE keywords SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export async function deleteKeyword(id: string, db: Db = getDb()): Promise<void> {
  db.prepare(`DELETE FROM keywords WHERE id = ?`).run(id);
}

/* --- Discovered posts -------------------------------------------------- */

interface DiscoveredRow {
  id: string;
  account_id: string;
  urn: string;
  keyword: string;
  text: string;
  author_name: string;
  author_headline: string | null;
  author_provider_id: string | null;
  reactions: number;
  comments: number;
  posted_at: string | null;
  discovered_at: string;
  share_url: string | null;
  author_public_identifier: string | null;
}

const mapDiscovered = (r: DiscoveredRow): DiscoveredPost => ({
  id: r.id,
  accountId: r.account_id,
  urn: r.urn,
  keyword: r.keyword,
  text: r.text,
  authorName: r.author_name,
  authorHeadline: r.author_headline,
  authorProviderId: r.author_provider_id,
  reactions: r.reactions,
  comments: r.comments,
  postedAt: fromIso(r.posted_at),
  discoveredAt: fromIsoRequired(r.discovered_at),
  postUrl: r.share_url,
  authorPublicIdentifier: r.author_public_identifier,
});

const DISCOVERED_COLUMNS = `id, account_id, urn, keyword, text, author_name,
  author_headline, author_provider_id, reactions, comments, posted_at,
  discovered_at, share_url, author_public_identifier`;

/**
 * Upsert refreshes engagement counts but never the keyword or discovery time —
 * a post found under two keywords keeps the first, so "why did we see this"
 * stays stable.
 */
export async function upsertDiscoveredPost(
  input: Omit<DiscoveredPost, 'id' | 'discoveredAt'>,
  db: Db = getDb(),
): Promise<DiscoveredPost> {
  db.prepare(
    `INSERT INTO discovered_posts (
       id, account_id, urn, keyword, text, author_name, author_headline,
       author_provider_id, reactions, comments, posted_at, discovered_at,
       share_url, author_public_identifier
     ) VALUES (
       @id, @accountId, @urn, @keyword, @text, @authorName, @authorHeadline,
       @authorProviderId, @reactions, @comments, @postedAt, @now,
       @postUrl, @authorPublicIdentifier
     )
     ON CONFLICT (account_id, urn) DO UPDATE SET
       reactions = excluded.reactions,
       comments = excluded.comments,
       share_url = COALESCE(excluded.share_url, discovered_posts.share_url),
       author_public_identifier =
         COALESCE(excluded.author_public_identifier, discovered_posts.author_public_identifier)`,
  ).run({
    id: newId(),
    accountId: input.accountId,
    urn: input.urn,
    keyword: input.keyword,
    text: input.text,
    authorName: input.authorName,
    authorHeadline: input.authorHeadline,
    authorProviderId: input.authorProviderId,
    reactions: input.reactions,
    comments: input.comments,
    postedAt: input.postedAt ? input.postedAt.toISOString() : null,
    postUrl: input.postUrl,
    authorPublicIdentifier: input.authorPublicIdentifier,
    now: nowIso(),
  });

  const row = db
    .prepare(
      `SELECT ${DISCOVERED_COLUMNS} FROM discovered_posts
        WHERE account_id = ? AND urn = ?`,
    )
    .get(input.accountId, input.urn) as DiscoveredRow;
  return mapDiscovered(row);
}

export async function getDiscoveredPost(
  id: string,
  db: Db = getDb(),
): Promise<DiscoveredPost | null> {
  const row = db
    .prepare(`SELECT ${DISCOVERED_COLUMNS} FROM discovered_posts WHERE id = ?`)
    .get(id) as DiscoveredRow | undefined;
  return row ? mapDiscovered(row) : null;
}

/**
 * Posts we have not drafted a comment for yet, best first.
 *
 * The NOT EXISTS is what stops us commenting on the same post twice — the
 * unique index enforces it too, but silently colliding on insert would waste
 * a model call per sync.
 */
export async function undraftedPosts(
  accountId: string,
  limit: number,
  db: Db = getDb(),
): Promise<DiscoveredPost[]> {
  const rows = db
    .prepare(
      `SELECT ${DISCOVERED_COLUMNS} FROM discovered_posts d
        WHERE d.account_id = ?
          AND NOT EXISTS (SELECT 1 FROM drafts f WHERE f.discovered_post_id = d.id)
        ORDER BY (d.reactions + d.comments) DESC, d.discovered_at DESC
        LIMIT ?`,
    )
    .all(accountId, limit) as DiscoveredRow[];
  return rows.map(mapDiscovered);
}

/* --- Drafts ------------------------------------------------------------ */

interface DraftRow {
  id: string;
  account_id: string;
  kind: string;
  status: string;
  text: string;
  rationale: string;
  discovered_post_id: string | null;
  model: string | null;
  auto_approve_at: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

const mapDraft = (r: DraftRow): Draft => ({
  id: r.id,
  accountId: r.account_id,
  kind: r.kind as DraftKind,
  status: r.status as DraftStatus,
  text: r.text,
  rationale: r.rationale,
  discoveredPostId: r.discovered_post_id,
  model: r.model,
  autoApproveAt: fromIso(r.auto_approve_at),
  createdAt: fromIsoRequired(r.created_at),
  decidedAt: fromIso(r.decided_at),
  decidedBy: r.decided_by as 'user' | 'timer' | null,
});

const DRAFT_COLUMNS = `id, account_id, kind, status, text, rationale,
  discovered_post_id, model, auto_approve_at, created_at, decided_at, decided_by`;

export async function createDraft(
  input: {
    accountId: string;
    kind: DraftKind;
    text: string;
    rationale: string;
    discoveredPostId?: string | null;
    model?: string | null;
    autoApproveAt?: Date | null;
  },
  db: Db = getDb(),
): Promise<Draft> {
  const id = newId();
  db.prepare(
    `INSERT INTO drafts (
       id, account_id, kind, status, text, rationale, discovered_post_id,
       model, auto_approve_at, created_at
     ) VALUES (
       @id, @accountId, @kind, 'pending', @text, @rationale, @discoveredPostId,
       @model, @autoApproveAt, @now
     )`,
  ).run({
    id,
    accountId: input.accountId,
    kind: input.kind,
    text: input.text,
    rationale: input.rationale,
    discoveredPostId: input.discoveredPostId ?? null,
    model: input.model ?? null,
    autoApproveAt: input.autoApproveAt ? input.autoApproveAt.toISOString() : null,
    now: nowIso(),
  });
  const row = db.prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ?`).get(id) as DraftRow;
  return mapDraft(row);
}

export async function getDraft(id: string, db: Db = getDb()): Promise<Draft | null> {
  const row = db.prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ?`).get(id) as
    | DraftRow
    | undefined;
  return row ? mapDraft(row) : null;
}

export interface DraftView extends Draft {
  /** The post being replied to, for comment drafts. */
  sourcePost: DiscoveredPost | null;
}

export async function listDrafts(
  accountId: string,
  status: DraftStatus = 'pending',
  db: Db = getDb(),
): Promise<DraftView[]> {
  const rows = db
    .prepare(
      `SELECT ${DRAFT_COLUMNS} FROM drafts
        WHERE account_id = ? AND status = ?
        ORDER BY COALESCE(auto_approve_at, created_at) ASC
        LIMIT 100`,
    )
    .all(accountId, status) as DraftRow[];

  const out: DraftView[] = [];
  for (const r of rows) {
    const draft = mapDraft(r);
    out.push({
      ...draft,
      sourcePost: draft.discoveredPostId
        ? await getDiscoveredPost(draft.discoveredPostId, db)
        : null,
    });
  }
  return out;
}

export async function setDraftStatus(
  id: string,
  status: DraftStatus,
  decidedBy: 'user' | 'timer' | null,
  text: string | null = null,
  db: Db = getDb(),
): Promise<void> {
  db.prepare(
    `UPDATE drafts
        SET status = @status,
            decided_at = @now,
            decided_by = @decidedBy,
            text = COALESCE(@text, text)
      WHERE id = @id`,
  ).run({ id, status, decidedBy, text, now: nowIso() });
}

/**
 * Drafts whose auto-approve time has passed.
 *
 * Rides the partial index on (auto_approve_at) WHERE status='pending'. Only
 * drafts that were given a deadline are eligible — a null auto_approve_at
 * means "waits for a human", and this query must never pick those up.
 */
/**
 * Drop a draft's deadline. Used whenever a send fails or is cancelled: the
 * draft goes back to waiting for a human rather than re-arming its timer.
 */
export async function clearAutoApprove(id: string, db: Db = getDb()): Promise<void> {
  db.prepare('UPDATE drafts SET auto_approve_at = NULL WHERE id = ?').run(id);
}

export async function dueForAutoApproval(
  now: Date,
  db: Db = getDb(),
): Promise<Draft[]> {
  const rows = db
    .prepare(
      `SELECT ${DRAFT_COLUMNS} FROM drafts
        WHERE status = 'pending'
          AND auto_approve_at IS NOT NULL
          AND auto_approve_at <= ?
        ORDER BY auto_approve_at ASC
        LIMIT 25`,
    )
    .all(now.toISOString()) as DraftRow[];
  return rows.map(mapDraft);
}

export async function countPendingDrafts(
  accountId: string,
  db: Db = getDb(),
): Promise<number> {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM drafts WHERE account_id = ? AND status = 'pending'`)
    .get(accountId) as { n: number };
  return row.n;
}
