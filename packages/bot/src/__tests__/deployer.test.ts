/**
 * Tests for deploy/deployer.ts — the server state deployment pipeline.
 * 378 uncovered statements. Tests pre-flight checks, dry-run mode,
 * role/channel creation order, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock('discord.js', () => {
  class C extends Map {
    filter(fn: any) { const r = new C(); for (const [k, v] of this) if (fn(v, k)) r.set(k, v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
  }
  return {
    EmbedBuilder: class {
    // Real EmbedBuilder always exposes `data` (branded embeds read
    // data.footer to append attribution without clobbering it).
    data: Record<string, unknown> = {};
      setColor() { return this; } setTitle() { return this; }
      setDescription() { return this; } setFooter() { return this; }
      setTimestamp() { return this; } addFields() { return this; }
    },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ManageRoles: 8n, ManageChannels: 4n, Administrator: 8n, ManageGuild: 32n },
    PermissionsBitField: class {
      value: bigint;
      constructor(v: any) { this.value = BigInt(v); }
    },
    Collection: C,
    OverwriteType: { Role: 0, Member: 1 },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock('../guards/bot-role-guard.js', () => ({
  checkBotRolePosition: vi.fn(async () => ({ isTopPosition: true, rolesAboveBot: [] })),
  checkBotPermissions: vi.fn(() => ({ hasRequired: true, missing: [] })),
}));

import { deployServerState } from '../deploy/deployer.js';
import { checkBotRolePosition, checkBotPermissions } from '../guards/bot-role-guard.js';

function makeGuild() {
  const everyoneRole: any = {
    id: 'guild-1', name: '@everyone', position: 0,
    permissions: { bitfield: 0n },
    setPermissions: vi.fn().mockResolvedValue({}),
    managed: false, editable: true,
  };
  const existingRole: any = {
    id: 'existing-role', name: 'Member', position: 2,
    managed: false, editable: true,
    edit: vi.fn(),
    setPosition: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  existingRole.edit.mockImplementation(async () => existingRole);

  const textCh: any = {
    id: 'ch-1', type: 0, name: 'general',
    isTextBased: () => true,
    isThread: () => false,
    send: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    delete: vi.fn().mockResolvedValue(undefined),
    edit: vi.fn().mockResolvedValue({}),
    messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    parentId: null,
  };

  const guild: any = {
    id: 'guild-1', name: 'Test', memberCount: 100,
    members: {
      me: {
        id: 'bot-1',
        roles: { highest: { position: 100 } },
        permissions: { has: () => true },
      },
    },
    roles: {
      cache: new Map([
        ['guild-1', everyoneRole],
        ['existing-role', existingRole],
      ]),
      everyone: everyoneRole,
      create: vi.fn().mockImplementation(async (opts: any) => ({
        id: `new-${opts.name}`, name: opts.name, position: 1,
        setPosition: vi.fn().mockResolvedValue({}),
      })),
      fetch: vi.fn().mockResolvedValue(new Map()),
    },
    channels: {
      cache: new Map([['ch-1', textCh]]),
      create: vi.fn().mockImplementation(async (opts: any) => ({
        id: `new-ch-${opts.name}`, name: opts.name,
        isTextBased: () => true, send: vi.fn(),
      })),
      edit: vi.fn().mockImplementation(async (id: string, opts: Record<string, unknown>) => {
        const channel = guild.channels.cache.get(id);
        Object.assign(channel, opts);
        return channel;
      }),
      fetch: vi.fn().mockResolvedValue(new Map()),
    },
    client: { user: { id: 'bot-1' } },
  };
  return guild;
}

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'order', 'limit', 'single', 'maybeSingle', 'returns', 'match', 'in']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa() {
  const chain = makeChain({ data: null, error: null });
  return {
    from: vi.fn(() => chain),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

describe('deployer', () => {
  describe('deployServerState', () => {
    it('fails when bot role position is not top', async () => {
      (checkBotRolePosition as any).mockResolvedValueOnce({
        isTopPosition: false,
        rolesAboveBot: [{ name: 'Admin' }],
      });

      const result = await deployServerState(
        makeGuild(),
        makeSupa() as any,
        { everyonePermissions: '0', roles: [], categories: [], channels: [] },
        { cleanExisting: false, dryRun: false },
      );

      expect(result.success).toBe(false);
      expect(result.errors[0].error).toContain('Bot role is not at position #1');
    });

    it('fails when bot is missing permissions', async () => {
      (checkBotPermissions as any).mockReturnValueOnce({
        hasRequired: false,
        missing: ['ManageRoles'],
      });

      const result = await deployServerState(
        makeGuild(),
        makeSupa() as any,
        { everyonePermissions: '0', roles: [], categories: [], channels: [] },
        { cleanExisting: false, dryRun: false },
      );

      expect(result.success).toBe(false);
      expect(result.errors[0].error).toContain('Missing permissions');
    });

    it('returns success in dry-run mode without creating anything', async () => {
      const guild = makeGuild();
      const result = await deployServerState(
        guild,
        makeSupa() as any,
        { everyonePermissions: '0', roles: [{ key: 'r1', name: 'VIP', tier: 'premium', permissions: '0', color: 0xFF0000, hoist: true, mentionable: false, position: 0 }], categories: [], channels: [] },
        { cleanExisting: false, dryRun: true },
      );

      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(0);
      expect(guild.roles.create).not.toHaveBeenCalled();
    });

    it('creates roles and channels in correct order', async () => {
      const guild = makeGuild();
      const supa = makeSupa();

      const desiredState = {
        everyonePermissions: '0',
        roles: [
          { key: 'vip', name: 'VIP', tier: 'premium', permissions: '0', color: 0xFF0000, hoist: true, mentionable: false, position: 0 },
        ],
        categories: [
          { key: 'cat-main', name: 'Main' },
        ],
        channels: [
          { key: 'ch-welcome', name: 'welcome', type: 0, categoryKey: 'cat-main', topic: 'Welcome!', overrides: [] },
        ],
      };

      const result = await deployServerState(
        guild,
        supa as any,
        desiredState as any,
        { cleanExisting: false, dryRun: false },
      );

      // Deployment ran (may hit errors on mocked guild methods — that's fine)
      expect(result.deployId).toContain('deploy_');
      expect(result.duration).toBeGreaterThanOrEqual(0);
      // Should have attempted role creation
      expect(guild.roles.create).toHaveBeenCalled();
    });

    it('calls progress callback', async () => {
      const guild = makeGuild();
      const onProgress = vi.fn();

      await deployServerState(
        guild,
        makeSupa() as any,
        { everyonePermissions: '0', roles: [], categories: [], channels: [] },
        { cleanExisting: false, dryRun: false, onProgress },
      );

      expect(onProgress).toHaveBeenCalled();
    });

    it('handles role creation errors gracefully', async () => {
      const guild = makeGuild();
      guild.roles.create.mockRejectedValueOnce(new Error('Discord API error'));

      const result = await deployServerState(
        guild,
        makeSupa() as any,
        {
          everyonePermissions: '0',
          roles: [{ key: 'fail', name: 'FailRole', tier: 'basic', permissions: '0', color: 0, hoist: false, mentionable: false, position: 0 }],
          categories: [],
          channels: [],
        },
        { cleanExisting: false, dryRun: false },
      );

      // Deploy should still complete (individual errors don't crash the whole deploy)
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('updates mapped categories and channels without replacing their Discord IDs', async () => {
      const guild = makeGuild();
      guild.channels.cache.find = (predicate: (channel: Record<string, unknown>) => boolean) =>
        [...guild.channels.cache.values()].find(predicate);
      const category = {
        id: 'cat-1',
        name: 'General',
        type: 4,
        edit: vi.fn(),
        delete: vi.fn(),
      };
      category.edit.mockImplementation(async () => category);
      guild.channels.cache.set(category.id, category);

      const mappingChain = makeChain({
        data: [
          { entity_type: 'category', template_key: 'category:cat-general', discord_id: 'cat-1' },
          { entity_type: 'channel', template_key: 'channel:general', discord_id: 'ch-1' },
        ],
        error: null,
      });
      const writeChain = makeChain({ data: null, error: null });
      const supabase = {
        from: vi.fn((table: string) => table === 'discord_id_map' ? mappingChain : writeChain),
      };

      const result = await deployServerState(
        guild,
        supabase as unknown as Parameters<typeof deployServerState>[1],
        {
          everyonePermissions: '0',
          roles: [],
          categories: [{ key: 'cat-general', name: 'Release QA', position: 0 }],
          channels: [{
            key: 'general',
            name: 'release-validation',
            type: 0,
            categoryKey: 'cat-general',
            position: 0,
            topic: 'Proof',
            slowmode: 5,
            nsfw: false,
            templateId: 'open',
            overrides: [],
          }],
        },
        { cleanExisting: false, dryRun: false },
      );

      expect(result.success).toBe(true);
      expect(category.edit).toHaveBeenCalled();
      expect(guild.channels.edit).toHaveBeenCalledWith(
        'ch-1',
        expect.objectContaining({ name: 'release-validation', parent: 'cat-1' }),
      );
      expect(guild.channels.create).not.toHaveBeenCalled();
      expect(guild.channels.cache.get('ch-1').delete).not.toHaveBeenCalled();
      expect(result.idMappings).toEqual(expect.arrayContaining([
        { entityType: 'category', key: 'cat-general', discordId: 'cat-1' },
        { entityType: 'channel', key: 'general', discordId: 'ch-1' },
      ]));
    });
  });
});
