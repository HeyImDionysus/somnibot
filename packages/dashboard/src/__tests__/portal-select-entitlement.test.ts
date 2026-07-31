import { describe, expect, it } from 'vitest';
import { selectDownloadEntitlement } from '@/lib/portal/select-entitlement';

describe('selectDownloadEntitlement — downloads bind to the intended purchase', () => {
  it('prefers the newest ORDER-BEARING entitlement over an orderless grant', () => {
    const picked = selectDownloadEntitlement([
      { id: 'grant', order_id: null, created_at: '2026-07-30T00:00:00Z' },
      { id: 'old-buy', order_id: 'order-1', created_at: '2026-07-01T00:00:00Z' },
      { id: 'rebuy', order_id: 'order-2', created_at: '2026-07-29T00:00:00Z' },
    ]);
    // The re-buy is the current purchase: its order is what the control room
    // expects the delivery evidence to land on.
    expect(picked?.id).toBe('rebuy');
  });

  it('falls back to the newest orderless grant when no order exists', () => {
    const picked = selectDownloadEntitlement([
      { id: 'grant-old', order_id: null, created_at: '2026-07-01T00:00:00Z' },
      { id: 'grant-new', order_id: null, created_at: '2026-07-29T00:00:00Z' },
    ]);
    expect(picked?.id).toBe('grant-new');
  });

  it('is deterministic regardless of input order', () => {
    const rows = [
      { id: 'a', order_id: 'o1', created_at: '2026-07-10T00:00:00Z' },
      { id: 'b', order_id: 'o2', created_at: '2026-07-20T00:00:00Z' },
    ];
    expect(selectDownloadEntitlement(rows)?.id).toBe('b');
    expect(selectDownloadEntitlement([...rows].reverse())?.id).toBe('b');
  });

  it('returns undefined for an empty live set', () => {
    expect(selectDownloadEntitlement([])).toBeUndefined();
  });
});
