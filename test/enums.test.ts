/**
 * Every TypeScript union that is also a database CHECK constraint.
 *
 * These are two copies of one list with nothing keeping them in sync. Adding
 * `withdraw_invite` to ActionKind compiled, typechecked, and then failed at
 * the database on the first real enqueue — the kind of bug that reaches
 * production because nothing between the two copies ever looks at both.
 *
 * The Record<Union, true> maps are the point. Add a member to the union and
 * the map stops compiling until it is listed here; list it here and the
 * round-trip fails until the migration exists. A runtime failure becomes a
 * compile-adjacent one.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './helpers.js';
import type { Fixture } from './helpers.js';
import type {
  AccountStatus,
  ActionKind,
  DraftKind,
  DraftStatus,
  FailureClass,
  InviteStatus,
  PostStatus,
} from '../src/types.js';
import type { DocumentSource, Trust } from '../src/db/documents.js';

let current: Fixture | null = null;
afterEach(() => {
  current?.db.close();
  current = null;
});

/** Exhaustive by construction: a missing member fails to compile. */
const ACTION_KINDS: Record<ActionKind, true> = {
  create_post: true,
  send_invite: true,
  sync_engagers: true,
  post_comment: true,
  sync_trends: true,
  sync_replies: true,
  poll_acceptance: true,
  withdraw_invite: true,
};

const DRAFT_KINDS: Record<DraftKind, true> = { post: true, comment: true };

const DRAFT_STATUSES: Record<DraftStatus, true> = {
  pending: true,
  approved: true,
  queued: true,
  dismissed: true,
  discarded: true,
  expired: true,
};

const INVITE_STATUSES: Record<InviteStatus, true> = {
  sent: true,
  accepted: true,
  declined: true,
  withdrawn: true,
  expired: true,
};

const ACCOUNT_STATUSES: Record<AccountStatus, true> = {
  active: true,
  paused: true,
  checkpointed: true,
  restricted: true,
  disconnected: true,
};

const POST_STATUSES: Record<PostStatus, true> = {
  draft: true,
  queued: true,
  published: true,
  failed: true,
};

const FAILURE_CLASSES: Record<FailureClass, true> = {
  transient: true,
  rate_limited: true,
  checkpoint: true,
  auth: true,
  invalid: true,
  permanent: true,
};

const TRUSTS: Record<Trust, true> = { voice: true, evidence: true };

const DOCUMENT_SOURCES: Record<DocumentSource, true> = {
  linkedin_post: true,
  linkedin_comment: true,
  commit: true,
  pull_request: true,
  note: true,
  link: true,
};

const keys = (m: Record<string, true>): string[] => Object.keys(m);

describe('unions round-trip through their CHECK constraints', () => {
  it('every ActionKind', async () => {
    const f = (current = await fixture());
    for (const kind of keys(ACTION_KINDS)) {
      expect(() =>
        f.db
          .prepare(
            `INSERT INTO actions (id, account_id, kind, payload, scheduled_at, dedupe_key)
             VALUES (?, ?, ?, '{}', datetime('now'), ?)`,
          )
          .run(`a-${kind}`, f.account.id, kind, `k-${kind}`),
      ).not.toThrow();
    }
  });

  it('every action status and failure class', async () => {
    const f = (current = await fixture());
    const statuses = ['pending', 'in_flight', 'done', 'failed', 'cancelled'];
    for (const status of statuses) {
      for (const cls of keys(FAILURE_CLASSES)) {
        expect(() =>
          f.db
            .prepare(
              `INSERT INTO actions (id, account_id, kind, status, payload, scheduled_at,
                 dedupe_key, last_failure_class)
               VALUES (?, ?, 'create_post', ?, '{}', datetime('now'), ?, ?)`,
            )
            .run(`a-${status}-${cls}`, f.account.id, status, `k-${status}-${cls}`, cls),
        ).not.toThrow();
      }
    }
  });

  it('every DraftKind and DraftStatus', async () => {
    const f = (current = await fixture());
    for (const kind of keys(DRAFT_KINDS)) {
      for (const status of keys(DRAFT_STATUSES)) {
        expect(() =>
          f.db
            .prepare(
              `INSERT INTO drafts (id, account_id, kind, status, text, rationale, created_at)
               VALUES (?, ?, ?, ?, 'x', 'y', datetime('now'))`,
            )
            .run(`d-${kind}-${status}`, f.account.id, kind, status),
        ).not.toThrow();
      }
    }
  });

  it('every InviteStatus', async () => {
    const f = (current = await fixture());
    f.db
      .prepare(
        `INSERT INTO actions (id, account_id, kind, payload, scheduled_at, dedupe_key)
         VALUES ('act-inv', ?, 'send_invite', '{}', datetime('now'), 'k-inv')`,
      )
      .run(f.account.id);

    for (const status of keys(INVITE_STATUSES)) {
      expect(() =>
        f.db
          .prepare(
            `INSERT INTO invites (id, account_id, person_id, action_id, status, sent_at)
             VALUES (?, ?, ?, 'act-inv', ?, datetime('now'))`,
          )
          .run(`i-${status}`, f.account.id, f.person.id, status),
      ).not.toThrow();
      f.db.prepare('DELETE FROM invites').run();
    }
  });

  it('every AccountStatus', async () => {
    const f = (current = await fixture());
    for (const status of keys(ACCOUNT_STATUSES)) {
      expect(() =>
        f.db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, f.account.id),
      ).not.toThrow();
    }
  });

  it('every PostStatus', async () => {
    const f = (current = await fixture());
    for (const status of keys(POST_STATUSES)) {
      expect(() =>
        f.db
          .prepare(
            `INSERT INTO posts (id, account_id, text, status, created_at)
             VALUES (?, ?, 'x', ?, datetime('now'))`,
          )
          .run(`p-${status}`, f.account.id, status),
      ).not.toThrow();
    }
  });

  it('every document Trust and DocumentSource', async () => {
    const f = (current = await fixture());
    for (const trust of keys(TRUSTS)) {
      for (const source of keys(DOCUMENT_SOURCES)) {
        expect(() =>
          f.db
            .prepare(
              `INSERT INTO documents (id, account_id, trust, source, text)
               VALUES (?, ?, ?, ?, 'some material long enough to be stored here')`,
            )
            .run(`doc-${trust}-${source}`, f.account.id, trust, source),
        ).not.toThrow();
      }
    }
  });

  it("every decided_by value drafts and posts accept", async () => {
    const f = (current = await fixture());
    for (const by of ['user', 'timer']) {
      expect(() =>
        f.db
          .prepare(
            `INSERT INTO drafts (id, account_id, kind, status, text, rationale, created_at, decided_by)
             VALUES (?, ?, 'post', 'approved', 'x', 'y', datetime('now'), ?)`,
          )
          .run(`db-${by}`, f.account.id, by),
      ).not.toThrow();
      expect(() =>
        f.db
          .prepare(
            `INSERT INTO posts (id, account_id, text, status, created_at, decided_by)
             VALUES (?, ?, 'x', 'queued', datetime('now'), ?)`,
          )
          .run(`pb-${by}`, f.account.id, by),
      ).not.toThrow();
    }
  });
});
