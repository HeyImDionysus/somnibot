import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCookieGet, mockHeaderGet, mockAdminFrom } = vi.hoisted(() => ({
  mockCookieGet: vi.fn(),
  mockHeaderGet: vi.fn(),
  mockAdminFrom: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: mockCookieGet }),
  headers: vi.fn().mockResolvedValue({ get: mockHeaderGet }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn().mockReturnValue({ from: mockAdminFrom }),
}));

function guildQuery(data: { id: string; owner_discord_id: string } | null, error: Error | null = null) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

describe('resolveLauncherLocalAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE = '1';
    process.env.SESSION_TOKEN = 'launcher-session';
    process.env.DISCORD_GUILD_ID = 'guild-1,guild-2';
    mockHeaderGet.mockImplementation((name: string) => name === 'host' ? 'localhost:3456' : null);
    mockCookieGet.mockImplementation((name: string) =>
      name === 'somnibot-local-session' ? { value: 'launcher-session' } : undefined,
    );
    mockAdminFrom.mockReturnValue(guildQuery({ id: 'guild-1', owner_discord_id: 'owner-1' }));
  });

  afterEach(() => {
    delete process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE;
    delete process.env.SESSION_TOKEN;
    delete process.env.DISCORD_GUILD_ID;
  });

  it('resolves the configured guild as the local owner', async () => {
    const { resolveLauncherLocalAuth } = await import('@/lib/api/launcher-local-auth');

    await expect(resolveLauncherLocalAuth()).resolves.toEqual({
      kind: 'authorized',
      ctx: {
        userId: 'launcher-local',
        discordId: 'owner-1',
        guildId: 'guild-1',
        configuredGuildIds: ['guild-1', 'guild-2'],
      },
    });
  });

  it('uses an active configured guild and ignores a stale cookie', async () => {
    mockCookieGet.mockImplementation((name: string) => {
      if (name === 'somnibot-local-session') return { value: 'launcher-session' };
      if (name === 'active_guild_id') return { value: 'guild-2' };
      return undefined;
    });
    mockAdminFrom.mockReturnValue(guildQuery({ id: 'guild-2', owner_discord_id: 'owner-1' }));
    const { resolveLauncherLocalAuth } = await import('@/lib/api/launcher-local-auth');

    const selected = await resolveLauncherLocalAuth();
    expect(selected.kind).toBe('authorized');
    if (selected.kind === 'authorized') expect(selected.ctx.guildId).toBe('guild-2');

    mockCookieGet.mockImplementation((name: string) => {
      if (name === 'somnibot-local-session') return { value: 'launcher-session' };
      if (name === 'active_guild_id') return { value: 'other-guild' };
      return undefined;
    });
    mockAdminFrom.mockReturnValue(guildQuery({ id: 'guild-1', owner_discord_id: 'owner-1' }));
    const recovered = await resolveLauncherLocalAuth();
    expect(recovered.kind).toBe('authorized');
    if (recovered.kind === 'authorized') expect(recovered.ctx.guildId).toBe('guild-1');
  });

  it('rejects an unconfigured guild header', async () => {
    mockHeaderGet.mockImplementation((name: string) => {
      if (name === 'host') return 'localhost:3456';
      if (name === 'x-guild-id') return 'other-guild';
      return null;
    });
    const { resolveLauncherLocalAuth } = await import('@/lib/api/launcher-local-auth');

    await expect(resolveLauncherLocalAuth()).resolves.toEqual({
      kind: 'denied',
      status: 403,
      message: 'Forbidden',
    });
  });

  it('rejects a missing or mismatched local session cookie', async () => {
    mockCookieGet.mockReturnValue({ value: 'wrong-session' });
    const { resolveLauncherLocalAuth } = await import('@/lib/api/launcher-local-auth');

    await expect(resolveLauncherLocalAuth()).resolves.toEqual({
      kind: 'denied',
      status: 401,
      message: 'Unauthorized',
    });
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it('never enables launcher auth on a non-local host', async () => {
    mockHeaderGet.mockImplementation((name: string) => name === 'host' ? 'dashboard.example.com' : null);
    const { resolveLauncherLocalAuth } = await import('@/lib/api/launcher-local-auth');

    await expect(resolveLauncherLocalAuth()).resolves.toEqual({ kind: 'remote' });
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });
});
