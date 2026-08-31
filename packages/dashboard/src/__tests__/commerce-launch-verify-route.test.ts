import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { POST } from '@/app/api/store/launch-runs/[id]/verify/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  buildRequest,
  createMockSupabase,
  mockAuthSuccess,
  mockRateLimitPass,
  registerTable,
} from './helpers';

const RUN_ID = '00000000-0000-4000-8000-000000000201';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000202';
const WINDOW_START = '2026-08-23T12:00:00.000Z';

describe('Product Launch verification evidence boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  });

  it('queries paid and free proof ledgers by exact run, product, guild, and verification window', async () => {
    const mock = createMockSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    const runs = registerTable(mock, 'commerce_product_launch_runs');
    runs.maybeSingle.mockResolvedValue({ data: {
      id: RUN_ID,
      product_id: PRODUCT_ID,
      operation_id: '00000000-0000-4000-8000-000000000203',
      is_tutorial: false,
      version: 1,
      verification_started_at: WINDOW_START,
    }, error: null });
    registerTable(mock, 'products');
    registerTable(mock, 'product_license_config');
    registerTable(mock, 'product_files');
    const checkoutIntents = registerTable(mock, 'commerce_checkout_intents');
    checkoutIntents.limit.mockResolvedValue({
      data: null,
      error: { code: '08006', message: 'stop after inspecting proof boundary' },
    });
    const freeClaims = registerTable(mock, 'commerce_free_claims');
    freeClaims.limit.mockResolvedValue({ data: [], error: null });

    const response = await POST(
      buildRequest(`/api/store/launch-runs/${RUN_ID}/verify`, { method: 'POST' }),
      { params: Promise.resolve({ id: RUN_ID }) },
    );

    expect(response.status).toBe(500);
    for (const table of [checkoutIntents, freeClaims]) {
      expect(table.eq).toHaveBeenCalledWith('guild_id', 'guild-1');
      expect(table.eq).toHaveBeenCalledWith('product_id', PRODUCT_ID);
      expect(table.eq).toHaveBeenCalledWith('launch_run_id', RUN_ID);
      expect(table.gte).toHaveBeenCalledWith('created_at', WINDOW_START);
    }
  });
});
