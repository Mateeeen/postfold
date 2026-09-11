/**
 * Autopilot: what may act without a person, and what may not.
 *
 * The mode grants permission. Every other condition here can still withhold
 * it, and each of them withholds by HOLDING rather than dropping — the work
 * continues to exist, it just waits for someone.
 */

import { describe, expect, it } from 'vitest';
import { autopilotDecision, autoCapFor, automatedKindFor, LIMITS } from '../src/policy.js';
import type { AutopilotInput } from '../src/policy.js';

const base: AutopilotInput = {
  kind: 'post',
  mode: 'auto',
  band: 'healthy',
  unlocked: true,
  consecutiveAutoPosts: 0,
  grounded: true,
};

const decide = (over: Partial<AutopilotInput> = {}) => autopilotDecision({ ...base, ...over });

describe('mode is necessary but never sufficient', () => {
  it.each(['draft', 'ask'] as const)('mode %s never acts alone', (mode) => {
    expect(decide({ mode }).eligible).toBe(false);
  });

  it('auto with everything satisfied is eligible', () => {
    expect(decide().eligible).toBe(true);
  });

  it('holds when the type is not unlocked yet', () => {
    expect(decide({ unlocked: false }).eligible).toBe(false);
  });
});

describe('groundedness is still the gate', () => {
  it('an ungrounded post is held even on auto', () => {
    // The whole point of the gap work: mode grants permission, but an
    // ungrounded post is machine-written specifics nobody checked.
    const d = decide({ grounded: false });
    expect(d.eligible).toBe(false);
    expect(d.reason).toMatch(/blanks only you can fill/i);
  });

  it('groundedness is not asked of comments', () => {
    expect(decide({ kind: 'comment', grounded: false }).eligible).toBe(true);
  });
});

describe('the consecutive-post chain', () => {
  it('allows up to the limit', () => {
    expect(decide({ consecutiveAutoPosts: LIMITS.MAX_CONSECUTIVE_AUTO_POSTS - 1 }).eligible)
      .toBe(true);
  });

  it('drops the next one to needs-you', () => {
    const d = decide({ consecutiveAutoPosts: LIMITS.MAX_CONSECUTIVE_AUTO_POSTS });
    expect(d.eligible).toBe(false);
    expect(d.reason).toMatch(/in a row nobody read/i);
  });
});

describe('invites are stricter than everything else', () => {
  it('runs only on a healthy band', () => {
    expect(decide({ kind: 'connect', band: 'healthy' }).eligible).toBe(true);
  });

  it('switches ITSELF off at watch, where manual merely halves', () => {
    // The asymmetry is deliberate: a human throttled to half their cap is
    // still reading each person; autopilot is not.
    const d = decide({ kind: 'connect', band: 'watch' });
    expect(d.eligible).toBe(false);
    expect(d.selfDisabled).toBe(true);
    expect(d.reason).toMatch(/handed back to you/i);
  });

  it.each(['throttled', 'critical'] as const)('stays off at %s', (band) => {
    const d = decide({ kind: 'connect', band });
    expect(d.eligible).toBe(false);
    expect(d.selfDisabled).toBe(true);
  });

  it('will not run while unrated', () => {
    // Not enough resolved invitations is not the same as a good result.
    const d = decide({ kind: 'connect', band: 'unrated' });
    expect(d.eligible).toBe(false);
    expect(d.selfDisabled).toBe(false);
  });

  it('does not apply the band to posts or comments', () => {
    expect(decide({ kind: 'post', band: 'watch' }).eligible).toBe(true);
    expect(decide({ kind: 'comment', band: 'critical' }).eligible).toBe(true);
  });
});

describe('autopilot caps sit far below the manual ones', () => {
  it('is lower for every type that acts under a name', () => {
    expect(autoCapFor('comment')).toBeLessThan(LIMITS.HARD_DAILY_COMMENT_CAP * 20);
    expect(autoCapFor('connect')).toBeLessThan(LIMITS.HARD_DAILY_INVITE_CAP);
    expect(autoCapFor('post')).toBe(LIMITS.AUTO_DAILY_POST_CAP);
  });

  it('maps action kinds to the thing that has a mode', () => {
    expect(automatedKindFor('create_post')).toBe('post');
    expect(automatedKindFor('post_comment')).toBe('comment');
    expect(automatedKindFor('send_invite')).toBe('connect');
    expect(automatedKindFor('withdraw_invite')).toBe('withdraw');
    // Read-only syncs reach nobody, so they have no mode.
    expect(automatedKindFor('sync_trends')).toBeNull();
    expect(automatedKindFor('poll_acceptance')).toBeNull();
  });
});
