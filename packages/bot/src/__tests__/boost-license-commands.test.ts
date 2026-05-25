// @ts-nocheck
/**
 * Tests for features/commerce/license-commands.ts — buildLicenseCommand, handleLicenseCommand.
 * 191 uncovered statements at 29.8%.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
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

  it('handleLicenseCommand runs without error', async () => {
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
    await handleLicenseCommand(interaction, supa);
  });
});
