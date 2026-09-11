/**
 * A global stop for when the vendor, not the account, is broken.
 *
 * Failures that are one account's problem must not trip this. A checkpoint is
 * LinkedIn asking that person to verify themselves; an auth failure is their
 * session dying; an invalid request is a bad target. Each of those is already
 * handled where it belongs, and counting them here would let one unhealthy
 * account stop sending for everybody.
 *
 * What this catches is the other shape: the provider returning 500s, or
 * timing out, across every account at once. Without it each account discovers
 * the outage separately by burning its own retry budget, and the queue spends
 * an outage manufacturing backoff instead of waiting.
 *
 * Deliberately in memory. It is a reaction to what is happening right now, and
 * a restart is a reasonable moment to find out whether the vendor is still
 * down. Persisting it would mean a redeploy inherits a stale verdict.
 *
 * Global, per process. `numReplicas: 1` is already load-bearing for the queue
 * (see README, "Scaling"); this is one more thing that assumes it.
 */

import { LIMITS } from '../policy.js';
import type { FailureClass } from '../types.js';

/**
 * Which failures suggest the provider is down rather than this account being
 * in trouble. The list is the whole design decision.
 */
const VENDOR_FAILURES: readonly FailureClass[] = ['transient', 'rate_limited'];

export function countsTowardBreaker(failureClass: FailureClass): boolean {
  return VENDOR_FAILURES.includes(failureClass);
}

interface BreakerState {
  /** Timestamps of recent vendor-level failures, oldest first. */
  failures: number[];
  openUntil: number | null;
}

const state: BreakerState = { failures: [], openUntil: null };

/** True while sending is stopped for everyone. */
export function isOpen(now: Date = new Date()): boolean {
  if (state.openUntil === null) return false;
  if (now.getTime() >= state.openUntil) {
    // Close on read rather than on a timer: nothing else is running when the
    // breaker is open, so there is no tick to close it.
    console.log('[breaker] closed — resuming sending');
    state.openUntil = null;
    state.failures = [];
    return false;
  }
  return true;
}

export function openUntil(): Date | null {
  return state.openUntil === null ? null : new Date(state.openUntil);
}

/**
 * Record a failure. Returns true if this one tripped the breaker.
 *
 * Called for every failure; the filtering happens here rather than at the call
 * site so there is one place that decides what a vendor failure is.
 */
export function recordFailure(
  failureClass: FailureClass,
  now: Date = new Date(),
): boolean {
  if (!countsTowardBreaker(failureClass)) return false;
  if (isOpen(now)) return false;

  const at = now.getTime();
  state.failures.push(at);
  state.failures = state.failures.filter((t) => at - t <= LIMITS.BREAKER_WINDOW_MS);

  if (state.failures.length < LIMITS.BREAKER_FAILURE_THRESHOLD) return false;

  state.openUntil = at + LIMITS.BREAKER_COOLDOWN_MS;
  // Loudly, because a silent global stop is indistinguishable from the product
  // having died, and the person looking at it needs to know which.
  console.error(
    `[breaker] OPEN — ${state.failures.length} provider failures in `
      + `${Math.round(LIMITS.BREAKER_WINDOW_MS / 1000)}s. All sending stops until `
      + `${new Date(state.openUntil).toISOString()}. This is a provider-wide fault, `
      + 'not an account problem; nothing needs to be done to the account.',
  );
  return true;
}

/** Record a success. Any progress is evidence the provider is answering. */
export function recordSuccess(): void {
  state.failures = [];
}

/** Test seam. */
export function reset(): void {
  state.failures = [];
  state.openUntil = null;
}
