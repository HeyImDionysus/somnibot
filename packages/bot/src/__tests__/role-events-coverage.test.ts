/**
 * role-events — coverage tests
 *
 * Tests handleRoleCreate, handleRoleUpdate, handleRoleDelete with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/audit.js', () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

const mockQueueDriftItem = vi.fn();
vi.mock('../sync/drift-debouncer.js', () => ({
  queueDriftItem: (...args: unknown[]) => mockQueueDriftItem(...args),
}));

import { handleRoleCreate, handleRoleUpdate, handleRoleDelete } from '../sync/role-events.js';

// ── Helpers ───────────────────────────────────────────────

function chainBuilder(resolveValue: Record<string, unknown> = { data: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'update', 'upsert', 'insert', 'delete', 'order', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  const single = { data: resolveValue.data ?? null };
  chain.single = vi.fn().mockResolvedValue(single);
  chain.maybeSingle = vi.fn().mockResolvedValue(single);
  // Awaited (non-single) reads — e.g. `.limit(...)` list queries — resolve the
  // `list` array when provided, otherwise fall back to the single `data`.
  const listValue = { data: (resolveValue.list as unknown) ?? resolveValue.data ?? null };
  chain.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
    Promise.resolve(listValue).then(res, rej);
  return chain;
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const valkeyStore = new Map<string, string>();
  return {
    supabase: {
      from: vi.fn().mockReturnValue(chainBuilder()),
    },
    valkey: {
      get: vi.fn().mockImplementation((k: string) => Promise.resolve(valkeyStore.get(k) ?? null)),
      set: vi.fn().mockImplementation((k: string, v: string) => { valkeyStore.set(k, v); return Promise.resolve('OK'); }),
    },
    eventBus: { emit: vi.fn() },
    ...overrides,
  };
}

/**
 * Build a guild stub whose `roles.cache` returns the given roles by id. Used to
 * drive `trackedRolesOutOfDesiredOrder`, which reads live Discord positions.
 */
function makeGuild(
  id: string,
  cacheRoles: Array<{ id: string; position: number; managed?: boolean }> = [],
) {
  const cache = new Map(
    cacheRoles.map((r) => [r.id, { id: r.id, position: r.position, managed: r.managed ?? false }]),
  );
  return { id, roles: { cache } };
}

function makeRole(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    name: 'TestRole',
    managed: false,
    guild: makeGuild('g1'),
    permissions: { bitfield: 8n },
    color: 0xFF0000,
    hoist: true,
    mentionable: false,
    position: 5,
    tags: {},
    setPermissions: vi.fn().mockResolvedValue(undefined),
    edit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('handleRoleCreate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips managed roles', async () => {
    const client = makeClient();
    const role = makeRole({ managed: true });
    await handleRoleCreate(client as any, role as any);
    expect(mockQueueDriftItem).not.toHaveBeenCalled();
  });

  it('skips roles that exist in id map', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(
      chainBuilder({ data: { template_key: 'admin' } }),
    );
    const role = makeRole();
    await handleRoleCreate(client as any, role as any);
    expect(mockQueueDriftItem).not.toHaveBeenCalled();
  });

  it('queues drift item for new external role', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null }));
    const role = makeRole();
    await handleRoleCreate(client as any, role as any);
    expect(mockQueueDriftItem).toHaveBeenCalledWith(
      expect.anything(), 'g1', expect.objectContaining({ type: 'EXTRA_RESOURCE' }),
    );
  });
});

