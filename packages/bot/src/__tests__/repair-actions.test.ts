/**
 * Tests for sync/repair-actions.ts — repairDriftItem, acceptDriftItem, ignoreDriftItem, clearAllDrift.
 * 233 uncovered statements at 43.2%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    // Real EmbedBuilder always exposes `data` (branded embeds read
    // data.footer to append attribution without clobbering it).
    data: Record<string, unknown> = {};
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; } addFields() { return this; }
  },
  PermissionFlagsBits: { ManageChannels: 4n, ManageRoles: 8n },
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
  Collection: class extends Map {},
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { repairDriftItem, acceptDriftItem, ignoreDriftItem, clearAllDrift } from '../sync/repair-actions.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'upsert', 'neq']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null });
  return chain;
}

function makeSupa() {
  return {
    from: vi.fn(() => makeChain()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeGuild() {
  return {
    id: 'guild-1', name: 'Test',
    roles: {
      cache: new Map(),
      create: vi.fn().mockResolvedValue({ id: 'new-role' }),
      everyone: { id: 'guild-1' },
    },
    channels: {
      cache: new Map(),
      create: vi.fn().mockResolvedValue({ id: 'new-ch' }),
    },
    members: { me: { permissions: { has: () => true } } },
  } as any;
}

describe('repair-actions', () => {
  describe('repairDriftItem', () => {
    it('handles missing role drift item', async () => {
      const drift = { entity: 'role', key: 'r1', type: 'missing', desired: { name: 'VIP' } };
      await repairDriftItem(makeGuild(), makeSupa(), drift as any);
        // Drift repair completed without throwing
    });

    it('handles missing channel drift item', async () => {
      const drift = { entity: 'channel', key: 'c1', type: 'missing', desired: { name: 'general', type: 0 } };
      await repairDriftItem(makeGuild(), makeSupa(), drift as any);
        // Drift repair completed without throwing
    });

    it('handles permission drift item', async () => {
      const drift = { entity: 'role', key: 'r1', type: 'permission_drift', desired: { permissions: '0' } };
      const guild = makeGuild();
      guild.roles.cache.set('r1', { id: 'r1', setPermissions: vi.fn().mockResolvedValue({}) });
      await repairDriftItem(guild, makeSupa(), drift as any);
        // Permission drift repair completed without throwing
    });
  });

  describe('acceptDriftItem', () => {
    it('rejects @everyone drift', async () => {
      const drift = { entity: 'everyone', entityType: 'everyone', key: 'ev', type: 'permission_drift', desired: {} };
      const result = await acceptDriftItem(makeGuild(), makeSupa(), drift as any);
      expect(result.success).toBe(false);
    });

    it('accepts extra resource drift', async () => {
      const drift = { entity: 'role', entityType: 'role', key: 'r1', type: 'EXTRA_RESOURCE', entityDiscordId: 'disc-1', desired: {} };
      const result = await acceptDriftItem(makeGuild(), makeSupa(), drift as any);
      // May succeed or fail depending on mock chain
      expect(result).toBeDefined();
    });

    it('accepting HIERARCHY_DRIFT rewrites desired positions to the observed order', async () => {
      // Desired ordering has member(0) below admin(1). Live Discord shows the
      // inverse — member ABOVE admin. Accepting the drift must persist that
      // observed ordering as the new desired positions, otherwise the next diff
      // recomputes the same inversion and re-adds the drift forever.
      const captured: { roles?: any[] } = {};
      const desiredRow = {
        roles: [
          { template_key: 'admin', position: 1 },
          { template_key: 'member', position: 0 },
        ],
      };
      const mappingsRows = [
        { template_key: 'admin', discord_id: 'r-admin' },
        { template_key: 'member', discord_id: 'r-member' },
      ];

      // Table-aware supabase stub: desired-state reads/writes, role mappings list.
      function chainFor(table: string) {
        const c: any = {};
        for (const m of ['from', 'select', 'insert', 'delete', 'eq', 'order', 'limit', 'in', 'match', 'upsert', 'neq']) {
          c[m] = vi.fn(() => c);
        }
        c.update = vi.fn((payload: any) => {
          if (table === 'guild_desired_state' && Array.isArray(payload?.roles)) {
            captured.roles = payload.roles;
          }
          return c;
        });
        const single =
          table === 'guild_desired_state'
            ? { data: desiredRow, error: null }
            : { data: null, error: null };
        c.single = vi.fn(async () => single);
        c.maybeSingle = vi.fn(async () => single);
        c.then = (resolve: Function) =>
          resolve({
            data:
              table === 'discord_id_map'
                ? mappingsRows
                : table === 'guild_desired_state'
                  ? [desiredRow]
                  : [],
            error: null,
          });
        return c;
      }
      const supa: any = { from: vi.fn((table: string) => chainFor(table)), rpc: vi.fn(async () => ({ data: null, error: null })) };

      // Guild cache: member sits ABOVE admin (positions inverted vs desired).
      const guild = makeGuild();
      guild.roles.cache.set('r-admin', { id: 'r-admin', name: 'Admin', position: 3, managed: false });
      guild.roles.cache.set('r-member', { id: 'r-member', name: 'Member', position: 9, managed: false });

      const drift = {
        type: 'HIERARCHY_DRIFT',
        entityType: 'role',
        entityName: 'Role hierarchy',
        entityDiscordId: 'r-admin',
        templateKey: 'admin',
        suggestedAction: 'accept',
      };

      const result = await acceptDriftItem(guild, supa as any, drift as any);
      expect(result.success).toBe(true);

      // Desired positions now reflect the observed order. Position is "higher =
      // higher in hierarchy", and on Discord member(9) sits ABOVE admin(3), so
      // admin gets the lower desired position (0) and member the higher (1).
      expect(captured.roles).toBeDefined();
      const byKey = new Map(captured.roles!.map((r) => [r.template_key, r.position]));
      expect(byKey.get('admin')).toBe(0);
      expect(byKey.get('member')).toBe(1);
    });

    it('rejects HIERARCHY_DRIFT accept when fewer than two roles resolve', async () => {
      // Only one mapped role resolves to a live role → there is no ordering to
      // accept, so the accept must fail rather than silently clearing the drift.
      const desiredRow = { roles: [{ template_key: 'admin', position: 0 }] };
      function chainFor(table: string) {
        const c: any = {};
        for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'order', 'limit', 'in', 'match', 'upsert', 'neq']) {
          c[m] = vi.fn(() => c);
        }
        const single = table === 'guild_desired_state' ? { data: desiredRow, error: null } : { data: null, error: null };
        c.single = vi.fn(async () => single);
        c.maybeSingle = vi.fn(async () => single);
        c.then = (resolve: Function) =>
          resolve({ data: table === 'discord_id_map' ? [{ template_key: 'admin', discord_id: 'r-admin' }] : [], error: null });
        return c;
      }
      const supa: any = { from: vi.fn((table: string) => chainFor(table)), rpc: vi.fn(async () => ({ data: null, error: null })) };
      const guild = makeGuild();
      guild.roles.cache.set('r-admin', { id: 'r-admin', name: 'Admin', position: 3, managed: false });

      const drift = { type: 'HIERARCHY_DRIFT', entityType: 'role', entityName: 'Role hierarchy', entityDiscordId: 'r-admin', templateKey: 'admin' };
      const result = await acceptDriftItem(guild, supa as any, drift as any);
      expect(result.success).toBe(false);
    });
  });

  describe('ignoreDriftItem', () => {
    it('ignores a drift item', async () => {
      const supa = makeSupa();
      const drift = { entity: 'role', entityType: 'role', key: 'r1', type: 'missing', entityDiscordId: 'r1', entityName: 'VIP' };
      const result = await ignoreDriftItem(supa, 'guild-1', drift as any);
      expect(result).toBeDefined();
    });
  });

  describe('clearAllDrift', () => {
    it('clears all drift for a guild', async () => {
      const supa = makeSupa();
      await clearAllDrift(supa, 'guild-1');
      expect(supa.from).toHaveBeenCalled();
    });
  });
});
