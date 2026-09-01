import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { PATCH } from '@/app/api/store/revenue-exceptions/[id]/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { buildRequest, createMockSupabase, mockAuthSuccess, mockRateLimitPass, registerTable } from './helpers';

describe('commerce risk transitions', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    vi.resetAllMocks();
    mock = createMockSupabase();
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  });

  it('uses the guild-scoped atomic transition that durably enqueues risk effects', async () => {
    const risks = registerTable(mock, 'commerce_risk_cases');
    risks.select.mockReturnValue(risks);
    risks.eq.mockReturnValue(risks);
    risks.maybeSingle.mockResolvedValue({ data: { id: '00000000-0000-4000-8000-000000000020' }, error: null });
    mock.rpc.mockResolvedValue({
      data: {
        id: '00000000-0000-4000-8000-000000000020',
        operation_id: '00000000-0000-4000-8000-000000000021',
        kind: 'confirmed_fraud',
      },
      error: null,
    });
    const audits = registerTable(mock, 'audit_logs');
    audits.insert.mockResolvedValue({ error: null });

    const response = await PATCH(buildRequest('/api/store/revenue-exceptions/00000000-0000-4000-8000-000000000030', {
      method: 'PATCH',
      body: {
        action: 'risk_transition',
        riskCaseId: '00000000-0000-4000-8000-000000000020',
        riskVersion: 4,
        transition: 'confirm_fraud',
        resolutionNote: 'Provider and order evidence matched.',
      },
    }), { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000030' }) });

    expect(response.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith('commerce_transition_risk_case', {
      p_guild_id: 'guild-1',
      p_risk_case_id: '00000000-0000-4000-8000-000000000020',
      p_expected_version: 4,
      p_actor_id: '123456789',
      p_action: 'confirm_fraud',
      p_resolution_note: 'Provider and order evidence matched.',
    });
  });
});
