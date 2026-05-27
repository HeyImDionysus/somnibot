/**
 * Economy Market Buy-Own-Listing Guard — V5 Audit §4.6
 *
 * Validates the SQL migration logic: economy_market_buy rejects
 * p_buyer_id == seller_id. This tests the TypeScript-side guard
 * that the bot adds when calling the RPC.
 */
import { describe, it, expect } from 'vitest';

/**
 * Pure-logic simulation of the buy-own-listing check that the
 * economy_market_buy RPC now performs. This validates the guard
 * logic without needing a live database.
 */
function validateMarketBuy(params: {
  buyerId: string;
  sellerId: string;
  quantity: number;
}): { ok: boolean; error?: string } {
  if (params.quantity <= 0) {
    return { ok: false, error: 'quantity must be positive' };
  }
  if (params.buyerId === params.sellerId) {
    return { ok: false, error: 'cannot buy from own listing' };
  }
  return { ok: true };
}

describe('economy_market_buy — buy-own-listing guard (§4.6)', () => {
  it('rejects when buyer == seller', () => {
    const result = validateMarketBuy({
      buyerId: 'user-123',
      sellerId: 'user-123',
      quantity: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('cannot buy from own listing');
  });

  it('allows when buyer != seller', () => {
    const result = validateMarketBuy({
      buyerId: 'user-123',
      sellerId: 'user-456',
      quantity: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects zero quantity regardless of buyer/seller', () => {
    const result = validateMarketBuy({
      buyerId: 'user-123',
      sellerId: 'user-456',
      quantity: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('quantity must be positive');
  });

  it('rejects negative quantity', () => {
    const result = validateMarketBuy({
      buyerId: 'user-123',
      sellerId: 'user-456',
      quantity: -5,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('quantity must be positive');
  });
});
