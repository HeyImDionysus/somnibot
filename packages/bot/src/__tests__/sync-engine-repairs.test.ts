/**
 * Sync Engine — HIERARCHY_DRIFT and EXTERNAL_CHANGE auto-repair coverage.
 *
 * These exercise the internal auto-repair path (runSyncCycle → repairDriftItem)
 * for the two drift types that previously returned a dead
 * { success: false, action: 'manual_required', reason: 'Repair not implemented' }.
 *
 * HIERARCHY_DRIFT  → reorder roles to their desired relative positions, honoring
 *                    Discord's rule that the bot can only move roles below its own
 *                    highest role. Genuinely-impossible cases (target at/above the
 *                    bot) surface a clear manual_required.
 * EXTERNAL_CHANGE  → re-apply desired state to a tracked entity that changed
 *                    outside the dashboard (role name/color/hoist/mentionable,
 *                    channel name/topic/slowmode/nsfw).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockComputeStateDiff = vi.fn((): any => ({ everyoneDrift: false, diffs: [] }));
const mockClassifyDrift = vi.fn((): any[] => []);
const mockTakeSnapshot = vi.fn(async () => ({
  everyonePermissions: '0',
  roles: [],
  categories: [],
  channels: [],
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  computeStateDiff: (...args: any[]) => (mockComputeStateDiff as Function)(...args),
  classifyDrift: (...args: any[]) => (mockClassifyDrift as Function)(...args),
}));

vi.mock('../sync/snapshot.js', () => ({
  takeSnapshot: (...args: any[]) => (mockTakeSnapshot as Function)(...args),
}));

import { runSyncCycle, type SyncConfig } from '../sync/sync-engine.js';

// ── Supabase stub ────────────────────────────────────────
// Table-aware, method-chaining stub. `guild_desired_state` returns the
// provided desired-state row for both the top-level select and the nested
// per-repair select (roles / channels columns).
function supaChain(data: any = null, error: any = null) {
  const c: any = {};
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gte', 'lt', 'lte', 'limit', 'order', 'in', 'filter', 'maybeSingle', 'single', 'match', 'then'];
  for (const m of methods) c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  // For list queries (awaited directly), return arrays as-is; wrap a single row.
  c.then = (resolve: any) =>
    resolve({ data: Array.isArray(data) ? data : data ? [data] : [], error });
  return c;
}

function makeSupabase(opts: {
  desired?: any;
  mappings?: any[];
  upsertSpy?: ReturnType<typeof vi.fn>;
} = {}) {
  const { desired = { roles: [], channels: [] }, mappings = [], upsertSpy } = opts;
  return {
    from: vi.fn((table: string) => {
      if (table === 'guild_desired_state') return supaChain(desired);
      if (table === 'discord_id_map') {
        const chain = supaChain(mappings);
        if (upsertSpy) chain.upsert = upsertSpy;
        return chain;
      }
      return supaChain();
    }),
  } as any;
}

// ── Guild stub ───────────────────────────────────────────
class MockCollection extends Map {
  filter(fn: (v: any, k: string) => boolean): MockCollection {
    const result = new MockCollection();
    for (const [k, v] of this) if (fn(v, k)) result.set(k, v);
    return result;
  }
  map(fn: any) { return [...this.values()].map(fn); }
  find(fn: (v: any) => boolean): any {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}

function makeGuild(opts: {
  roles?: Array<{ id: string; name: string; position: number; managed?: boolean; edit?: any }>;
  botHighestPosition?: number;
  setPositions?: ReturnType<typeof vi.fn>;
} = {}) {
  const { roles = [], botHighestPosition = 100, setPositions = vi.fn(async () => {}) } = opts;
  const cache = new MockCollection();
  const everyone = { id: 'g1', name: '@everyone', setPermissions: vi.fn(async () => {}) };
  cache.set('g1', everyone);
  for (const r of roles) {
    cache.set(r.id, {
      managed: false,
      edit: vi.fn(async () => {}),
      ...r,
    });
  }

  return {
    id: 'g1',
    roles: { cache, everyone, setPositions },
    channels: { cache: new MockCollection() },
    rulesChannelId: null,
    publicUpdatesChannelId: null,
    members: { me: { roles: { highest: { id: 'bot-role', position: botHighestPosition } } } },
    client: { user: { id: 'bot1' } },
  } as any;
}

function makeConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    enabled: true,
    intervalMinutes: 5,
    autoRepair: true,
    autoRepairEveryone: false,
    ...overrides,
  };
}

const bus = { emit: vi.fn() } as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockComputeStateDiff.mockReturnValue({ everyoneDrift: false, diffs: [] });
});

// =========================================================
// HIERARCHY_DRIFT
// =========================================================
describe('auto-repair: HIERARCHY_DRIFT', () => {
  it('reorders roles to desired relative positions via setPositions', async () => {
    // Desired order (by position field): member(0) < mod(1) < admin(2).
    // Actual Discord positions are scrambled.
    const desired = {
      roles: [
        { key: 'admin', name: 'Admin', position: 2 },
        { key: 'mod', name: 'Mod', position: 1 },
        { key: 'member', name: 'Member', position: 0 },
      ],
      channels: [],
    };
    const mappings = [
      { template_key: 'role:admin', discord_id: 'r-admin' },
      { template_key: 'role:mod', discord_id: 'r-mod' },
      { template_key: 'role:member', discord_id: 'r-member' },
    ];
    const setPositions = vi.fn(async (_updates: Array<{ role: string; position: number }>) => {});
    const guild = makeGuild({
      botHighestPosition: 50,
      setPositions,
      roles: [
        { id: 'r-admin', name: 'Admin', position: 3 },
        { id: 'r-mod', name: 'Mod', position: 10 }, // drifted above admin
        { id: 'r-member', name: 'Member', position: 5 },
      ],
    });

    mockClassifyDrift.mockReturnValueOnce([
      {
        type: 'HIERARCHY_DRIFT',
        severity: 'warning',
        entityType: 'role',
        entityName: 'Mod',
        entityDiscordId: 'r-mod',
        templateKey: 'mod',
        description: 'Role position drifted',
        suggestedAction: 'repair',
      },
    ]);

    const supabase = makeSupabase({ desired, mappings });
    const result = await runSyncCycle(guild, supabase, bus, makeConfig());

    expect(setPositions).toHaveBeenCalledTimes(1);
    const updates = setPositions.mock.calls[0][0];
    // All three mapped roles are ordered; positions must reflect desired order
    // (member lowest, admin highest) and every position must be below the bot (50).
    const byRole = new Map(updates.map((u) => [u.role, u.position]));
    expect(byRole.get('r-member')!).toBeLessThan(byRole.get('r-mod')!);
    expect(byRole.get('r-mod')!).toBeLessThan(byRole.get('r-admin')!);
    for (const u of updates) {
      expect(u.position).toBeGreaterThanOrEqual(1);
      expect(u.position).toBeLessThan(50);
    }
    expect(result.repaired).toBe(1);
  });

  it('is idempotent — no setPositions call when already in desired order', async () => {
    const desired = {
      roles: [
        { key: 'admin', name: 'Admin', position: 2 },
        { key: 'mod', name: 'Mod', position: 1 },
        { key: 'member', name: 'Member', position: 0 },
      ],
      channels: [],
    };
    const mappings = [
      { template_key: 'role:admin', discord_id: 'r-admin' },
      { template_key: 'role:mod', discord_id: 'r-mod' },
      { template_key: 'role:member', discord_id: 'r-member' },
    ];
    const setPositions = vi.fn(async () => {});
    // Actual positions already match desired relative ordering
    const guild = makeGuild({
      botHighestPosition: 50,
      setPositions,
      roles: [
        { id: 'r-admin', name: 'Admin', position: 12 },
        { id: 'r-mod', name: 'Mod', position: 11 },
        { id: 'r-member', name: 'Member', position: 10 },
      ],
    });

    mockClassifyDrift.mockReturnValueOnce([
      {
        type: 'HIERARCHY_DRIFT',
        severity: 'warning',
        entityType: 'role',
        entityName: 'Mod',
        entityDiscordId: 'r-mod',
        templateKey: 'mod',
        description: 'Role position drifted',
        suggestedAction: 'repair',
      },
    ]);

    const supabase = makeSupabase({ desired, mappings });
    const result = await runSyncCycle(guild, supabase, bus, makeConfig());

    expect(setPositions).not.toHaveBeenCalled();
    expect(result.repaired).toBe(1); // idempotent no-op still counts as repaired/consistent
  });

  it('surfaces manual_required when the target role is at or above the bot', async () => {
    const desired = {
      roles: [
        { key: 'admin', name: 'Admin', position: 2 },
        { key: 'member', name: 'Member', position: 0 },
      ],
      channels: [],
    };
    const mappings = [
      { template_key: 'role:admin', discord_id: 'r-admin' },
      { template_key: 'role:member', discord_id: 'r-member' },
    ];
    const setPositions = vi.fn(async () => {});
    // Bot highest is 10; the drifted target Admin sits at 15 (above bot) → impossible.
    const guild = makeGuild({
      botHighestPosition: 10,
      setPositions,
      roles: [
        { id: 'r-admin', name: 'Admin', position: 15 },
        { id: 'r-member', name: 'Member', position: 5 },
      ],
    });

    mockClassifyDrift.mockReturnValueOnce([
      {
        type: 'HIERARCHY_DRIFT',
        severity: 'warning',
        entityType: 'role',
        entityName: 'Admin',
        entityDiscordId: 'r-admin',
        templateKey: 'admin',
        description: 'Role position drifted',
        suggestedAction: 'repair',
      },
    ]);

    const supabase = makeSupabase({ desired, mappings });
    const result = await runSyncCycle(guild, supabase, bus, makeConfig());

    expect(setPositions).not.toHaveBeenCalled();
    expect(result.repaired).toBe(0);
  });
});

// =========================================================
// EXTERNAL_CHANGE
// =========================================================
describe('auto-repair: EXTERNAL_CHANGE', () => {
  it('re-applies desired state to a role changed outside the dashboard', async () => {
    const desired = {
      roles: [
        {
          key: 'mod', name: 'Moderator', permissions: '1024',
          color: 0x00ff00, hoist: true, mentionable: false,
        },
      ],
      channels: [],
    };
    const mappings = [{ template_key: 'role:mod', discord_id: 'r-mod' }];
    const editSpy = vi.fn(async (_opts: Record<string, unknown>) => {});
    const guild = makeGuild({
      botHighestPosition: 50,
      roles: [{ id: 'r-mod', name: 'Renamed', position: 5, edit: editSpy }],
    });

    mockClassifyDrift.mockReturnValueOnce([
      {
        type: 'EXTERNAL_CHANGE',
        severity: 'info',
        entityType: 'role',
        entityName: 'Renamed',
        entityDiscordId: 'r-mod',
        templateKey: 'mod',
        description: 'Role "Renamed" was modified outside the dashboard',
        suggestedAction: 'repair',
      },
    ]);

    const supabase = makeSupabase({ desired, mappings });
    const result = await runSyncCycle(guild, supabase, bus, makeConfig());

    expect(editSpy).toHaveBeenCalledTimes(1);
    const editArg = editSpy.mock.calls[0][0];
    expect(editArg).toMatchObject({
      name: 'Moderator',
      color: 0x00ff00,
      hoist: true,
      mentionable: false,
    });
    // EXTERNAL_CHANGE re-applies name/color/hoist/mentionable only.
    // Permissions are the domain of PERMISSION_DRIFT and are intentionally left alone.
    expect(editArg.permissions).toBeUndefined();
    expect(result.repaired).toBe(1);
  });

  it('re-applies desired state to a channel changed outside the dashboard', async () => {
    const desired = {
      roles: [],
      channels: [
        { key: 'general', name: 'general', topic: 'Welcome', slowmode: 5, nsfw: false },
      ],
    };
    const mappings = [{ template_key: 'channel:general', discord_id: 'c-general' }];
    const editSpy = vi.fn(async (_opts: Record<string, unknown>) => {});
    const guild = makeGuild({ botHighestPosition: 50 });
    guild.channels.cache.set('c-general', {
      id: 'c-general',
      name: 'renamed',
      topic: 'wrong topic',
      nsfw: true,
      rateLimitPerUser: 0,
      edit: editSpy,
    });

    mockClassifyDrift.mockReturnValueOnce([
      {
        type: 'EXTERNAL_CHANGE',
        severity: 'info',
        entityType: 'channel',
        entityName: 'renamed',
        entityDiscordId: 'c-general',
        templateKey: 'general',
        description: 'Channel "renamed" was modified outside the dashboard',
        suggestedAction: 'repair',
      },
    ]);

    const supabase = makeSupabase({ desired, mappings });
    const result = await runSyncCycle(guild, supabase, bus, makeConfig());

    expect(editSpy).toHaveBeenCalledTimes(1);
    const editArg = editSpy.mock.calls[0][0];
    expect(editArg).toMatchObject({ name: 'general', topic: 'Welcome', nsfw: false });
    expect(result.repaired).toBe(1);
  });

  it('surfaces manual_required when the changed role is not in desired state', async () => {
    const desired = { roles: [], channels: [] };
    const mappings = [{ template_key: 'role:ghost', discord_id: 'r-ghost' }];
    const editSpy = vi.fn(async (_opts: Record<string, unknown>) => {});
    const guild = makeGuild({
      botHighestPosition: 50,
      roles: [{ id: 'r-ghost', name: 'Ghost', position: 5, edit: editSpy }],
    });

    mockClassifyDrift.mockReturnValueOnce([
      {
        type: 'EXTERNAL_CHANGE',
        severity: 'info',
        entityType: 'role',
        entityName: 'Ghost',
        entityDiscordId: 'r-ghost',
        templateKey: 'ghost',
        description: 'Role "Ghost" was modified outside the dashboard',
        suggestedAction: 'repair',
      },
    ]);

    const supabase = makeSupabase({ desired, mappings });
    const result = await runSyncCycle(guild, supabase, bus, makeConfig());

    expect(editSpy).not.toHaveBeenCalled();
    expect(result.repaired).toBe(0);
  });

  it('surfaces manual_required when the changed role sits at or above the bot', async () => {
    const desired = {
      roles: [
        { key: 'admin', name: 'Admin', permissions: '8', color: 1, hoist: true, mentionable: false },
      ],
      channels: [],
    };
    const mappings = [{ template_key: 'role:admin', discord_id: 'r-admin' }];
    const editSpy = vi.fn(async (_opts: Record<string, unknown>) => {});
    const guild = makeGuild({
      botHighestPosition: 10,
      roles: [{ id: 'r-admin', name: 'Admin', position: 20, edit: editSpy }], // above bot
    });

    mockClassifyDrift.mockReturnValueOnce([
      {
        type: 'EXTERNAL_CHANGE',
        severity: 'info',
        entityType: 'role',
        entityName: 'Admin',
        entityDiscordId: 'r-admin',
        templateKey: 'admin',
        description: 'Role "Admin" was modified outside the dashboard',
        suggestedAction: 'repair',
      },
    ]);

    const supabase = makeSupabase({ desired, mappings });
    const result = await runSyncCycle(guild, supabase, bus, makeConfig());

    expect(editSpy).not.toHaveBeenCalled();
    expect(result.repaired).toBe(0);
  });
});
