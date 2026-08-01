import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/rbac', () => ({
  requirePermission: vi.fn(),
  authErrorResponse: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(),
}));

import { GET } from '@/app/api/dashboard/feature-status/route';
import { requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';

function chain(data: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn(async () => ({ data, error: null }));
  return query;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({
    guildId: 'guild-1',
    discordId: 'member-1',
    isOwner: false,
    permissions: [],
  } as never);
});

describe('GET /api/dashboard/feature-status', () => {
  it('uses the guild RBAC context and returns only feature readiness data', async () => {
    const config = chain({ economy_enabled: true });
    const heartbeat = chain({ snapshot_at: new Date().toISOString() });
    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => table === 'guild_config' ? config : heartbeat),
    } as never);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith(null);
    expect(config.eq).toHaveBeenCalledWith('guild_id', 'guild-1');
    expect(heartbeat.eq).toHaveBeenCalledWith('guild_id', 'guild-1');
    expect(body).toMatchObject({
      success: true,
      data: {
        config: { economy_enabled: true },
        bot: { online: true },
      },
    });
  });

  it('rejects runtime rows stranded by an earlier boot (round 28)', async () => {
    const config = chain({ stats_channels_enabled: true });
    const heartbeat = chain({ snapshot_at: new Date().toISOString(), boot_id: 'boot-B' });
    const runtime = chain(null) as Record<string, unknown>;
    runtime.then = (resolve: (value: unknown) => void) => resolve({
      data: [
        { feature: 'stats_channels', boot_id: 'boot-A' },
        { feature: 'temp_channels', boot_id: 'boot-B' },
        { feature: 'giveaways', boot_id: '' },
      ],
      error: null,
    });
    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => table === 'guild_config'
        ? config
        : table === 'bot_diagnostics' ? heartbeat : runtime),
    } as never);

    const response = await GET();
    const body = await response.json();

    // stats_channels was written by boot-A while the live heartbeat is
    // boot-B: a failed re-init must not read as running just because the
    // heartbeat recovered. Empty boot ids fail open (pre-identity writer).
    expect(response.status).toBe(200);
    expect(body.data.runtimeFeatures).toEqual(['temp_channels', 'giveaways']);
  });

  it('never lets an UNidentified diagnostics row admit identified runtime rows (round 29)', async () => {
    // Health rows are per-guild; before they carried boot ids, the newest
    // diagnostics row for a non-primary guild had none — failing open there
    // admitted rows from ANY prior boot.
    const config = chain({ stats_channels_enabled: true });
    const heartbeat = chain({ snapshot_at: new Date().toISOString() });
    const runtime = chain(null) as Record<string, unknown>;
    runtime.then = (resolve: (value: unknown) => void) => resolve({
      data: [
        { feature: 'stats_channels', boot_id: 'boot-A' },
        { feature: 'giveaways', boot_id: '' },
      ],
      error: null,
    });
    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => table === 'guild_config'
        ? config
        : table === 'bot_diagnostics' ? heartbeat : runtime),
    } as never);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    // The identified row is rejected without an identified heartbeat; only
    // the legacy row fails open.
    expect(body.data.runtimeFeatures).toEqual(['giveaways']);
  });

  it('reports a MISSING guild_config row as null, never as everything-disabled', async () => {
    // Review 3689865706: new-guild init tolerates a failed config insert, and
    // the bot then runs defaults like `temp_channels_enabled !== false`.
    // Coercing the missing row to {} made every configured flag read false —
    // the panel said "disabled" for features the bot was actually running.
    // null renders as 'status unavailable', which is the truth.
    const config = chain(null);
    const heartbeat = chain({ snapshot_at: new Date().toISOString() });
    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => table === 'guild_config' ? config : heartbeat),
    } as never);

    const body = await (await GET()).json();
    expect(body.data.config).toBeNull();
  });

  it('treats a heartbeat beyond the allowed future clock skew as unavailable', async () => {
    const config = chain({ economy_enabled: true });
    const heartbeat = chain({ snapshot_at: new Date(Date.now() + 5 * 60_000).toISOString() });
    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => table === 'guild_config' ? config : heartbeat),
    } as never);

    const body = await (await GET()).json();
    expect(body.data.bot).toEqual({ online: false, staleSecs: null });
  });
});

describe('deriveFeatureReadiness — runtime-gated readiness (round 22)', () => {
  it('reports enabled-but-uninitialized instead of reachable when the manager never started', async () => {
    const { deriveFeatureReadiness, featureForPath } =
      await import('@/lib/dashboard/feature-status');
    const feature = featureForPath('/temp-channels')!;
    const base = {
      feature,
      config: { temp_channels_enabled: true },
      botOnline: true,
      staleSecs: 5,
    };
    // Enabled after boot: heartbeat is current but no manager exists.
    expect(deriveFeatureReadiness({ ...base, runtimeFeatures: ['stats_channels'] }))
      .toMatchObject({ state: 'blocked', heading: expect.stringContaining('awaiting bot restart') });
    // Initialized this boot: operational.
    expect(deriveFeatureReadiness({ ...base, runtimeFeatures: ['temp_channels'] }))
      .toMatchObject({ state: 'operational' });
    // Runtime state unreadable: fail open to the heartbeat verdict rather
    // than inventing a restart demand.
    expect(deriveFeatureReadiness({ ...base, runtimeFeatures: null }))
      .toMatchObject({ state: 'operational' });
  });

  it('gates store readiness on the commerce runtime (round 34)', async () => {
    const { deriveFeatureReadiness, featureForPath } =
      await import('@/lib/dashboard/feature-status');
    const feature = featureForPath('/store')!;
    const base = {
      feature,
      config: { store_enabled: true },
      botOnline: true,
      staleSecs: 5,
    };
    // store_enabled true but paypal_enabled false: guild-init never
    // constructed EntitlementService or registered /store and /license — a
    // current heartbeat alone must not read as reachable.
    expect(deriveFeatureReadiness({ ...base, runtimeFeatures: ['temp_channels'] }))
      .toMatchObject({ state: 'blocked', heading: expect.stringContaining('awaiting bot restart') });
    expect(deriveFeatureReadiness({ ...base, runtimeFeatures: ['commerce'] }))
      .toMatchObject({ state: 'operational' });
  });

  it('gates music readiness on its runtime manager (round 29)', async () => {
    const { deriveFeatureReadiness, featureForPath } =
      await import('@/lib/dashboard/feature-status');
    const feature = featureForPath('/music')!;
    const base = {
      feature,
      config: { music_enabled: true },
      botOnline: true,
      staleSecs: 5,
    };
    // Enabled after boot (or init failed): no player/commands exist until
    // restart, so a current heartbeat alone must not read as reachable.
    expect(deriveFeatureReadiness({ ...base, runtimeFeatures: ['temp_channels'] }))
      .toMatchObject({ state: 'blocked', heading: expect.stringContaining('awaiting bot restart') });
    expect(deriveFeatureReadiness({ ...base, runtimeFeatures: ['music'] }))
      .toMatchObject({ state: 'operational' });
  });
});

