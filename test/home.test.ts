/**
 * The one queue. These tests are mostly about ordering and wording, because
 * that is what the screen is: four lifecycles flattened into rows a person
 * can read in the order they care about.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { home, dismissDigest } from '../src/home.js';
import { createDraft, setDraftStatus } from '../src/db/drafts.js';
import { recordInviteSent, upsertPerson, upsertSuggestion } from '../src/db/content.js';
import { fixture } from './helpers.js';
import type { Fixture } from './helpers.js';

let current: Fixture | null = null;
afterEach(() => {
  current?.db.close();
  current = null;
});

async function invite(f: Fixture, who: string, status: string): Promise<void> {
  const person = await upsertPerson(
    f.account.id,
    { providerPersonId: who, name: who, headline: null, profileUrl: null, avatarUrl: null },
    f.db,
  );
  f.db
    .prepare(
      `INSERT OR IGNORE INTO actions (id, account_id, kind, payload, scheduled_at, dedupe_key)
       VALUES ('act-h', ?, 'send_invite', '{}', datetime('now'), 'k-h')`,
    )
    .run(f.account.id);
  await recordInviteSent(
    {
      accountId: f.account.id,
      personId: person.id,
      actionId: 'act-h',
      providerInviteId: `inv-${who}`,
      sentAt: new Date(),
      withNote: false,
    },
    f.db,
  );
  f.db.prepare('UPDATE invites SET status = ? WHERE person_id = ?').run(status, person.id);
}

describe('ordering', () => {
  it('puts what needs you above everything else', async () => {
    const f = (current = await fixture());
    await invite(f, 'already-asked', 'sent');
    await createDraft(
      { accountId: f.account.id, kind: 'post', text: 'A draft awaiting a yes.', rationale: 'x' },
      f.db,
    );

    const { items } = await home(f.account.id, new Date(), f.db);
    expect(items[0]?.state).toBe('needs_you');
    expect(items.at(-1)?.state).toBe('sent');
  });
});

describe('wording', () => {
  it('says what is missing, not that something is pending', async () => {
    const f = (current = await fixture());
    await createDraft(
      {
        accountId: f.account.id,
        kind: 'post',
        text: 'I shipped [[what?]].',
        rationale: 'x',
        gaps: [
          { id: 'g1', prompt: 'what?', value: null, source: null, evidence: null },
        ],
      },
      f.db,
    );

    const { items } = await home(f.account.id, new Date(), f.db);
    expect(items[0]?.reason).toBe('1 blank only you can fill');
  });

  it.each([
    ['sent', 'Waiting'],
    ['accepted', 'Connected'],
    ['declined', "Didn't connect"],
    ['expired', "Didn't connect"],
    ['withdrawn', 'Taken back'],
  ])('reports %s as %s', async (status, expected) => {
    // "Didn't connect" covers both a refusal and someone who never opened
    // LinkedIn, because we cannot tell those apart and should not pretend to.
    const f = (current = await fixture());
    await invite(f, `p-${status}`, status);

    const { items } = await home(f.account.id, new Date(), f.db);
    expect(items.find((i) => i.state === 'sent')?.outcome).toBe(expected);
  });

  it('never surfaces a model name on the content', async () => {
    const f = (current = await fixture());
    await createDraft(
      {
        accountId: f.account.id,
        kind: 'post',
        text: 'Something written.',
        rationale: 'x',
        model: 'openai/gpt-oss-120b',
      },
      f.db,
    );

    const { items } = await home(f.account.id, new Date(), f.db);
    expect(JSON.stringify(items)).not.toMatch(/gpt|openai|model/i);
  });
});

describe('the digest is a yesterday object', () => {
  async function unattendedYesterday(f: Fixture): Promise<void> {
    const draft = await createDraft(
      { accountId: f.account.id, kind: 'post', text: 'Went out alone.', rationale: 'x' },
      f.db,
    );
    await setDraftStatus(draft.id, 'approved', 'timer', null, f.db);
    f.db
      .prepare("UPDATE drafts SET decided_at = datetime('now','-1 day') WHERE id = ?")
      .run(draft.id);
  }

  it('reports only what ran without anyone', async () => {
    const f = (current = await fixture());
    await unattendedYesterday(f);

    const approved = await createDraft(
      { accountId: f.account.id, kind: 'post', text: 'You approved this one.', rationale: 'x' },
      f.db,
    );
    await setDraftStatus(approved.id, 'approved', 'user', null, f.db);
    f.db
      .prepare("UPDATE drafts SET decided_at = datetime('now','-1 day') WHERE id = ?")
      .run(approved.id);

    const { digest } = await home(f.account.id, new Date(), f.db);
    expect(digest?.posts).toBe(1);
    expect(digest?.line).toMatch(/Yesterday, without you: 1 post/);
  });

  it('stays gone once dismissed', async () => {
    // Ambient things stop being read, so it appears once and then does not.
    const f = (current = await fixture());
    await unattendedYesterday(f);

    const first = await home(f.account.id, new Date(), f.db);
    expect(first.digest).not.toBeNull();

    await dismissDigest(f.account.id, first.digest!.day, f.db);
    expect((await home(f.account.id, new Date(), f.db)).digest).toBeNull();
  });

  it('says nothing when nothing ran alone', async () => {
    const f = (current = await fixture());
    expect((await home(f.account.id, new Date(), f.db)).digest).toBeNull();
  });
});
