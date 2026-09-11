/**
 * The breaker exists for one scenario: the provider is down, and every
 * account is about to discover that separately by burning its own retries.
 *
 * The tests that matter are the ones asserting what must NOT trip it. A
 * breaker that fires on per-account problems is worse than none — it turns
 * one unhealthy account into a global outage.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countsTowardBreaker,
  isOpen,
  openUntil,
  recordFailure,
  recordSuccess,
  reset,
} from '../src/queue/breaker.js';
import { LIMITS } from '../src/policy.js';
import type { FailureClass } from '../src/types.js';

const T0 = new Date('2026-01-01T12:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

beforeEach(() => reset());
afterEach(() => reset());

function fail(n: number, cls: FailureClass = 'transient', spacingMs = 1000): boolean {
  let tripped = false;
  for (let i = 0; i < n; i++) tripped = recordFailure(cls, at(i * spacingMs)) || tripped;
  return tripped;
}

describe('what trips it', () => {
  it('opens after the threshold inside the window', () => {
    expect(fail(LIMITS.BREAKER_FAILURE_THRESHOLD - 1)).toBe(false);
    expect(isOpen(at(0))).toBe(false);

    expect(recordFailure('transient', at(7000))).toBe(true);
    expect(isOpen(at(7000))).toBe(true);
  });

  it('counts rate limiting as a provider fault too', () => {
    fail(LIMITS.BREAKER_FAILURE_THRESHOLD, 'rate_limited');
    expect(isOpen(at(0))).toBe(true);
  });

  it('ignores failures spread beyond the window', () => {
    // Eight failures over an hour is a normal day, not an outage.
    fail(LIMITS.BREAKER_FAILURE_THRESHOLD, 'transient', LIMITS.BREAKER_WINDOW_MS);
    expect(isOpen(at(LIMITS.BREAKER_WINDOW_MS * 8))).toBe(false);
  });

  it('forgets the run once anything succeeds', () => {
    fail(LIMITS.BREAKER_FAILURE_THRESHOLD - 1);
    recordSuccess();
    expect(fail(LIMITS.BREAKER_FAILURE_THRESHOLD - 1)).toBe(false);
    expect(isOpen(at(0))).toBe(false);
  });
});

describe('what must never trip it', () => {
  it.each<FailureClass>(['checkpoint', 'auth', 'invalid', 'permanent'])(
    'a %s failure is one account\u2019s problem, not the vendor\u2019s',
    (cls) => {
      expect(countsTowardBreaker(cls)).toBe(false);
      fail(LIMITS.BREAKER_FAILURE_THRESHOLD * 3, cls);
      expect(isOpen(at(0))).toBe(false);
    },
  );

  it('does not trip on a mix dominated by account-level failures', () => {
    // Seven checkpoints and one timeout is one account in trouble.
    fail(7, 'checkpoint');
    recordFailure('transient', at(8000));
    expect(isOpen(at(8000))).toBe(false);
  });
});

describe('recovery', () => {
  it('closes itself once the cooldown passes', () => {
    // The last failure lands at t=7000, so the cooldown runs from there.
    const tripped = (LIMITS.BREAKER_FAILURE_THRESHOLD - 1) * 1000;
    fail(LIMITS.BREAKER_FAILURE_THRESHOLD);
    expect(isOpen(at(tripped))).toBe(true);
    expect(isOpen(at(tripped + LIMITS.BREAKER_COOLDOWN_MS - 1000))).toBe(true);
    expect(isOpen(at(tripped + LIMITS.BREAKER_COOLDOWN_MS + 1000))).toBe(false);
  });

  it('starts from a clean count after closing', () => {
    // Otherwise the first failure after recovery re-trips it immediately and
    // the breaker never actually reopens for traffic.
    const tripped = (LIMITS.BREAKER_FAILURE_THRESHOLD - 1) * 1000;
    fail(LIMITS.BREAKER_FAILURE_THRESHOLD);
    isOpen(at(tripped + LIMITS.BREAKER_COOLDOWN_MS + 1000));
    expect(
      recordFailure('transient', at(tripped + LIMITS.BREAKER_COOLDOWN_MS + 2000)),
    ).toBe(false);
  });

  it('reports when it will reopen, for anything that has to explain itself', () => {
    fail(LIMITS.BREAKER_FAILURE_THRESHOLD);
    expect(openUntil()).not.toBeNull();
    reset();
    expect(openUntil()).toBeNull();
  });

  it('does not count failures while already open', () => {
    // Nothing should be running, but if something is, a tripped breaker must
    // not extend itself indefinitely on the back of it.
    fail(LIMITS.BREAKER_FAILURE_THRESHOLD);
    const until = openUntil();
    recordFailure('transient', at(5000));
    expect(openUntil()?.getTime()).toBe(until?.getTime());
  });
});
