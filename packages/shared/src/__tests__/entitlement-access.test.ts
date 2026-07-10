/**
 * W2 codex — isEntitlementAccessLive predicate.
 *
 * Single source of truth for "does this entitlement row grant access right
 * now", accounting for a lapsed payment-grace window. License validation and
 * heartbeat recompute the grace window at request time; the portal
 * download-link and protected file-download routes now share this exact rule
 * so they cannot keep serving a customer the SDK already rejects.
 */
import { describe, it, expect } from 'vitest';
import { isEntitlementAccessLive } from '../utils/index.js';

const NOW = new Date('2026-07-09T12:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();

describe('isEntitlementAccessLive', () => {
  it('active entitlements are always live', () => {
    expect(isEntitlementAccessLive({ status: 'active', grace_period_ends_at: null }, NOW)).toBe(true);
    // A stray deadline on an active row is irrelevant.
    expect(isEntitlementAccessLive({ status: 'active', grace_period_ends_at: PAST }, NOW)).toBe(true);
  });

  it('grace_period is live while the deadline is still in the future', () => {
    expect(isEntitlementAccessLive({ status: 'grace_period', grace_period_ends_at: FUTURE }, NOW)).toBe(true);
  });

  it('grace_period is NOT live once the deadline has passed (lapsed-but-unreconciled)', () => {
    expect(isEntitlementAccessLive({ status: 'grace_period', grace_period_ends_at: PAST }, NOW)).toBe(false);
  });

  it('grace_period with no recorded deadline is treated as live (reconciliation owns it)', () => {
    expect(isEntitlementAccessLive({ status: 'grace_period', grace_period_ends_at: null }, NOW)).toBe(true);
  });

  it('a deadline exactly at now is still live (boundary — not yet past)', () => {
    expect(
      isEntitlementAccessLive({ status: 'grace_period', grace_period_ends_at: NOW.toISOString() }, NOW),
    ).toBe(true);
  });

  it('every terminal / non-entitled status is not live', () => {
    for (const status of ['expired', 'cancelled', 'revoked', 'suspended', 'pending']) {
      expect(isEntitlementAccessLive({ status, grace_period_ends_at: null }, NOW)).toBe(false);
    }
  });

  it('null / undefined entitlement is not live', () => {
    expect(isEntitlementAccessLive(null, NOW)).toBe(false);
    expect(isEntitlementAccessLive(undefined, NOW)).toBe(false);
  });

  it('defaults to the real clock when no now is supplied', () => {
    // A far-future deadline is live under the real clock.
    const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(isEntitlementAccessLive({ status: 'grace_period', grace_period_ends_at: farFuture })).toBe(true);
  });
});
