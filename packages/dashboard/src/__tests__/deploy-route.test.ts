import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/admin-changes', () => ({
  recordAdminChange: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/deploy/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { createAdminSupabase } from '@/lib/supabase/admin';

const categories = [
  { key: 'cat-information', name: 'Information', position: 0 },
  { key: 'cat-general', name: 'General', position: 1 },
];

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://dashboard.test/api/deploy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeSupabase(
  rows: Record<string, unknown | null> = {},
  errors: Record<string, { message: string } | null> = {},
) {
  const writes: Array<{ table: string; payload: unknown }> = [];
  const builders = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const from = vi.fn((table: string) => {
    const existing = builders.get(table);
    if (existing) return existing;
    const builder = {} as Record<string, ReturnType<typeof vi.fn>>;
    for (const method of ['select', 'eq', 'order', 'limit']) {
      builder[method] = vi.fn(() => builder);
    }
    builder.upsert = vi.fn((payload: unknown) => {
      writes.push({ table, payload });
      return builder;
    });
    builder.insert = vi.fn((payload: unknown) => {
      writes.push({ table, payload });
      return builder;
    });
    const result = { data: rows[table] ?? null, error: errors[table] ?? null };
    builder.single = vi.fn().mockResolvedValue(result);
    builder.maybeSingle = vi.fn().mockResolvedValue(result);
    builder.then = vi.fn((resolve: (value: typeof result) => unknown) => resolve(result));
    builders.set(table, builder);
    return builder;
  });
  return { client: { from }, writes, builders };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkAdminRateLimit).mockResolvedValue(null);
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: 'discord-1', guildId: 'guild-1' },
  });
});

describe('POST /api/deploy persistence', () => {
  it('stores a safe deployment even before setup and ignores legacy cleanExisting', async () => {
    const supabase = makeSupabase({
      guild_desired_state: { applied_at: null },
      guild: { setup_completed: false },
    });
    vi.mocked(createAdminSupabase).mockReturnValue(supabase.client as never);

    const response = await POST(request({
      action: 'deploy',
      roles: [{ key: 'member' }],
      channels: [{ key: 'general', categoryKey: 'cat-general' }],
      categories,
      cleanExisting: true,
    }));

    expect(response.status).toBe(200);
    const desiredWrite = supabase.writes.find((write) => write.table === 'guild_desired_state');
    expect(desiredWrite?.payload).toMatchObject({
      categories,
      applied_at: null,
      deploy_mode: 'safe',
    });
    expect(supabase.writes.some((write) => write.table === 'audit_logs')).toBe(true);
  });

  it('rejects a destructive deployment without an explicit confirmation', async () => {
    const supabase = makeSupabase({ guild: { setup_completed: false } });
    vi.mocked(createAdminSupabase).mockReturnValue(supabase.client as never);

    const response = await POST(request({
      action: 'deploy',
      roles: [{ key: 'member' }],
      channels: [{ key: 'general', categoryKey: 'cat-general' }],
      categories,
      deployMode: 'destructive',
    }));

    expect(response.status).toBe(400);
    expect(supabase.writes.some((write) => write.table === 'guild_desired_state')).toBe(false);
  });

  it('persists destructive mode only when explicitly requested and confirmed', async () => {
    const supabase = makeSupabase({ guild: { setup_completed: false } });
    vi.mocked(createAdminSupabase).mockReturnValue(supabase.client as never);

    const response = await POST(request({
      action: 'deploy',
      roles: [{ key: 'member' }],
      channels: [{ key: 'general', categoryKey: 'cat-general' }],
      categories,
      deployMode: 'destructive',
      confirmDestructive: true,
    }));

    expect(response.status).toBe(200);
    const desiredWrite = supabase.writes.find((write) => write.table === 'guild_desired_state');
    expect(desiredWrite?.payload).toMatchObject({
      categories,
      applied_at: null,
      deploy_mode: 'destructive',
    });
  });

  it('rejects a save-draft action without signaling the bot to deploy', async () => {
    const supabase = makeSupabase();
    vi.mocked(createAdminSupabase).mockReturnValue(supabase.client as never);

    const response = await POST(request({
      action: 'save-draft',
      roles: [{ key: 'member' }],
      channels: [{ key: 'general', categoryKey: 'cat-general' }],
      categories,
    }));

    expect(response.status).toBe(400);
    expect(supabase.writes.some((write) => write.table === 'guild_desired_state')).toBe(false);
  });

  it('rejects a request that does not explicitly name the deploy action', async () => {
    const supabase = makeSupabase();
    vi.mocked(createAdminSupabase).mockReturnValue(supabase.client as never);

    const response = await POST(request({
      roles: [{ key: 'member' }],
      channels: [{ key: 'general', categoryKey: 'cat-general' }],
      categories,
    }));

    expect(response.status).toBe(400);
    expect(supabase.writes.some((write) => write.table === 'guild_desired_state')).toBe(false);
  });

  it('fails closed when prior deployment state cannot be read', async () => {
    const supabase = makeSupabase(
      { guild: { setup_completed: false } },
      { guild_desired_state: { message: 'read failed' } },
    );
    vi.mocked(createAdminSupabase).mockReturnValue(supabase.client as never);

    const response = await POST(request({
      action: 'deploy',
      roles: [{ key: 'member' }],
      channels: [{ key: 'general', categoryKey: 'cat-general' }],
      categories,
    }));

    expect(response.status).toBe(500);
    expect(supabase.writes.some((write) => write.table === 'guild_desired_state')).toBe(false);
  });
});
