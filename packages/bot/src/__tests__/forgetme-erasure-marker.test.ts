/**
 * /forgetme erasure marker — marker-first ordering (P2 batch, B8).
 *
 * The member_erasures marker must be written BEFORE purge_member_data runs:
 * marker-first means a partial failure still suppresses the roster backfill
 * from resurrecting the erased record. If the marker cannot be written the
 * purge must not run at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: Record<string, unknown> = {};
    setTitle(value: string) { this.data.title = value; return this; }
    setDescription(value: string) { this.data.description = value; return this; }
    setColor(value: number) { this.data.color = value; return this; }
    setFooter(value: unknown) { this.data.footer = value; return this; }
  }
  class ChainBuilder {
    setName() { return this; }
    setDescription() { return this; }
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
    setEmoji() { return this; }
    addComponents() { return this; }
  }
  return {
    SlashCommandBuilder: ChainBuilder,
    EmbedBuilder,
    ActionRowBuilder: ChainBuilder,
    ButtonBuilder: ChainBuilder,
    ButtonStyle: { Danger: 4, Secondary: 2 },
    ComponentType: { Button: 2 },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { handleForgetMeCommand } from '../features/privacy/forgetme-command.js';

function makeInteraction() {
  const button = {
    customId: 'forgetme_confirm',
    user: { id: 'user-1' },
    update: vi.fn(async () => {}),
  };
  const reply = {
    awaitMessageComponent: vi.fn(async () => button),
  };
  const interaction = {
    user: { id: 'user-1' },
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn()
      .mockResolvedValueOnce(reply)
      .mockResolvedValue(undefined),
  };
  return { interaction, button };
}

function makeSupabase(options: { markerError?: { message: string } | null } = {}) {
  const order: string[] = [];
  const upsert = vi.fn(async (..._args: unknown[]) => {
    order.push('marker-upsert');
    return { error: options.markerError ?? null };
  });
  return {
    order,
    upsert,
    from: vi.fn((table: string) => {
      expect(table).toBe('member_erasures');
      return { upsert };
    }),
    rpc: vi.fn(async () => {
      order.push('rpc');
      return {
        data: { purge_status: 'completed', pending_role_cleanup_count: 0, economy_wallets: 1 },
        error: null,
      };
    }),
  };
}

function embedDescription(call: unknown): string {
  const payload = call as { embeds?: Array<{ data?: { description?: string } }> } | undefined;
  return String(payload?.embeds?.[0]?.data?.description ?? '');
}

describe('/forgetme erasure marker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the marker BEFORE invoking purge_member_data', async () => {
    const { interaction } = makeInteraction();
    const supabase = makeSupabase();

    await handleForgetMeCommand(interaction as never, supabase as never, 'guild-1');

    expect(supabase.order).toEqual(['marker-upsert', 'rpc']);
    expect(supabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ guild_id: 'guild-1', discord_id: 'user-1' }),
      { onConflict: 'guild_id,discord_id' },
    );
    const finalDescription = embedDescription(interaction.editReply.mock.calls.at(-1)?.[0]);
    expect(finalDescription).toContain('permanently deleted');
  });

  it('aborts without purging when the marker write fails', async () => {
    const { interaction } = makeInteraction();
    const supabase = makeSupabase({ markerError: { message: 'insert denied' } });

    await handleForgetMeCommand(interaction as never, supabase as never, 'guild-1');

    expect(supabase.order).toEqual(['marker-upsert']);
    expect(supabase.rpc).not.toHaveBeenCalled();
    const finalDescription = embedDescription(interaction.editReply.mock.calls.at(-1)?.[0]);
    expect(finalDescription).toContain('error occurred');
  });

  it('tells the member the truth about staying vs rejoining in the confirmation copy', async () => {
    const { interaction } = makeInteraction();
    const supabase = makeSupabase();

    await handleForgetMeCommand(interaction as never, supabase as never, 'guild-1');

    const confirmDescription = embedDescription(interaction.editReply.mock.calls[0]?.[0]);
    expect(confirmDescription).toContain('New data will accumulate');
    expect(confirmDescription).toContain('leave and rejoin');
  });
});
