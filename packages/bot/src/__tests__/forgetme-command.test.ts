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
import { writeAuditLog } from '../services/audit.js';

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

function finalDescription(interaction: ReturnType<typeof makeInteraction>['interaction']): string {
  const lastCall = interaction.editReply.mock.calls.at(-1)?.[0] as {
    embeds?: Array<{ data?: { description?: string } }>;
  } | undefined;
  return String(lastCall?.embeds?.[0]?.data?.description ?? '');
}

describe('/forgetme two-phase commerce cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports pending role cleanup without claiming completion or writing a completion audit', async () => {
    const { interaction } = makeInteraction();
    const supabase = {
      rpc: vi.fn(async () => ({
        data: {
          purge_status: 'pending_role_cleanup',
          pending_role_cleanup_count: 2,
          economy_wallets: 1,
        },
        error: null,
      })),
    };

    await handleForgetMeCommand(interaction as any, supabase as any, 'guild-1');

    expect(finalDescription(interaction)).toContain('still removing Discord roles');
    expect(finalDescription(interaction)).toContain('Pending cleanup work:** 2');
    expect(finalDescription(interaction)).not.toContain('All of your personal data has been permanently deleted');
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it('writes a completion audit using numeric counters only after cleanup settles', async () => {
    const { interaction } = makeInteraction();
    const supabase = {
      rpc: vi.fn(async () => ({
        data: {
          purge_status: 'completed',
          pending_role_cleanup_count: 0,
          economy_wallets: 2,
          commerce_role_delivery_intents: 1,
        },
        error: null,
      })),
    };

    await handleForgetMeCommand(interaction as any, supabase as any, 'guild-1');

    expect(finalDescription(interaction)).toContain('All of your personal data has been permanently deleted');
    expect(writeAuditLog).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        action: 'member.data_purged',
        details: {
          tables_affected: ['economy_wallets', 'commerce_role_delivery_intents'],
          total_records: 3,
        },
      }),
    );
  });

  it('fails closed on a lifecycle result without an explicit purge status', async () => {
    const { interaction } = makeInteraction();
    const supabase = {
      rpc: vi.fn(async () => ({ data: { economy_wallets: 1 }, error: null })),
    };

    await handleForgetMeCommand(interaction as any, supabase as any, 'guild-1');

    expect(finalDescription(interaction)).toContain('invalid result');
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
