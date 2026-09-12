/**
 * Autopilot is earned, and the progress lines are shown to the user verbatim.
 * So the strings are part of the contract, not debug output.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { autopilotUnlock } from '../src/unlock.js';
import { createDraft } from '../src/db/drafts.js';
import { recordInviteSent, upsertPerson } from '../src/db/content.js';
import { LIMITS } from '../src/policy.js';
import { fixture } from './helpers.js';
import type { Fixture } from './helpers.js';

let current: Fixture | null = null;
afterEach(() => {
  current?.db.close();
  current = null;
});

const DAY = 86_400_000;

/** A post that scores strong: varied rhythm, real specifics, no cliches. */
const STRONG = [
  'We moved the scheduler off cron last Tuesday.',
  'It took four hours.',
  'The interesting part was not the migration but what it exposed: three jobs',
  'had been silently failing since March because nobody read the exit codes,',
  'and Postgres had been carrying the retry queue the whole time.',
].join('\n');

async function withDrafts(f: Fixture, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await createDraft(
      { accountId: f.account.id, kind: 'post', text: STRONG, rationale: 'x' },
      f.db,
    );
  }
}

async function resolvedInvites(f: Fixture, n: number, accepted: number): Promise<void> {
  f.db
    .prepare(
      `INSERT INTO actions (id, account_id, kind, payload, scheduled_at, dedupe_key)
       VALUES ('act-u', ?, 'send_invite', '{}', datetime('now'), 'k-u')`,
    )
    .run(f.account.id);

  for (let i = 0; i < n; i++) {
    const person = await upsertPerson(
      f.account.id,
      {
        providerPersonId: `u-${i}`,
        name: 'X',
        headline: null,
        profileUrl: null,
        avatarUrl: null,
      },
      f.db,
    );
    await recordInviteSent(
      {
        accountId: f.account.id,
        personId: person.id,
        actionId: 'act-u',
        providerInviteId: `inv-${i}`,
        sentAt: new Date(),
        withNote: false,
      },
      f.db,
    );
    f.db
      .prepare('UPDATE invites SET status = ? WHERE person_id = ?')
      .run(i < accepted ? 'accepted' : 'declined', person.id);
  }
}

describe('nothing runs unattended in the first week', () => {
  it('locks every type that acts under a name', async () => {
    const f = (current = await fixture({ connectedDaysAgo: 2 }));
    await withDrafts(f, 10);

    const u = await autopilotUnlock(f.account.id, new Date(), f.db);
    expect(u.post.unlocked).toBe(false);
    expect(u.post.reason).toMatch(/Unlocks on day 7 — 4 more days\./);
    expect(u.connect.unlocked).toBe(false);
  });

  it('never locks withdrawal', async () => {
    // It removes an action rather than adding one, and an unanswered
    // invitation is not made safer by leaving it outstanding.
    const f = (current = await fixture({ connectedDaysAgo: 0 }));
    expect((await autopilotUnlock(f.account.id, new Date(), f.db)).withdraw.unlocked).toBe(
      true,
    );
  });
});

describe('posts and comments unlock on strong drafts', () => {
  it('counts down in the message', async () => {
    const f = (current = await fixture({ connectedDaysAgo: 30 }));
    await withDrafts(f, LIMITS.AUTOPILOT_MIN_STRONG_DRAFTS - 1);

    const u = await autopilotUnlock(f.account.id, new Date(), f.db);
    expect(u.post.unlocked).toBe(false);
    expect(u.post.reason).toBe('Unlocks after 1 more strong draft.');
  });

  it('opens once enough drafts read strong', async () => {
    const f = (current = await fixture({ connectedDaysAgo: 30 }));
    await withDrafts(f, LIMITS.AUTOPILOT_MIN_STRONG_DRAFTS);

    const u = await autopilotUnlock(f.account.id, new Date(), f.db);
    expect(u.post.unlocked).toBe(true);
    expect(u.post.reason).toBeNull();
    expect(u.comment.unlocked).toBe(true);
  });
});

describe('invites unlock on answers, not on sends', () => {
  it('counts ANSWERED invitations, never sent ones', async () => {
    // Saying "sent" would invite someone to send more to unlock faster, which
    // is precisely the behaviour the acceptance rate exists to discourage.
    const f = (current = await fixture({ connectedDaysAgo: 30 }));
    await resolvedInvites(f, 5, 5);

    const u = await autopilotUnlock(f.account.id, new Date(), f.db);
    expect(u.connect.reason).toBe('Unlocks after 15 more invitations are answered.');
  });

  it('holds on the band once there are enough answers', async () => {
    const f = (current = await fixture({ connectedDaysAgo: 30 }));
    await resolvedInvites(f, LIMITS.AUTOPILOT_MIN_RESOLVED_INVITES, 2);

    const u = await autopilotUnlock(f.account.id, new Date(), f.db);
    expect(u.connect.unlocked).toBe(false);
    expect(u.connect.reason).toMatch(/acceptance is comfortably above \d+%/);
  });

  it('opens on a healthy rate over a real sample', async () => {
    const f = (current = await fixture({ connectedDaysAgo: 30 }));
    await resolvedInvites(f, LIMITS.AUTOPILOT_MIN_RESOLVED_INVITES, 18);

    const u = await autopilotUnlock(f.account.id, new Date(), f.db);
    expect(u.connect.unlocked).toBe(true);
  });

  it('does not let good writing unlock invites', async () => {
    // The conditions are per type on purpose: writing well says nothing about
    // whether strangers want to hear from you.
    const f = (current = await fixture({ connectedDaysAgo: 30 }));
    await withDrafts(f, 10);

    const u = await autopilotUnlock(f.account.id, new Date(), f.db);
    expect(u.post.unlocked).toBe(true);
    expect(u.connect.unlocked).toBe(false);
  });
});
