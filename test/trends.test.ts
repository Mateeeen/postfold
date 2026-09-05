/**
 * Trend discovery, drafting, and the auto-approve timer.
 *
 * The timer is the highest-risk mechanism in the product: it publishes text
 * nobody read. These tests pin down what it may and may not do.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { updateAccount } from '../src/db/accounts.js';
import { cancelAction, getAction, listPendingActions } from '../src/db/actions.js';
import {
  addKeyword,
  clearAutoApprove,
  createDraft,
  getDraft,
  listKeywords,
  setDraftStatus,
  undraftedPosts,
} from '../src/db/drafts.js';
import { LIMITS } from '../src/policy.js';
import { FakeLlm } from '../src/llm/fake.js';
import { FakeProvider } from '../src/providers/fake.js';
import { approveDraft, draftComments, syncTrends } from '../src/trends.js';
import { sweepAutoApprovals, tick } from '../src/queue/worker.js';
import { fixture } from './helpers.js';
import type { Fixture } from './helpers.js';

let current: Fixture | null = null;

afterEach(() => {
  current?.db.close();
  current = null;
});

const silent = { log: () => {} };
const AUTO = { autoApprove: true };
const MANUAL = { autoApprove: false };

async function seeded(): Promise<Fixture> {
  const f = (current = await fixture());
  await addKeyword(f.account.id, 'ai coding', 'user', f.db);
  return f;
}

describe('syncTrends', () => {
  it('records posts found for each enabled keyword', async () => {
    const f = await seeded();
    const result = await syncTrends(
      { accountId: f.account.id },
      new FakeProvider(silent),
      f.db,
    );
    expect(result.keywords).toBe(1);
    expect(result.posts).toBe(1);
    expect(await undraftedPosts(f.account.id, 10, f.db)).toHaveLength(1);
  });

  it('never records the account owner as a comment target', async () => {
    // Commenting on your own post through the automation would be absurd, and
    // the FakeProvider's author id is the one we mark as the owner.
    const f = await seeded();
    await updateAccount(f.account.id, { ownerPersonId: 'fake-person-3' }, f.db);
    const result = await syncTrends(
      { accountId: f.account.id },
      new FakeProvider(silent),
      f.db,
    );
    expect(result.posts).toBe(0);
  });

  it('is safe to run twice', async () => {
    const f = await seeded();
    const provider = new FakeProvider(silent);
    await syncTrends({ accountId: f.account.id }, provider, f.db);
    await syncTrends({ accountId: f.account.id }, provider, f.db);
    expect(await undraftedPosts(f.account.id, 10, f.db)).toHaveLength(1);
  });
});

describe('draftComments', () => {
  it('creates a pending draft per candidate post', async () => {
    const f = await seeded();
    await syncTrends({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    const r = await draftComments(
      { accountId: f.account.id, options: MANUAL },
      new FakeLlm(silent),
      f.db,
    );
    expect(r.drafted).toBe(1);
    expect(r.declined).toBe(0);
  });

  it('creates nothing when the model declines', async () => {
    // Producing no draft is a correct outcome, not a failure.
    const f = await seeded();
    await syncTrends({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    const r = await draftComments(
      { accountId: f.account.id, options: MANUAL },
      new FakeLlm({ ...silent, declineComments: true }),
      f.db,
    );
    expect(r.drafted).toBe(0);
    expect(r.declined).toBe(1);
  });

  it('never drafts twice for the same post', async () => {
    const f = await seeded();
    await syncTrends({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    const llm = new FakeLlm(silent);
    await draftComments({ accountId: f.account.id, options: MANUAL }, llm, f.db);
    const second = await draftComments(
      { accountId: f.account.id, options: MANUAL },
      llm,
      f.db,
    );
    expect(second.drafted).toBe(0);
  });

  it('sets a deadline only when auto-approve was asked for', async () => {
    const f = await seeded();
    await syncTrends({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    await draftComments({ accountId: f.account.id, options: AUTO }, new FakeLlm(silent), f.db);

    const row = f.db.prepare('SELECT auto_approve_at FROM drafts').get() as {
      auto_approve_at: string | null;
    };
    expect(row.auto_approve_at).not.toBeNull();

    const due = new Date(row.auto_approve_at as string).getTime() - Date.now();
    expect(due).toBeGreaterThan(LIMITS.AUTO_APPROVE_AFTER_MS - 60_000);
  });
});

describe('sweepAutoApprovals', () => {
  async function pendingComment(f: Fixture, autoApproveAt: Date | null) {
    await syncTrends({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    const [post] = await undraftedPosts(f.account.id, 1, f.db);
    return createDraft(
      {
        accountId: f.account.id,
        kind: 'comment',
        text: 'A grounded comment.',
        rationale: 'test',
        discoveredPostId: post!.id,
        autoApproveAt,
      },
      f.db,
    );
  }

  it('does not touch a draft with no deadline', async () => {
    // A null auto_approve_at means "waits for a human", forever.
    const f = await seeded();
    const draft = await pendingComment(f, null);
    const r = await sweepAutoApprovals(new Date(Date.now() + 10 * 86_400_000), f.db);
    expect(r.approved).toBe(0);
    expect((await getDraft(draft.id, f.db))?.status).toBe('pending');
  });

  it('does not fire before the deadline', async () => {
    const f = await seeded();
    const draft = await pendingComment(f, new Date(Date.now() + 86_400_000));
    await sweepAutoApprovals(new Date(), f.db);
    expect((await getDraft(draft.id, f.db))?.status).toBe('pending');
  });

  it('queues the draft once the deadline passes', async () => {
    const f = await seeded();
    const draft = await pendingComment(f, new Date(Date.now() - 1000));
    const r = await sweepAutoApprovals(new Date(), f.db);

    expect(r.approved).toBe(1);
    const after = await getDraft(draft.id, f.db);
    expect(after?.status).toBe('queued');
    expect(after?.decidedBy).toBe('timer');

    const pending = await listPendingActions(f.account.id, f.db);
    expect(pending.map((a) => a.kind)).toContain('post_comment');
  });

  it('obeys policy — a timer cannot push past a cap a human could not', async () => {
    const f = await seeded();
    await updateAccount(
      f.account.id,
      { sendingEnabled: false, pausedReason: 'Paused by you.' },
      f.db,
    );
    const draft = await pendingComment(f, new Date(Date.now() - 1000));

    const r = await sweepAutoApprovals(new Date(), f.db);
    expect(r.approved).toBe(0);
    expect(r.held).toBe(1);
    expect(await listPendingActions(f.account.id, f.db)).toHaveLength(0);
  });

  it('clears the deadline on a held draft so it stops retrying', async () => {
    // Otherwise a blocked draft re-attempts on every worker pass until the cap
    // resets, and then publishes unattended long after the user stopped
    // expecting it.
    const f = await seeded();
    await updateAccount(f.account.id, { sendingEnabled: false }, f.db);
    const draft = await pendingComment(f, new Date(Date.now() - 1000));

    await sweepAutoApprovals(new Date(), f.db);
    const after = await getDraft(draft.id, f.db);
    expect(after?.status).toBe('pending');
    expect(after?.autoApproveAt).toBeNull();

    const second = await sweepAutoApprovals(new Date(), f.db);
    expect(second.approved + second.held).toBe(0);
  });
});

describe('approveDraft', () => {
  it('refuses a draft that was already decided', async () => {
    const f = await seeded();
    const draft = await createDraft(
      { accountId: f.account.id, kind: 'post', text: 'Hello', rationale: '' },
      f.db,
    );
    const first = await approveDraft({ draftId: draft.id, by: 'user' }, f.db);
    expect(first.ok).toBe(true);
    const second = await approveDraft({ draftId: draft.id, by: 'user' }, f.db);
    expect(second.ok).toBe(false);
  });

  it('uses edited text when the user supplies it', async () => {
    const f = await seeded();
    const draft = await createDraft(
      { accountId: f.account.id, kind: 'post', text: 'Original', rationale: '' },
      f.db,
    );
    await approveDraft({ draftId: draft.id, by: 'user', text: 'Edited by hand' }, f.db);

    const pending = await listPendingActions(f.account.id, f.db);
    const payload = pending[0]!.payload;
    expect(payload.kind).toBe('create_post');
    if (payload.kind === 'create_post') expect(payload.text).toBe('Edited by hand');
  });

  it('refuses an empty draft', async () => {
    const f = await seeded();
    const draft = await createDraft(
      { accountId: f.account.id, kind: 'post', text: 'x', rationale: '' },
      f.db,
    );
    const r = await approveDraft({ draftId: draft.id, by: 'user', text: '   ' }, f.db);
    expect(r.ok).toBe(false);
  });
});

describe('keywords', () => {
  it('keeps a user-typed term user-owned even if the model proposes it', async () => {
    const f = (current = await fixture());
    await addKeyword(f.account.id, 'ai coding', 'user', f.db);
    await addKeyword(f.account.id, 'ai coding', 'derived', f.db);

    const all = await listKeywords(f.account.id, f.db);
    expect(all).toHaveLength(1);
    expect(all[0]!.source).toBe('user');
  });
});

describe('draft lifecycle on failure and cancellation', () => {
  async function queuedComment(f: Fixture) {
    await syncTrends({ accountId: f.account.id }, new FakeProvider(silent), f.db);
    const [post] = await undraftedPosts(f.account.id, 1, f.db);
    const draft = await createDraft(
      {
        accountId: f.account.id,
        kind: 'comment',
        text: 'A comment.',
        rationale: 'test',
        discoveredPostId: post!.id,
        autoApproveAt: new Date(Date.now() + 3_600_000),
      },
      f.db,
    );
    const approved = await approveDraft({ draftId: draft.id, by: 'user' }, f.db);
    expect(approved.ok).toBe(true);
    return { draft, actionId: approved.ok ? approved.actionId : '' };
  }

  it('hands a draft back when the send fails terminally', async () => {
    // Otherwise the draft is stuck in 'queued': invisible in the Drafts tab
    // and never offered again.
    const f = (current = await fixture());
    await addKeyword(f.account.id, 'ai coding', 'user', f.db);
    const { draft, actionId } = await queuedComment(f);

    const action = (await getAction(actionId, f.db))!;
    await tick(
      new FakeProvider({ ...silent, failWith: 'invalid' }),
      new Date(action.scheduledAt.getTime() + 1000),
      f.db,
    );

    const after = await getDraft(draft.id, f.db);
    expect(after?.status).toBe('pending');
    // And its timer is disarmed — a draft that already failed must not
    // silently retry itself later.
    expect(after?.autoApproveAt).toBeNull();
  });

  it('hands a draft back when the queued action is cancelled', async () => {
    const f = (current = await fixture());
    await addKeyword(f.account.id, 'ai coding', 'user', f.db);
    const { draft, actionId } = await queuedComment(f);

    expect(await cancelAction(actionId, f.db)).toBe(true);
    await setDraftStatus(draft.id, 'pending', null, null, f.db);
    await clearAutoApprove(draft.id, f.db);

    const after = await getDraft(draft.id, f.db);
    expect(after?.status).toBe('pending');
    expect(after?.autoApproveAt).toBeNull();
  });
});
