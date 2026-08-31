import { describe, expect, it } from 'vitest';
import { currentVerifiedTrackIds } from '@/lib/dashboard/adoption-verification';

const now = Date.parse('2026-08-31T16:00:00Z');
const pass = { trackId: 'games', result: 'pass', eligible: true, checkedAt: '2026-08-31T15:59:00Z', expiresAt: '2026-08-31T16:03:00Z', reason: 'observed', evidenceIds: ['audit-1'] };

describe('current adoption verification projection', () => {
  it('allows a finite, current server-derived pass', () => {
    // Given current authoritative evidence; when projecting; then games is eligible.
    expect(currentVerifiedTrackIds([pass], now)).toEqual(['games']);
  });
  it.each([
    { result: 'fail' }, { result: 'unknown' }, { eligible: false },
    { expiresAt: null }, { expiresAt: '2026-08-31T16:00:00Z' },
    { checkedAt: '2026-08-31T16:01:00Z' }, { trackId: 'foreign' },
  ])('blocks invalid or stale evidence %j', (change) => {
    // Given a disqualified receipt; when projecting; then no activation is allowed.
    expect(currentVerifiedTrackIds([{ ...pass, ...change }], now)).toEqual([]);
  });
  it('does not preserve an earlier pass after a later failed check', () => {
    // Given non-canonical duplicate rows; when projecting; then fail closed.
    expect(currentVerifiedTrackIds([pass, { ...pass, result: 'fail' }], now)).toEqual([]);
  });
});
