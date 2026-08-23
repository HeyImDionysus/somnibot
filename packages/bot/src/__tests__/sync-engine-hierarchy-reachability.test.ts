/**
 * Sync Engine — HIERARCHY_DRIFT reachability (real classifier, not mocked).
 *
 * The sibling suite `sync-engine-repairs.test.ts` mocks classifyDrift to hand a
 * HIERARCHY_DRIFT item straight to the repair. That proves the repair works but
 * NOT that anything actually produces the drift type — which is exactly the gap
 * codex flagged ("hierarchy repair is not reachable for actual role moves").
 *
 * This suite instead drives the PRODUCTION classifier (real computeStateDiff +
 * classifyDrift from @somnibot/shared) end-to-end through runSyncCycle. Only
 * takeSnapshot is stubbed, to inject the actual Discord positions; the drift is
 * discovered by the real diff engine and must reach reorderRolesToDesired.
 *
 * It also covers the ID-map/desired-state key-shape variants codex called out:
 *   - desired rows keyed by template_key/templateKey instead of key,
 *   - ID-map entries stored unprefixed (deploy-listener shape).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real @somnibot/shared — only createLogger is replaced for quiet output.
vi.mock('@somnibot/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@somnibot/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

// Actual Discord state is injected per-test; keep it in sync with the guild cache.
let snapshotState: any = { everyonePermissions: '0', roles: [], channels: [] };
vi.mock('../sync/snapshot.js', () => ({
  takeSnapshot: vi.fn(async () => snapshotState),
}));

import { runSyncCycle, type SyncConfig } from '../sync/sync-engine.js';

// ── Supabase stub ────────────────────────────────────────
function supaChain(data: any = null, error: any = null) {
  const c: any = {};
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gte', 'lt', 'lte', 'limit', 'range', 'order', 'in', 'filter', 'maybeSingle', 'single', 'match', 'then'];
  for (const m of methods) c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = (resolve: any) =>
    resolve({ data: Array.isArray(data) ? data : data ? [data] : [], error });
  return c;
}

function makeSupabase(opts: { desired?: any; mappings?: any[] } = {}) {
  const { desired = { roles: [], channels: [] }, mappings = [] } = opts;
  return {
    from: vi.fn((table: string) => {
      if (table === 'guild_desired_state') return supaChain(desired);
      if (table === 'discord_id_map') return supaChain(mappings);
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
  roles: Array<{ id: string; name: string; position: number; managed?: boolean }>;
  botHighestPosition: number;
  setPositions: ReturnType<typeof vi.fn>;
}) {
  const { roles, botHighestPosition, setPositions } = opts;
  const cache = new MockCollection();
  const everyone = { id: 'g1', name: '@everyone', setPermissions: vi.fn(async () => {}) };
  cache.set('g1', everyone);
  for (const r of roles) {
    const role = {
      managed: false,
      editable: r.managed !== true,
      edit: vi.fn(async () => {}),
      ...r,
      setPosition: vi.fn(),
    };
    role.setPosition.mockImplementation(async (nextPosition: number) => {
      const previousPosition = role.position;
      for (const other of cache.values()) {
        if (other.id === role.id || typeof other.position !== 'number') continue;
        if (previousPosition < nextPosition
          && other.position > previousPosition
          && other.position <= nextPosition) {
          other.position -= 1;
        } else if (previousPosition > nextPosition
          && other.position >= nextPosition
          && other.position < previousPosition) {
          other.position += 1;
        }
      }
      role.position = nextPosition;
      return role;
    });
    cache.set(r.id, role);
  }
  return {
    id: 'g1',
    roles: { cache, everyone, setPositions, fetch: vi.fn(async () => cache) },
    channels: { cache: new MockCollection() },
    rulesChannelId: null,
    publicUpdatesChannelId: null,
    members: {
      me: {
        roles: {
          highest: { id: 'bot-role', position: botHighestPosition },
          cache: new Map([['bot-role', { id: 'bot-role' }]]),
        },
        permissions: { has: vi.fn(() => true) },
      },
    },
    client: { user: { id: 'bot1' } },
  } as any;
}

/** Build the injected actual snapshot from the same role positions as the guild. */
function snapshotFromRoles(roles: Array<{ id: string; name: string; position: number; managed?: boolean }>) {
  return {
    everyonePermissions: '0',
    roles: [
      { id: 'g1', name: '@everyone', permissions: '0', color: 0, hoist: false, mentionable: false, position: 0, managed: false },
      ...roles.map((r) => ({
        id: r.id, name: r.name, permissions: '0', color: 0,
        hoist: false, mentionable: false, position: r.position, managed: r.managed ?? false,
      })),
    ],
    channels: [],
  };
}

function makeConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return { enabled: true, intervalMinutes: 5, autoRepair: true, autoRepairEveryone: false, ...overrides };
}

const bus = { emit: vi.fn() } as any;

beforeEach(() => {
  vi.clearAllMocks();
  snapshotState = { everyonePermissions: '0', roles: [], channels: [] };
});

describe('HIERARCHY_DRIFT reachability via the real classifier', () => {
  it('reorders roles when the real diff engine detects position drift', async () => {
    // Desired: member(0) < mod(1) < admin(2). Actual: mod drifted above admin.
    const actualRoles = [
      { id: 'r-admin', name: 'Admin', position: 3 },
      { id: 'r-mod', name: 'Mod', position: 10 },
      { id: 'r-member', name: 'Member', position: 1 },
    ];
    snapshotState = snapshotFromRoles(actualRoles);

    const desired = {
      roles: [
        { key: 'admin', name: 'Admin', permissions: '0', color: 0, hoist: false, mentionable: false, position: 2 },
        { key: 'mod', name: 'Mod', permissions: '0', color: 0, hoist: false, mentionable: false, position: 1 },
        { key: 'member', name: 'Member', permissions: '0', color: 0, hoist: false, mentionable: false, position: 0 },
      ],
      channels: [],
    };
    const mappings = [
      { template_key: 'role:admin', discord_id: 'r-admin' },
      { template_key: 'role:mod', discord_id: 'r-mod' },
      { template_key: 'role:member', discord_id: 'r-member' },
    ];
    const setPositions = vi.fn(async (_updates: Array<{ role: string; position: number }>) => {});
    const guild = makeGuild({ botHighestPosition: 50, setPositions, roles: actualRoles });

    const result = await runSyncCycle(guild, makeSupabase({ desired, mappings }), bus, makeConfig());

    expect(setPositions).not.toHaveBeenCalled();
    expect(guild.roles.cache.get('r-member').setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('r-mod').setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('r-admin').setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('r-member').position)
      .toBeLessThan(guild.roles.cache.get('r-mod').position);
    expect(guild.roles.cache.get('r-mod').position)
      .toBeLessThan(guild.roles.cache.get('r-admin').position);
    expect(result.repaired).toBeGreaterThanOrEqual(1);
  });

  it('resolves desired rows keyed by template_key/templateKey and unprefixed ID-map keys', async () => {
    // desired-state rows use template_key/templateKey (deploy/accept path shape),
    // and the ID map stores keys UNPREFIXED (deploy-listener shape).
    const actualRoles = [
      { id: 'r-admin', name: 'Admin', position: 2 },
      { id: 'r-member', name: 'Member', position: 9 }, // member above admin → drift
    ];
    snapshotState = snapshotFromRoles(actualRoles);

    const desired = {
      roles: [
        { template_key: 'admin', name: 'Admin', permissions: '0', color: 0, hoist: false, mentionable: false, position: 1 },
        { templateKey: 'member', name: 'Member', permissions: '0', color: 0, hoist: false, mentionable: false, position: 0 },
      ],
      channels: [],
    };
    const mappings = [
      { template_key: 'admin', discord_id: 'r-admin' },   // unprefixed
      { template_key: 'member', discord_id: 'r-member' }, // unprefixed
    ];
    const setPositions = vi.fn(async (_updates: Array<{ role: string; position: number }>) => {});
    const guild = makeGuild({ botHighestPosition: 50, setPositions, roles: actualRoles });

    const result = await runSyncCycle(guild, makeSupabase({ desired, mappings }), bus, makeConfig());

    expect(setPositions).not.toHaveBeenCalled();
    expect(guild.roles.cache.get('r-member').setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('r-admin').setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('r-member').position)
      .toBeLessThan(guild.roles.cache.get('r-admin').position);
    expect(result.repaired).toBeGreaterThanOrEqual(1);
  });

  it('detects hierarchy drift when a channel shares a bare template_key with a role', async () => {
    // A role and a channel are both keyed bare "staff". The flat idMap can only
    // hold one "staff" entry; here the CHANNEL mapping is inserted last and wins.
    // Without entity-type disambiguation the role lookup resolves to the
    // channel's ID, the role drops out of the hierarchy comparison, and the real
    // inversion (member above staff) is never repaired. runSyncCycle must build
    // the entity-typed map from discord_id_map.entity_type and still reorder.
    const actualRoles = [
      { id: 'r-staff', name: 'Staff', position: 2 },
      { id: 'r-member', name: 'Member', position: 9 }, // member above staff → drift
    ];
    snapshotState = snapshotFromRoles(actualRoles);

    const desired = {
      roles: [
        { template_key: 'staff', name: 'Staff', permissions: '0', color: 0, hoist: false, mentionable: false, position: 1 },
        { template_key: 'member', name: 'Member', permissions: '0', color: 0, hoist: false, mentionable: false, position: 0 },
      ],
      channels: [],
    };
    // Order matters: the channel "staff" row comes AFTER the role "staff" row, so
    // in the flat Map<string,string> the channel id clobbers the role id.
    const mappings = [
      { template_key: 'staff', discord_id: 'r-staff', entity_type: 'role' },
      { template_key: 'member', discord_id: 'r-member', entity_type: 'role' },
      { template_key: 'staff', discord_id: 'c-staff', entity_type: 'channel' },
    ];
    const setPositions = vi.fn(async (_updates: Array<{ role: string; position: number }>) => {});
    const guild = makeGuild({ botHighestPosition: 50, setPositions, roles: actualRoles });

    const result = await runSyncCycle(guild, makeSupabase({ desired, mappings }), bus, makeConfig());

    expect(setPositions).not.toHaveBeenCalled();
    expect(guild.roles.cache.get('r-member').setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('r-staff').setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('r-member').position)
      .toBeLessThan(guild.roles.cache.get('r-staff').position);
    expect(result.repaired).toBeGreaterThanOrEqual(1);
  });

  it('does not reorder when the real diff engine sees roles already in order', async () => {
    const actualRoles = [
      { id: 'r-admin', name: 'Admin', position: 12 },
      { id: 'r-member', name: 'Member', position: 10 },
    ];
    snapshotState = snapshotFromRoles(actualRoles);

    const desired = {
      roles: [
        { key: 'admin', name: 'Admin', permissions: '0', color: 0, hoist: false, mentionable: false, position: 1 },
        { key: 'member', name: 'Member', permissions: '0', color: 0, hoist: false, mentionable: false, position: 0 },
      ],
      channels: [],
    };
    const mappings = [
      { template_key: 'role:admin', discord_id: 'r-admin' },
      { template_key: 'role:member', discord_id: 'r-member' },
    ];
    const setPositions = vi.fn(async (_updates: Array<{ role: string; position: number }>) => {});
    const guild = makeGuild({ botHighestPosition: 50, setPositions, roles: actualRoles });

    await runSyncCycle(guild, makeSupabase({ desired, mappings }), bus, makeConfig());

    expect(setPositions).not.toHaveBeenCalled();
  });
});
