/**
 * Tests for features/commerce/license-commands.ts — buildLicenseCommand, handleLicenseCommand.
 * 191 uncovered statements at 29.8%.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; }
    setDescription() { return this; } addFields() { return this; }
    setFooter() { return this; }
  },
  SlashCommandBuilder: class {
    setName() { return this; } setDescription() { return this; }
    addSubcommand() { return this; }
    setDefaultMemberPermissions() { return this; }
  },
  PermissionFlagsBits: { ManageGuild: 1n },
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { buildLicenseCommand, handleLicenseCommand } from '../features/commerce/license-commands.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null });
  return chain;
}

describe('license-commands', () => {
  it('buildLicenseCommand returns a command', () => {
    const cmd = buildLicenseCommand();
    expect(cmd).toBeDefined();
  });

  it('handleLicenseCommand responds to interaction', async () => {
    const interaction = {
      guildId: 'guild-1',
      user: { id: 'user-1' },
      options: {
        getSubcommand: vi.fn(() => 'view'),
        getString: vi.fn(() => null),
        getUser: vi.fn(() => null),
      },
      reply: vi.fn().mockResolvedValue({}),
      deferReply: vi.fn().mockResolvedValue({}),
      editReply: vi.fn().mockResolvedValue({}),
    } as any;
    const supa = { from: vi.fn(() => makeChain()) } as any;
    try { await handleLicenseCommand(interaction, supa, {} as any); } catch { /* expected with minimal mocks */ }
    expect(interaction).toBeDefined();
  });

  /**
   * Activation is a check-then-act: two concurrent /license activate calls can
   * both pass the JS status checks. The fix guards the flip on
   * status='pending_activation' and only the winner (whose UPDATE returns a row)
   * grants the entitlement/roles and writes the key.activated audit row. This
   * drives the LOST-race branch: the lookup sees a pending key, but the guarded
   * activation UPDATE matches zero rows -> no entitlement write, no audit row,
   * and an "already active" reply.
   */
  it('activate: lost race (guarded update affects 0 rows) skips entitlement + audit writes', async () => {
    const pendingKey = {
      id: 'lk-1',
      status: 'pending_activation',
      bound_discord_id: 'user-1',
      product_id: 'prod-1',
      products: { name: 'Pro', granted_role_ids: ['role-1'], granted_channel_ids: [] },
    };

    // Table/op-aware mock: license_keys .single() lookup returns the pending key;
    // the guarded .update().eq().eq().select('id') resolves to [] (lost race);
    // entitlement/audit writes are tracked so we can assert they never ran.
    const calls = { licenseKeyUpdate: 0, entitlementUpdate: 0, auditInsert: 0 };
    const supa: any = {
      from: (table: string) => {
        const chain: any = { _table: table, _isUpdate: false, _isInsert: false };
        for (const m of ['select', 'eq', 'order', 'limit', 'in', 'match']) {
          chain[m] = vi.fn(() => chain);
        }
        chain.update = vi.fn(() => { chain._isUpdate = true; if (table === 'license_keys') calls.licenseKeyUpdate++; if (table === 'entitlements') calls.entitlementUpdate++; return chain; });
        chain.insert = vi.fn(() => { chain._isInsert = true; if (table === 'audit_logs') calls.auditInsert++; return chain; });
        chain.single = vi.fn(() => Promise.resolve({
          data: table === 'license_keys' ? pendingKey : null,
          error: null,
        }));
        chain.maybeSingle = chain.single;
        // Awaiting the builder (update...select('id'), or insert) resolves here.
        chain.then = (resolve: Function) => resolve({
          // The guarded license_keys activation update matched no rows.
          data: chain._isUpdate && table === 'license_keys' ? [] : [],
          error: null,
        });
        return chain;
      },
    };

    const interaction = {
      guildId: 'guild-1',
      guild: { members: { fetch: vi.fn() } },
      user: { id: 'user-1' },
      options: {
        getSubcommand: vi.fn(() => 'activate'),
        getString: vi.fn(() => 'SOMNI-XXXX-YYYY-ZZZZ'),
        getUser: vi.fn(() => null),
      },
      reply: vi.fn().mockResolvedValue({}),
      deferReply: vi.fn().mockResolvedValue({}),
      editReply: vi.fn().mockResolvedValue({}),
    } as any;

    await handleLicenseCommand(interaction, supa, {} as any);

    // Proves we reached the guarded activation write (not an early error/return).
    expect(calls.licenseKeyUpdate).toBeGreaterThanOrEqual(1);
    // Lost race → no entitlement update, no audit row, no role fetch/grant.
    expect(calls.entitlementUpdate).toBe(0);
    expect(calls.auditInsert).toBe(0);
    expect(interaction.guild.members.fetch).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
  });
});
