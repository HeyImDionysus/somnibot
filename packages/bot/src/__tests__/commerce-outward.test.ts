import { describe, expect, it, vi } from 'vitest';
import {
  runCommerceOutwardIntent,
  type CommerceOutwardIntentKind,
} from '../services/commerce-outward.js';

describe('commerce lifecycle outward supersession', () => {
  it.each([
    'subscription_cancelled_event',
    'subscription_cancelled_dm',
  ] satisfies CommerceOutwardIntentKind[])(
    'treats a superseded %s as a terminal no-send',
    async (intentKind) => {
      const dispatch = vi.fn(async () => {});
      const cancel = vi.fn();
      const supabase = {
        rpc: vi.fn(async () => ({
          data: {
            order_id: '11111111-1111-4111-8111-111111111111',
            guild_id: 'guild-1',
            intent_kind: intentKind,
            outward_generation_id: '22222222-2222-4222-8222-222222222222',
            disposition: 'superseded',
            state: 'superseded',
            attempt_token: null,
            alert_id: null,
          },
          error: null,
        })),
      };

      const result = await runCommerceOutwardIntent(
        supabase as never,
        {
          orderId: '11111111-1111-4111-8111-111111111111',
          guildId: 'guild-1',
          intentKind,
          outwardGenerationId: '22222222-2222-4222-8222-222222222222',
          actionId: '33333333-3333-4333-8333-333333333333',
          claimToken: '44444444-4444-4444-8444-444444444444',
        },
        { dispatch, cancel },
        'generated',
      );

      expect(result).toEqual({ state: 'superseded' });
      expect(cancel).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
});
