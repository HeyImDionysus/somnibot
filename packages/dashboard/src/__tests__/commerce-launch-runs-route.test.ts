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
    const audits = registerTable(mock, 'audit_logs');
    audits.insert.mockResolvedValue({ error: null });

    const response = await POST(buildRequest('/api/store/launch-runs', {
      method: 'POST', body: { action: 'create_tutorial' },
    }));

    expect(response.status).toBe(201);
    expect(mock.rpc).toHaveBeenCalledWith('commerce_create_tutorial_launch', {
      p_guild_id: 'guild-1', p_actor_id: '123456789',
    });
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
    const runs = registerTable(mock, 'commerce_product_launch_runs');
    runs.maybeSingle
      .mockResolvedValueOnce({ data: {
        id: '00000000-0000-4000-8000-000000000010',
        product_id: '00000000-0000-4000-8000-000000000011',
        operation_id: '00000000-0000-4000-8000-000000000012',
      }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const response = await POST(buildRequest('/api/store/launch-runs', {
      method: 'POST', body: {
        action: 'remove', runId: '00000000-0000-4000-8000-000000000010', version: 1,
      },
    }));

    expect(response.status).toBe(409);
  });

  it('fails closed when a restart mutation cannot write operation-linked audit evidence', async () => {
    const runs = registerTable(mock, 'commerce_product_launch_runs');
    runs.maybeSingle.mockResolvedValue({ data: {
      id: '00000000-0000-4000-8000-000000000010',
      product_id: '00000000-0000-4000-8000-000000000011',
      operation_id: '00000000-0000-4000-8000-000000000012',
      version: 2,
    }, error: null });
    const audits = registerTable(mock, 'audit_logs');
    audits.insert.mockResolvedValue({ error: { code: '08006', message: 'audit unavailable' } });

    const response = await POST(buildRequest('/api/store/launch-runs', {
      method: 'POST', body: {
        action: 'restart', runId: '00000000-0000-4000-8000-000000000010', version: 1,
      },
    }));

    expect(response.status).toBe(500);
    expect(audits.insert).toHaveBeenCalledWith(expect.objectContaining({
      action: 'commerce.launch.restart',
      target_id: '00000000-0000-4000-8000-000000000011',
      details: expect.objectContaining({ operation_id: '00000000-0000-4000-8000-000000000012' }),
    }));
  });

  it('records a stage failure against the launch operation identity', async () => {
    const runs = registerTable(mock, 'commerce_product_launch_runs');
    runs.maybeSingle
      .mockResolvedValueOnce({ data: {
        id: '00000000-0000-4000-8000-000000000010',
        product_id: '00000000-0000-4000-8000-000000000011',
        operation_id: '00000000-0000-4000-8000-000000000012',
        stages: {}, version: 1,
      }, error: null })
      .mockResolvedValueOnce({ data: { id: '00000000-0000-4000-8000-000000000010' }, error: null });
    const audits = registerTable(mock, 'audit_logs');
    audits.insert.mockResolvedValue({ error: null });

    const response = await PATCH(buildRequest('/api/store/launch-runs', {
      method: 'PATCH', body: {
        runId: '00000000-0000-4000-8000-000000000010',
        version: 1, stage: 'webhook', state: 'failed', evidence: { error: 'signature mismatch' },
      },
    }));

    expect(response.status).toBe(200);
    expect(audits.insert).toHaveBeenCalledWith(expect.objectContaining({
      action: 'commerce.launch.stage_changed',
      details: expect.objectContaining({
        operation_id: '00000000-0000-4000-8000-000000000012',
        stage: 'webhook', state: 'failed',
      }),
    }));
  });
});
