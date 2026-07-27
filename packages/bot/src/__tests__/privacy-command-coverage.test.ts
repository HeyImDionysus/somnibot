/**
 * privacy/privacy-command — coverage tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  SlashCommandBuilder: vi.fn().mockImplementation(function () {
    return {
      setName: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
    };
  }),
  EmbedBuilder: vi.fn().mockImplementation(function () {
    return {
      // Real EmbedBuilder exposes `data`; branded embeds read data.footer.
      data: {} as Record<string, unknown>,
      setTitle: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      setColor: vi.fn().mockReturnThis(),
      setFooter: vi.fn().mockReturnThis(),
    };
  }),
}));

import { buildPrivacyCommand, handlePrivacyCommand } from '../features/privacy/privacy-command.js';

describe('buildPrivacyCommand', () => {
  it('builds a privacy command', () => {
    const cmd = buildPrivacyCommand();
    expect(cmd).toBeDefined();
  });
});

describe('handlePrivacyCommand', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('replies with privacy embed (with dashboard URL)', async () => {
    process.env.NEXT_PUBLIC_DASHBOARD_URL = 'https://dashboard.example.com';
    const interaction = {
      client: {},
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handlePrivacyCommand(interaction as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
    }));
    delete process.env.NEXT_PUBLIC_DASHBOARD_URL;
  });

  it('replies without dashboard URL', async () => {
    delete process.env.NEXT_PUBLIC_DASHBOARD_URL;
    delete process.env.DASHBOARD_URL;
    const interaction = {
      client: {},
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handlePrivacyCommand(interaction as any);
    expect(interaction.reply).toHaveBeenCalled();
  });
});
