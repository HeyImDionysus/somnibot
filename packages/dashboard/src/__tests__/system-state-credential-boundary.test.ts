import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMockSupabase, registerTable } from './helpers';

const mocks = vi.hoisted(() => ({
  checkAdminRateLimit: vi.fn<() => Promise<null>>(),
  requireGuildOwner: vi.fn(),
  createAdminSupabase: vi.fn(),
  checkValkeyHealth: vi.fn<() => Promise<boolean>>(),
  readValkeyKey: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: mocks.checkAdminRateLimit }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: mocks.requireGuildOwner }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: mocks.createAdminSupabase }));
vi.mock('@/lib/api/rate-limit', () => ({
  checkValkeyHealth: mocks.checkValkeyHealth,
  readValkeyKey: mocks.readValkeyKey,
}));

import { GET as getSystemState } from '@/app/api/system-state/route';
import { GET as getDiagnosticBundle } from '@/app/api/system-state/diagnostic-bundle/route';

const ACTIVE_GUILD_ID = '1464713668766732393';

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

describe('system-state credential authorization boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.checkAdminRateLimit.mockResolvedValue(null);
    mocks.requireGuildOwner.mockResolvedValue({
      ok: true,
      ctx: { guildId: ACTIVE_GUILD_ID, discordId: 'ordinary-owner', userId: 'user-1' },
    });
    mocks.checkValkeyHealth.mockResolvedValue(true);
    mocks.readValkeyKey.mockResolvedValue(null);
  });

  it('does not enumerate deployment-global credentials for an ordinary guild owner', async () => {
    // Given an authenticated guild owner and a service-role database client.
    const admin = createMockSupabase();
    mocks.createAdminSupabase.mockReturnValue(admin);

    // When the owner reads their guild system state.
    const response = await getSystemState(request('/api/system-state'));
    const body: unknown = await response.json();

    // Then useful guild diagnostics remain available without touching global credentials.
    expect(response.status).toBe(200);
    expect(admin.from).not.toHaveBeenCalledWith('instance_settings');
    expect(body).toMatchObject({ success: true, data: { credentials: [] } });
  });

  it('keeps a cross-guild owner diagnostic bundle guild-scoped and credential-free', async () => {
    // Given an owner selected into one guild on a deployment that may contain others.
    const admin = createMockSupabase();
    const diagnostics = registerTable(admin, 'bot_diagnostics');
    const incidents = registerTable(admin, 'incidents');
    const operations = registerTable(admin, 'audit_logs');
    const deadLetters = registerTable(admin, 'action_queue_dlq');
    mocks.createAdminSupabase.mockReturnValue(admin);

    // When the owner exports a diagnostic bundle.
    const response = await getDiagnosticBundle(request('/api/system-state/diagnostic-bundle'));
    const body: unknown = await response.json();

    // Then every tenant-owned query is pinned to the selected guild and no global credential inventory is queried.
    expect(response.status).toBe(200);
    expect(diagnostics.eq).toHaveBeenCalledWith('guild_id', ACTIVE_GUILD_ID);
    expect(incidents.eq).toHaveBeenCalledWith('guild_id', ACTIVE_GUILD_ID);
    expect(operations.eq).toHaveBeenCalledWith('guild_id', ACTIVE_GUILD_ID);
    expect(deadLetters.eq).toHaveBeenCalledWith('guild_id', ACTIVE_GUILD_ID);
    expect(admin.from).not.toHaveBeenCalledWith('instance_settings');
    expect(body).toMatchObject({ success: true, data: { credentials: '[redacted]' } });
    expect(JSON.stringify(body)).not.toContain('discord_bot_token');
  });
});
