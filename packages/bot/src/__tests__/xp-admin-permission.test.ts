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

// Note: no calculateLevel mock — since the level-curve-parity fix, the /xp
// admin handler never computes a level in TS; the set_member_xp RPC is the
// single writer of member_levels.level semantics.
vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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
  const emit = vi.fn();
  return { supabase: { from, rpc } as any, eventBus: { emit } as any, _insert: insert, _rpc: rpc, _emit: emit, _tables: tables };
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
    // The successful mutation emits an append-only audit event.
    expect(client._emit).toHaveBeenCalledWith(
      'xp.admin_adjusted', 'g1',
      expect.objectContaining({ operation: 'add', targetId: 'target1', actorId: 'actor1' }),
    );
  });
});

describe('handleXpAdminCommand — /xp set goes through the set_member_xp RPC', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls set_member_xp with the raw XP and never upserts member_levels directly', async () => {
    const interaction = makeInteraction(true, 'set');
    const client = makeClient();
    client._rpc.mockResolvedValue({
      data: { new_xp: 100, old_level: 10, new_level: 1, leveled_up: false },
      error: null,
    });

    await handleXpAdminCommand(interaction as any, client as any);

    // The level is computed in SQL (public.level_for_xp) — the handler must
    // not hand-compute it and must not write member_levels itself. That
    // client-side write is exactly what used to create phantom multi-level
    // jumps (quadratic level written, next message-XP RPC recomputed flat).
    expect(client._rpc).toHaveBeenCalledWith('set_member_xp', {
      p_guild_id: 'g1',
      p_member_id: 'target1',
      p_xp: 100,
    });
    expect(client._tables).not.toContain('member_levels');

    // The reply and the audit event both use the RPC's level, not a TS one.
    expect(client._emit).toHaveBeenCalledWith(
      'xp.admin_adjusted', 'g1',
      expect.objectContaining({ operation: 'set', targetId: 'target1', newXp: 100, newLevel: 1 }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Level 1'));
  });

  it('reports failure and emits nothing when the RPC errors', async () => {
    const interaction = makeInteraction(true, 'set');
    const client = makeClient();
    client._rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await handleXpAdminCommand(interaction as any, client as any);

    expect(client._tables).not.toContain('member_levels');
    expect(client._emit).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Failed to set XP'));
  });
});
