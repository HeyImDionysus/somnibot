import { describe, expect, it } from 'vitest';

import { isFulfillmentEntitlementSource } from '../features/commerce/entitlement-service.js';

describe('free-claim fulfillment entitlement source', () => {
  it.each([
    { source: 'purchase', freeClaim: false, expected: true },
    { source: null, freeClaim: false, expected: false },
    { source: 'manual', freeClaim: false, expected: false },
    { source: 'manual', freeClaim: true, expected: true },
    { source: 'giveaway', freeClaim: true, expected: false },
  ])('returns $expected for source=$source freeClaim=$freeClaim', ({ source, freeClaim, expected }) => {
    expect(isFulfillmentEntitlementSource(source, freeClaim)).toBe(expected);
  });
});
