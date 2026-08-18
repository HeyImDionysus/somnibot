import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/admin-changes', () => ({ recordCrudChange: vi.fn().mockResolvedValue(undefined) }));

import { NextRequest } from 'next/server';
import { POST, PUT } from '@/app/api/stats-channels/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

let from: ReturnType<typeof vi.fn>;

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/stats-channels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function put(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/stats-channels', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  from = vi.fn();
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { guildId: '111111111111111111', discordId: '222222222222222222', userId: 'owner' },
  } as never);
  vi.mocked(createAdminSupabase).mockReturnValue({ from } as never);
});

describe('POST /api/stats-channels target validation', () => {
  it('rejects an empty create before a stats_channels row can be inserted', async () => {
    const response = await POST(post({
      stat_type: 'total_members',
      name_format: '👥 Members: {value}',
      stat_config: {},
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');
    expect(body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'stat_config.category_id' }),
    ]));
    expect(from).not.toHaveBeenCalled();
  });
});

describe('PUT /api/stats-channels placeholder validation', () => {
  it('names both accepted placeholders when an update format omits them', async () => {
    const response = await PUT(put({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name_format: '📊 Members',
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'name_format',
        message: 'name_format must contain {value} or {count}',
      }),
    ]));
    expect(from).not.toHaveBeenCalled();
  });
});