describe('handleRoleUpdate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('handles @everyone permissions change with auto-repair', async () => {
    const client = makeClient();
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: true, sync_auto_repair_everyone: true } });
      }
      return chainBuilder({ data: null });
    });

    const oldRole = makeRole({ id: 'g1', name: '@everyone', permissions: { bitfield: 0n } });
    const newRole = makeRole({
      id: 'g1', name: '@everyone',
      permissions: { bitfield: 8n },
      guild: { id: 'g1' },
    });

    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    expect(newRole.setPermissions).toHaveBeenCalledWith(0n, expect.any(String));
    expect(mockQueueDriftItem).toHaveBeenCalledWith(
      expect.anything(), 'g1', expect.objectContaining({ type: 'EVERYONE_DRIFT', severity: 'critical' }), true,
    );
  });

  it('handles @everyone with zero perms — no drift', async () => {
    const client = makeClient();
    const oldRole = makeRole({ id: 'g1', permissions: { bitfield: 0n } });
    const newRole = makeRole({ id: 'g1', permissions: { bitfield: 0n }, guild: { id: 'g1' } });
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    expect(mockQueueDriftItem).not.toHaveBeenCalled();
  });

  it('skips untracked roles', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null }));
    const oldRole = makeRole();
    const newRole = makeRole();
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    expect(mockQueueDriftItem).not.toHaveBeenCalled();
  });

  it('detects name change', async () => {
    const client = makeClient();
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'discord_id_map') {
        return chainBuilder({ data: { template_key: 'admin' } });
      }
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: false, sync_auto_repair_everyone: false } });
      }
      return chainBuilder({ data: null });
    });

    const oldRole = makeRole({ name: 'OldName' });
    const newRole = makeRole({ name: 'NewName' });
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    expect(mockQueueDriftItem).toHaveBeenCalledWith(
      expect.anything(), 'g1', expect.objectContaining({ type: 'EXTERNAL_CHANGE' }),
    );
  });

  it('detects permission change as warning severity', async () => {
    const client = makeClient();
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'discord_id_map') {
        return chainBuilder({ data: { template_key: 'mod' } });
      }
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: false } });
      }
      return chainBuilder({ data: null });
    });

    const oldRole = makeRole({ permissions: { bitfield: 0n } });
    const newRole = makeRole({ permissions: { bitfield: 8n } });
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    expect(mockQueueDriftItem).toHaveBeenCalledWith(
      expect.anything(), 'g1', expect.objectContaining({ type: 'PERMISSION_DRIFT', severity: 'warning' }),
    );
  });

  it('detects multiple changes', async () => {
    const client = makeClient();
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'discord_id_map') {
        return chainBuilder({ data: { template_key: 'admin' } });
      }
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: false } });
      }
      return chainBuilder({ data: null });
    });

    const oldRole = makeRole({ color: 0xFF0000, hoist: true, mentionable: false, position: 5 });
    const newRole = makeRole({ color: 0x00FF00, hoist: false, mentionable: true, position: 10 });
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    expect(mockQueueDriftItem).toHaveBeenCalled();
  });

  it('classifies a position-only move as HIERARCHY_DRIFT when tracked roles are out of desired order', async () => {
    const client = makeClient();
    // Desired: member(0) below admin(1). Live Discord positions invert that —
    // member sits ABOVE admin — so this is a genuine inversion.
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'discord_id_map') {
        // handleRoleUpdate's own mapping lookup returns admin; the drift helper's
        // list query returns both role mappings (chainBuilder resolves the same
        // value for maybeSingle and awaited list reads).
        return chainBuilder({
          data: { template_key: 'admin' },
          list: [
            { template_key: 'admin', discord_id: 'r-admin' },
            { template_key: 'member', discord_id: 'r-member' },
          ],
        });
      }
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: true } });
      }
      if (table === 'guild_desired_state') {
        return chainBuilder({
          data: {
            roles: [
              { template_key: 'admin', position: 1 },
              { template_key: 'member', position: 0 },
            ],
          },
        });
      }
      return chainBuilder({ data: null });
    });

    const guild = makeGuild('g1', [
      { id: 'r-admin', position: 3 }, // admin BELOW member → inversion
      { id: 'r-member', position: 9 },
    ]);
    // Only position changed — everything else identical.
    const oldRole = makeRole({ id: 'r-admin', guild, position: 5 });
    const newRole = makeRole({ id: 'r-admin', guild, position: 12 });
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);

    expect(mockQueueDriftItem).toHaveBeenCalledWith(
      expect.anything(),
      'g1',
      expect.objectContaining({
        type: 'HIERARCHY_DRIFT',
        severity: 'warning',
        entityType: 'role',
        templateKey: 'admin',
        suggestedAction: 'repair',
      }),
    );
    // A pure position move must NOT trigger the per-role attribute re-apply —
    // hierarchy is reconciled by the periodic reorder repair over the full set.
    expect(newRole.edit).not.toHaveBeenCalled();
  });

  it('does NOT flag a numeric-only position move that preserves desired order', async () => {
    const client = makeClient();
    // Desired: member(0) below admin(1). Live Discord positions still honor that
    // order (admin above member) — the numeric shift came from an untracked role
    // moving elsewhere. The periodic diff would not report this, so neither
    // should the event handler.
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'discord_id_map') {
        return chainBuilder({
          data: { template_key: 'admin' },
          list: [
            { template_key: 'admin', discord_id: 'r-admin' },
            { template_key: 'member', discord_id: 'r-member' },
          ],
        });
      }
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: true } });
      }
      if (table === 'guild_desired_state') {
        return chainBuilder({
          data: {
            roles: [
              { template_key: 'admin', position: 1 },
              { template_key: 'member', position: 0 },
            ],
          },
        });
      }
      return chainBuilder({ data: null });
    });

    const guild = makeGuild('g1', [
      { id: 'r-admin', position: 9 }, // admin still ABOVE member → order preserved
      { id: 'r-member', position: 4 },
    ]);
    const oldRole = makeRole({ id: 'r-admin', guild, position: 5 });
    const newRole = makeRole({ id: 'r-admin', guild, position: 9 });
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);

    // No drift of any kind — the benign numeric move is dropped.
    expect(mockQueueDriftItem).not.toHaveBeenCalled();
  });

  it('treats position+attribute changes as EXTERNAL_CHANGE (not hierarchy)', async () => {
    const client = makeClient();
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'discord_id_map') {
        return chainBuilder({ data: { template_key: 'admin' } });
      }
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: false } });
      }
      return chainBuilder({ data: null });
    });

    // Position AND name changed → not position-only.
    const oldRole = makeRole({ name: 'Admin', position: 5 });
    const newRole = makeRole({ name: 'Renamed', position: 12 });
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);

    expect(mockQueueDriftItem).toHaveBeenCalledWith(
      expect.anything(),
      'g1',
      expect.objectContaining({ type: 'EXTERNAL_CHANGE' }),
    );
  });

  it('position + permission change stays PERMISSION_DRIFT', async () => {
    const client = makeClient();
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'discord_id_map') {
        return chainBuilder({ data: { template_key: 'mod' } });
      }
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: false } });
      }
      return chainBuilder({ data: null });
    });

    const oldRole = makeRole({ permissions: { bitfield: 0n }, position: 5 });
    const newRole = makeRole({ permissions: { bitfield: 8n }, position: 12 });
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);

    expect(mockQueueDriftItem).toHaveBeenCalledWith(
      expect.anything(),
      'g1',
      expect.objectContaining({ type: 'PERMISSION_DRIFT', severity: 'warning' }),
    );
  });

  it('skips when no meaningful changes', async () => {
    const client = makeClient();
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'discord_id_map') {
        return chainBuilder({ data: { template_key: 'admin' } });
      }
      return chainBuilder({ data: null });
    });

    // Same everything
    const oldRole = makeRole();
    const newRole = makeRole();
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    expect(mockQueueDriftItem).not.toHaveBeenCalled();
  });

  it('auto-repairs tracked role when configured', async () => {
    const client = makeClient();
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'discord_id_map') {
        return chainBuilder({ data: { template_key: 'admin' } });
      }
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: true } });
      }
      if (table === 'guild_desired_state') {
        return chainBuilder({
          data: {
            roles: [{ template_key: 'admin', name: 'Admin', permissions: '8', color: 0xFF0000, hoist: true, mentionable: false }],
          },
        });
      }
      return chainBuilder({ data: null });
    });

    const oldRole = makeRole({ name: 'Admin' });
    const newRole = makeRole({ name: 'Hacked' });
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    expect(newRole.edit).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('auto-repair') }));
  });

  it('handles auto-repair failure gracefully', async () => {
    const client = makeClient();
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'discord_id_map') {
        return chainBuilder({ data: { template_key: 'admin' } });
      }
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: true } });
      }
      if (table === 'guild_desired_state') {
        return chainBuilder({ data: { roles: [{ template_key: 'admin', name: 'Admin' }] } });
      }
      return chainBuilder({ data: null });
    });

    const oldRole = makeRole({ name: 'Admin' });
    const newRole = makeRole({ name: 'Hacked' });
    newRole.edit.mockRejectedValueOnce(new Error('Missing perms'));
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    // Should not throw
  });

  it('handles @everyone auto-repair failure', async () => {
    const client = makeClient();
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: true, sync_auto_repair_everyone: true } });
      }
      return chainBuilder({ data: null });
    });

    const newRole = makeRole({
      id: 'g1', permissions: { bitfield: 8n }, guild: { id: 'g1' },
    });
    newRole.setPermissions.mockRejectedValueOnce(new Error('no perms'));
    const oldRole = makeRole({ id: 'g1', permissions: { bitfield: 0n } });

    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    // Should not throw, and drift item should still be queued
    expect(mockQueueDriftItem).toHaveBeenCalled();
  });

  it('does not reset @everyone when global auto-repair is off', async () => {
    const client = makeClient();
    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'guild_config') {
        return chainBuilder({ data: { sync_auto_repair: false, sync_auto_repair_everyone: true } });
      }
      return chainBuilder({ data: null });
    });

    const oldRole = makeRole({ id: 'g1', permissions: { bitfield: 0n } });
    const newRole = makeRole({ id: 'g1', permissions: { bitfield: 8n }, guild: { id: 'g1' } });
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    expect(newRole.setPermissions).not.toHaveBeenCalled();
    expect(mockQueueDriftItem).toHaveBeenCalled();
  });

  it('uses cached sync config from Valkey', async () => {
    const client = makeClient();
    // Pre-populate valkey cache
    await client.valkey.set('sync_config:g1', JSON.stringify({ autoRepair: true, autoRepairEveryone: false }));

    client.supabase.from.mockImplementation((table: string) => {
      if (table === 'discord_id_map') {
        return chainBuilder({ data: { template_key: 'admin' } });
      }
      if (table === 'guild_desired_state') {
        return chainBuilder({ data: { roles: [{ template_key: 'admin', name: 'Admin' }] } });
      }
      return chainBuilder({ data: null });
    });

    const oldRole = makeRole({ name: 'Admin' });
    const newRole = makeRole({ name: 'Hacked' });
    await handleRoleUpdate(client as any, oldRole as any, newRole as any);
    // Should use cached config without querying guild_config
  });
});

describe('handleRoleDelete', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips managed roles', async () => {
    const client = makeClient();
    const role = makeRole({ managed: true });
    await handleRoleDelete(client as any, role as any);
    expect(mockQueueDriftItem).not.toHaveBeenCalled();
  });

  it('skips untracked roles', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null }));
    const role = makeRole();
    await handleRoleDelete(client as any, role as any);
    expect(mockQueueDriftItem).not.toHaveBeenCalled();
  });

  it('queues drift item and writes audit for tracked role deletion', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(
      chainBuilder({ data: { template_key: 'admin' } }),
    );
    const role = makeRole();
    await handleRoleDelete(client as any, role as any);
    expect(mockQueueDriftItem).toHaveBeenCalledWith(
      expect.anything(), 'g1', expect.objectContaining({ type: 'MISSING_RESOURCE' }),
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'drift.role_deleted' }),
    );
  });
});
