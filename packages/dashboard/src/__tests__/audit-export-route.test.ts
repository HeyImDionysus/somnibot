import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));

import { GET } from '@/app/api/audit/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

const guildId = '111111111111111111';

describe('GET /api/audit export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkAdminRateLimit).mockResolvedValue(null);
    vi.mocked(requireGuildOwner).mockResolvedValue({
      ok: true,
      ctx: { guildId, discordId: '222222222222222222', userId: 'owner' },
    } as never);

    const configQuery = {
      select: vi.fn(() => configQuery),
      eq: vi.fn(() => configQuery),
      maybeSingle: vi.fn(async () => ({ data: { audit_export_row_limit: 100 }, error: null })),
    };
    const auditQuery = {
      select: vi.fn(() => auditQuery),
      eq: vi.fn(() => auditQuery),
      order: vi.fn(() => auditQuery),
      limit: vi.fn(() => auditQuery),
      range: vi.fn(() => auditQuery),
      then: (resolve: (value: unknown) => unknown) => resolve({
        data: [{
          timestamp: '2026-08-10T12:00:00.000Z',
          action: 'qa.audit.export',
          category: 'system',
          actor_type: 'dashboard',
          actor_id: '222222222222222222',
          target_type: null,
          target_id: null,
          success: true,
          error_message: null,
          details: {},
        }],
        error: null,
        count: 1,
      }),
    };

    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => table === 'guild_config' ? configQuery : auditQuery),
    } as never);
  });

  it.each([
    ['csv', 'text/csv', '.csv'],
    ['json', 'application/json', '.json'],
  ])('returns %s as an attachment instead of an inline API payload', async (format, contentType, extension) => {
    const response = await GET(new Request(`http://localhost/api/audit?export=true&format=${format}`) as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(contentType);
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="audit-log-');
    expect(response.headers.get('content-disposition')).toContain(extension);
    if (format === 'json') {
      await expect(response.json()).resolves.toEqual([
        expect.objectContaining({ action: 'qa.audit.export' }),
      ]);
    }
  });
});
