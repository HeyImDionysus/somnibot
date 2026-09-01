import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { PATCH, POST } from '@/app/api/store/launch-runs/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { buildRequest, createMockSupabase, mockAuthSuccess, mockRateLimitPass, registerTable } from './helpers';

describe('Product Launch Run API', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    vi.resetAllMocks();
    mock = createMockSupabase();
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  });

  it('creates or reopens the real guild tutorial through the atomic database operation', async () => {
    mock.rpc.mockResolvedValue({ data: {
      id: '00000000-0000-4000-8000-000000000010',
      product_id: '00000000-0000-4000-8000-000000000011',
      operation_id: '00000000-0000-4000-8000-000000000012',
    }, error: null });

    const response = await POST(buildRequest('/api/store/launch-runs', {
      method: 'POST', body: { action: 'create_tutorial' },
    }));

    expect(response.status).toBe(201);
    expect(mock.rpc).toHaveBeenCalledWith('commerce_create_tutorial_launch', {
      p_guild_id: 'guild-1', p_actor_id: '123456789',
    });
    expect(mock.from).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ success: true, data: {
      id: '00000000-0000-4000-8000-000000000010',
    } });
  });

  it('rejects owner-supplied verified evidence before any launch state read or write', async () => {
    const response = await PATCH(buildRequest('/api/store/launch-runs', {
      method: 'PATCH',
      body: {
        runId: '00000000-0000-4000-8000-000000000010',
        version: 1,
        stage: 'webhook',
        state: 'verified',
        evidence: { claimed: true },
      },
    }));

    expect(response.status).toBe(400);
    expect(mock.from).not.toHaveBeenCalled();
  });

  it('returns a conflict when remove loses its optimistic-lock race', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null });

    const response = await POST(buildRequest('/api/store/launch-runs', {
      method: 'POST', body: {
        action: 'remove', runId: '00000000-0000-4000-8000-000000000010', version: 1,
      },
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'Launch run changed; reload before retrying' });
  });

  it('returns a safe error when the audited restart transaction fails', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: '08006', message: 'audit unavailable' } });

    const response = await POST(buildRequest('/api/store/launch-runs', {
      method: 'POST', body: {
        action: 'restart', runId: '00000000-0000-4000-8000-000000000010', version: 1,
      },
    }));

    expect(response.status).toBe(500);
    expect(mock.rpc).toHaveBeenCalledWith('commerce_mutate_product_launch', {
      p_guild_id: 'guild-1', p_actor_id: '123456789',
      p_launch_run_id: '00000000-0000-4000-8000-000000000010', p_expected_version: 1,
      p_action: 'restart',
    });
    expect(await response.json()).toMatchObject({ success: false, error: 'An internal error occurred' });
    expect(mock.from).not.toHaveBeenCalled();
  });

  it('starts an inactive product through one audited transaction', async () => {
    const products = registerTable(mock, 'products');
    products.maybeSingle.mockResolvedValue({ data: {
      id: '00000000-0000-4000-8000-000000000011', active: false,
    }, error: null });
    mock.rpc.mockResolvedValue({ data: {
      id: '00000000-0000-4000-8000-000000000010', version: 2,
    }, error: null });

    const response = await POST(buildRequest('/api/store/launch-runs', {
      method: 'POST', body: { action: 'start', productId: '00000000-0000-4000-8000-000000000011' },
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ success: true, data: { version: 2 } });
    expect(mock.rpc).toHaveBeenCalledWith('commerce_start_product_launch', {
      p_guild_id: 'guild-1', p_actor_id: '123456789',
      p_product_id: '00000000-0000-4000-8000-000000000011', p_tutorial: false,
    });
    expect(mock.from.mock.calls).toEqual([['products']]);
  });

  it('records stage failure and audit through the same transaction', async () => {
    mock.rpc.mockResolvedValue({ data: {
      id: '00000000-0000-4000-8000-000000000010', state: 'failed', version: 2,
    }, error: null });

    const response = await PATCH(buildRequest('/api/store/launch-runs', {
      method: 'PATCH', body: {
        runId: '00000000-0000-4000-8000-000000000010',
        version: 1, stage: 'webhook', state: 'failed', evidence: { error: 'signature mismatch' },
      },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { state: 'failed', version: 2 } });
    expect(mock.rpc).toHaveBeenCalledWith('commerce_mutate_product_launch', {
      p_guild_id: 'guild-1', p_actor_id: '123456789',
      p_launch_run_id: '00000000-0000-4000-8000-000000000010', p_expected_version: 1,
      p_action: 'stage', p_stage: 'webhook', p_stage_state: 'failed',
      p_evidence: { error: 'signature mismatch' },
    });
    expect(mock.from).not.toHaveBeenCalled();
  });
});
