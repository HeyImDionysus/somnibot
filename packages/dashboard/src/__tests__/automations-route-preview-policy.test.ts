import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn() }));
vi.mock('@/lib/admin-changes', () => ({
  readRowBefore: vi.fn(),
  recordCrudChange: vi.fn(),
}));

import { POST, PUT } from '@/app/api/automations/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { buildRequest, mockAuthSuccess, mockRateLimitPass } from './helpers';

const AUTOMATION_ID = '00000000-0000-4000-8000-000000000001';
const TEST_SUPABASE_URL = 'https://somnibot-test.supabase.co';
const TEST_SUPABASE_KEY = 'test-service-role-key';

type AutomationSupabaseFixture = {
  readonly supabase: SupabaseClient;
  readonly requests: Request[];
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createAutomationSupabase(responseForRequest: (request: Request) => Response): AutomationSupabaseFixture {
  const requests: Request[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return responseForRequest(request);
  });
  const supabase: SupabaseClient = createClient(TEST_SUPABASE_URL, TEST_SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: fetchMock },
  });

  return { supabase, requests };
}

function failedPreviewPolicyRead(): Response {
  return jsonResponse({ message: 'read failed' }, 500);
}

describe('/api/automations preview policy read failures', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthSuccess(vi.mocked(requireGuildOwner));
    mockRateLimitPass(vi.mocked(checkAdminRateLimit));
  });

  it('fails closed before creating when the preview policy query returns an error', async () => {
    const fixture = createAutomationSupabase(failedPreviewPolicyRead);
    vi.mocked(createAdminSupabase).mockReturnValue(fixture.supabase);

    const response = await POST(buildRequest('/api/automations', {
      method: 'POST',
      body: { name: 'Welcome', trigger_type: 'member.joined' },
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Automation preview policy is unavailable. Retry after restoring the guild configuration.',
      errorDetails: {
        code: 'automation_preview_policy_unavailable',
        retryable: true,
        requiredAction: 'Restore the guild automation preview policy, then retry the operation.',
      },
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.url).toContain('/rest/v1/guild_config');
  });

  it('fails closed before updating when the preview policy query rejects', async () => {
    const fixture = createAutomationSupabase(failedPreviewPolicyRead);
    vi.mocked(createAdminSupabase).mockReturnValue(fixture.supabase);

    const response = await PUT(buildRequest('/api/automations', {
      method: 'PUT',
      body: { id: AUTOMATION_ID, name: 'Renamed' },
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      errorDetails: { code: 'automation_preview_policy_unavailable' },
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.url).toContain('/rest/v1/guild_config');
  });

  it('fails closed before enabling when the preview policy query rejects', async () => {
    const fixture = createAutomationSupabase(failedPreviewPolicyRead);
    vi.mocked(createAdminSupabase).mockReturnValue(fixture.supabase);

    const response = await PUT(buildRequest('/api/automations', {
      method: 'PUT',
      body: { id: AUTOMATION_ID, enabled: true },
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      errorDetails: { code: 'automation_preview_policy_unavailable' },
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.url).toContain('/rest/v1/guild_config');
  });
});
