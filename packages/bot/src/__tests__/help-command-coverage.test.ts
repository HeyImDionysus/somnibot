/**
 * help/index — coverage tests for help command
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  SlashCommandBuilder: vi.fn().mockImplementation(function () {
    return {
      setName: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      addStringOption: vi.fn().mockImplementation(function (this: any, cb: any) {
        cb({
          setName: vi.fn().mockReturnThis(),
          setDescription: vi.fn().mockReturnThis(),
        });
        return this;
      }),
    };
  }),
  EmbedBuilder: vi.fn().mockImplementation(function () {
    return {
      setColor: vi.fn().mockReturnThis(),
      setTitle: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      setFooter: vi.fn().mockReturnThis(),
      addFields: vi.fn().mockReturnThis(),
    };
  }),
  ActionRowBuilder: vi.fn().mockImplementation(function () {
    return {
      addComponents: vi.fn().mockReturnThis(),
    };
  }),
  StringSelectMenuBuilder: vi.fn().mockImplementation(function () {
    return {
      setCustomId: vi.fn().mockReturnThis(),
      setPlaceholder: vi.fn().mockReturnThis(),
      addOptions: vi.fn().mockReturnThis(),
    };
  }),
  ApplicationCommandType: { ChatInput: 1 },
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
}));

import { buildHelpCommand, handleHelpCommand, handleHelpCategorySelect } from '../features/help/index.js';

function makeClient(commands: any[] = []) {
  return { _registeredCommands: commands };
}

function makeInteraction(options: Record<string, any> = {}) {
  return {
    options: {
      getString: vi.fn().mockImplementation((name: string) => options[name] ?? null),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    values: options.values ?? [],
    client: options.client ?? makeClient(),
  };
}

const sampleCommands = [
  { name: 'help', description: 'Get help', type: 1 },
  { name: 'warn', description: 'Warn a user', type: 1 },
  { name: 'play', description: 'Play music', type: 1, options: [
    { name: 'song', description: 'Play a song', type: 1 },
    { name: 'playlist', description: 'Play a playlist', type: 1 },
  ]},
  { name: 'rank', description: 'View rank', type: 1 },
  { name: 'unknown-cmd', description: 'Unknown category', type: 1 },
  // Context menu command — should be skipped
  { name: 'Report Message', description: 'Report', type: 3 },
];

describe('buildHelpCommand', () => {
  it('builds a help command', () => {
    const cmd = buildHelpCommand();
    expect(cmd).toBeDefined();
  });
});

describe('handleHelpCommand', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows overview when no specific command', async () => {
    const client = makeClient(sampleCommands);
    const interaction = makeInteraction({ client });
    await handleHelpCommand(interaction as any, client as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.any(Array),
      components: expect.any(Array),
    }));
  });

  it('shows specific command info', async () => {
    const client = makeClient(sampleCommands);
    const interaction = makeInteraction({ command: '/help', client });
    await handleHelpCommand(interaction as any, client as any);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('shows error for unknown command', async () => {
    const client = makeClient(sampleCommands);
    const interaction = makeInteraction({ command: '/nonexistent', client });
    await handleHelpCommand(interaction as any, client as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('not found'),
    }));
  });

  it('handles command without slash prefix', async () => {
    const client = makeClient(sampleCommands);
    const interaction = makeInteraction({ command: 'warn', client });
    await handleHelpCommand(interaction as any, client as any);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('handles empty command registry', async () => {
    const client = makeClient([]);
    const interaction = makeInteraction({ client });
    await handleHelpCommand(interaction as any, client as any);
    expect(interaction.reply).toHaveBeenCalled();
  });
});

describe('handleHelpCategorySelect', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows category details', async () => {
    const client = makeClient(sampleCommands);
    const interaction = makeInteraction({ values: ['Music'], client });
    await handleHelpCategorySelect(interaction as any, client as any);
    expect(interaction.update).toHaveBeenCalled();
  });

  it('shows error for unknown category', async () => {
    const client = makeClient(sampleCommands);
    const interaction = makeInteraction({ values: ['Nonexistent'], client });
    await handleHelpCategorySelect(interaction as any, client as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('not found'),
    }));
  });
});
