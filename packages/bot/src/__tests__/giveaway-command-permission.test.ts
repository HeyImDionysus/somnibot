import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleGiveawayCommand } from '../features/giveaways/commands.js';

function makeManager() {
  return {
    create: vi.fn(),
    endGiveaway: vi.fn(),
    reroll: vi.fn(),
    pauseGiveaway: vi.fn(),
    resumeGiveaway: vi.fn(),
    getDefaultWinnerCount: vi.fn(),
  };
}

function makeInteraction(hasManageGuild: boolean) {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn().mockReturnValue({ insert, upsert });
  return {
    id: 'interaction-1',
    guildId: 'guild-1',
    user: { id: 'actor-1' },
    memberPermissions: { has: vi.fn().mockReturnValue(hasManageGuild) },
    options: {
      getSubcommand: vi.fn().mockReturnValue('list'),
      getString: vi.fn().mockReturnValue(null),
    },
    client: { supabase: { from } },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    _from: from,
    _insert: insert,
    _upsert: upsert,
  };
}

describe('handleGiveawayCommand Manage-Guild re-check', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies and audits an override-authorized caller without Manage Server', async () => {
    const interaction = makeInteraction(false);
    const manager = makeManager();

    await handleGiveawayCommand(interaction as never, manager as never);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining('Manage Server'),
      ephemeral: true,
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(Object.values(manager).every((method) => method.mock.calls.length === 0)).toBe(true);
    expect(interaction._from).toHaveBeenCalledWith('audit_logs');
    expect(interaction._insert).not.toHaveBeenCalled();
    expect(interaction._upsert).toHaveBeenCalledWith(
      [expect.objectContaining({
        action: 'giveaway.command.denied',
        actor_id: 'actor-1',
        success: false,
      })],
      { onConflict: 'guild_id,occurrence_key', ignoreDuplicates: true },
    );
  });

  it('allows a caller with Manage Server to reach the requested subcommand', async () => {
    const interaction = makeInteraction(true);
    const manager = makeManager();

    await handleGiveawayCommand(interaction as never, manager as never);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('dashboard'),
    });
    expect(interaction._from).not.toHaveBeenCalled();
  });
});
