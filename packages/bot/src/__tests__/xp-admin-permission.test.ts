/**
 * /xp admin handler — in-handler Manage-Guild re-check (defense-in-depth).
 *
 * setDefaultMemberPermissions(ManageGuild) is the primary gate, but a guild
 * owner can override per-command permissions in Server Settings → Integrations.
 * The handler must re-check Manage-Guild so that override cannot silently confer
 * XP-mutation power, must reply with an ephemeral denial, and must write a denied
 * audit row — without mutating member_levels.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  calculateLevel: (xp: number) => Math.floor(Math.sqrt(Math.max(0, xp) / 100)),
}));

vi.mock('discord.js', () => ({
  SlashCommandBuilder: class {
    setName() { return this; }
    setDescription() { return this; }
    setDefaultMemberPermissions() { return this; }
    addSubcommand() { return this; }
  },
  ChatInputCommandInteraction: class {},
  PermissionFlagsBits: { ManageGuild: 32n },
}));

import { handleXpAdminCommand } from '../features/levels/admin-commands.js';

function makeInteraction(hasPerm: boolean, sub = 'add') {
  return {
    guildId: 'g1',
    user: { id: 'actor1' },
    memberPermissions: { has: vi.fn().mockReturnValue(hasPerm) },
    options: {
      getSubcommand: () => sub,
      getUser: () => ({ id: 'target1' }),
      getInteger: () => 100,
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

function makeClient() {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const tables: string[] = [];
  const rpc = vi.fn().mockResolvedValue({ data: { new_xp: 100, new_level: 1 }, error: null });
  const from = vi.fn().mockImplementation((table: string) => {
    tables.push(table);
    return { insert, upsert };
  });
  return { supabase: { from, rpc } as any, _insert: insert, _rpc: rpc, _tables: tables };
}

describe('handleXpAdminCommand — Manage-Guild re-check', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies a caller without Manage-Guild: no member_levels mutation, ephemeral denial, denied audit row', async () => {
    const interaction = makeInteraction(false, 'add');
    const client = makeClient();

    await handleXpAdminCommand(interaction as any, client as any);

    // (a) member_levels is never touched, no XP RPC fired
    expect(client._tables).not.toContain('member_levels');
    expect(client._rpc).not.toHaveBeenCalled();
    // (b) an ephemeral denial is sent
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Manage Server'),
    );
    // (c) a denied audit_logs row is written
    expect(client._tables).toContain('audit_logs');
    expect(client._insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'levels.xp_admin.denied', success: false }),
    );
  });

  it('allows a caller with Manage-Guild: XP RPC runs, no denial audit', async () => {
    const interaction = makeInteraction(true, 'add');
    const client = makeClient();

    await handleXpAdminCommand(interaction as any, client as any);

    expect(client._rpc).toHaveBeenCalledWith('increment_member_xp', expect.any(Object));
    expect(client._tables).not.toContain('audit_logs');
  });
});
