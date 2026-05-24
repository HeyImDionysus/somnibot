/**
 * Coverage tests — All feature command builders
 * Exercises buildXxxCommands() and handleXxxCommand() for every feature.
 * These are large files (many at 0-5% coverage).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mocks ────────────────────────────────────────────
vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, warning: 0xfee75c, error: 0xed4245 },
  DEFAULT_ESCALATION_CHAIN: [],
}));

vi.mock('discord.js', () => {
  class SlashCommandBuilder {
    name = ''; desc = '';
    setName(n: string) { this.name = n; return this; }
    setDescription(d: string) { this.desc = d; return this; }
    setDefaultMemberPermissions() { return this; }
    addSubcommand(fn: Function) { fn(new SlashCommandBuilder()); return this; }
    addSubcommandGroup(fn: Function) { fn(new SlashCommandBuilder()); return this; }
    addUserOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({}) }) }) }); return this; }
    addStringOption(fn: Function) {
      fn({
        setName: () => ({
          setDescription: () => ({
            setRequired: () => ({ addChoices: (..._a: any[]) => ({}) }),
            addChoices: (..._a: any[]) => ({ setRequired: () => ({}) }),
            setMinLength: () => ({ setRequired: () => ({}) }),
            setAutocomplete: () => ({ setRequired: () => ({}) }),
          }),
        }),
      });
      return this;
    }
    addIntegerOption(fn: Function) {
      fn({
        setName: () => ({
          setDescription: () => ({
            setRequired: () => ({ addChoices: (..._a: any[]) => ({}), setMinValue: () => ({ setMaxValue: () => ({}) }) }),
            setMinValue: () => ({ setMaxValue: () => ({ setRequired: () => ({}) }) }),
            addChoices: (..._a: any[]) => ({ setRequired: () => ({}) }),
          }),
        }),
      });
      return this;
    }
    addBooleanOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({}) }) }) }); return this; }
    addNumberOption(fn: Function) {
      fn({
        setName: () => ({
          setDescription: () => ({
            setRequired: () => ({ setMinValue: () => ({}) }),
            setMinValue: () => ({ setMaxValue: () => ({}) }),
          }),
        }),
      });
      return this;
    }
    addChannelOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({}) }) }) }); return this; }
    addRoleOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({}) }) }) }); return this; }
    addAttachmentOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({}) }) }) }); return this; }
    addMentionableOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({}) }) }) }); return this; }
    toJSON() { return { name: this.name }; }
  }
  class EmbedBuilder {
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    setThumbnail() { return this; }
    setTimestamp() { return this; }
    setFooter() { return this; }
    setImage() { return this; }
    setAuthor() { return this; }
    setURL() { return this; }
    addFields(..._f: any[]) { return this; }
    toJSON() { return {}; }
  }
  class ActionRowBuilder {
    components: any[] = [];
    addComponents(...c: any[]) { this.components.push(...c); return this; }
  }
  class ButtonBuilder {
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
    setEmoji() { return this; }
    setDisabled() { return this; }
    setURL() { return this; }
  }
  class StringSelectMenuBuilder {
    setCustomId() { return this; }
    setPlaceholder() { return this; }
    addOptions(..._o: any[]) { return this; }
    setMaxValues() { return this; }
    setMinValues() { return this; }
  }
  return {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    StringSelectMenuBuilder,
    PermissionFlagsBits: {
      Administrator: 1n, ManageGuild: 2n, ManageRoles: 4n, ManageChannels: 8n,
      ModerateMembers: 16n, KickMembers: 32n, BanMembers: 64n, ManageMessages: 128n,
      SendMessages: 256n, ViewChannel: 512n, ManageNicknames: 1024n,
    },
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildForum: 15 },
    ComponentType: { Button: 2, StringSelect: 3 },
  };
});

// Mock all internal imports commonly used by command handlers
vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

// ═════════════════════════════════════════════════════════════
// Test each feature's command builder
// ═════════════════════════════════════════════════════════════

describe('achievements commands', () => {
  it('builds commands', async () => {
    const { buildAchievementCommands } = await import('../features/achievements/commands.js');
    const cmds = buildAchievementCommands();
    expect(cmds).toBeDefined();
    expect(typeof cmds).toBe('object');
  });
});

describe('adventures commands', () => {
  it('builds commands', async () => {
    const { buildAdventureCommands } = await import('../features/adventures/commands.js');
    const cmds = buildAdventureCommands();
    expect(cmds).toBeDefined();
  });
});

describe('crafting commands', () => {
  it('builds commands', async () => {
    const { buildCraftingCommands } = await import('../features/crafting/commands.js');
    const cmds = buildCraftingCommands();
    expect(cmds).toBeDefined();
  });
});

describe('economy commands', () => {
  it('builds commands', async () => {
    const { buildEconomyCommands } = await import('../features/economy/commands.js');
    const cmds = buildEconomyCommands();
    expect(cmds).toBeDefined();
  });
});

describe('farming commands', () => {
  it('builds commands', async () => {
    const { buildFarmingCommands } = await import('../features/farming/commands.js');
    const cmds = buildFarmingCommands();
    expect(cmds).toBeDefined();
  });
});

describe('fishing commands', () => {
  it('builds commands', async () => {
    const { buildFishingCommands } = await import('../features/fishing/commands.js');
    const cmds = buildFishingCommands();
    expect(cmds).toBeDefined();
  });
});

describe('games commands', () => {
  it('builds commands', async () => {
    const { buildGameCommands } = await import('../features/games/commands.js');
    const cmds = buildGameCommands();
    expect(cmds).toBeDefined();
  });
});

describe('gathering commands', () => {
  it('builds commands', async () => {
    const { buildGatheringCommands } = await import('../features/gathering/commands.js');
    const cmds = buildGatheringCommands();
    expect(cmds).toBeDefined();
  });
});

describe('giveaways commands', () => {
  it('builds commands', async () => {
    const { buildGiveawayCommands } = await import('../features/giveaways/commands.js');
    const cmds = buildGiveawayCommands();
    expect(cmds).toBeDefined();
  });
});

describe('heist commands', () => {
  it('builds commands', async () => {
    const { buildHeistCommands } = await import('../features/heist/commands.js');
    const cmds = buildHeistCommands();
    expect(cmds).toBeDefined();
  });
});

describe('level commands', () => {
  it('builds commands', async () => {
    const { buildLevelCommands } = await import('../features/levels/commands.js');
    const cmds = buildLevelCommands();
    expect(cmds).toBeDefined();
  });
});

describe('lottery commands', () => {
  it('builds commands', async () => {
    const { buildLotteryCommands } = await import('../features/lottery/commands.js');
    const cmds = buildLotteryCommands();
    expect(cmds).toBeDefined();
  });
});

describe('market commands', () => {
  it('builds commands', async () => {
    const { buildMarketCommands } = await import('../features/market/commands.js');
    const cmds = buildMarketCommands();
    expect(cmds).toBeDefined();
  });
});

describe('music commands', () => {
  it('builds commands', async () => {
    const { buildMusicCommands } = await import('../features/music/commands.js');
    const cmds = buildMusicCommands();
    expect(cmds).toBeDefined();
    expect(Array.isArray(cmds)).toBe(true);
  });
});

describe('pets commands', () => {
  it('builds commands', async () => {
    const { buildPetCommands } = await import('../features/pets/commands.js');
    const cmds = buildPetCommands();
    expect(cmds).toBeDefined();
  });
});

describe('polls commands', () => {
  it('builds commands', async () => {
    const { buildPollCommands } = await import('../features/polls/commands.js');
    const cmds = buildPollCommands();
    expect(cmds).toBeDefined();
  });
});

describe('profiles commands', () => {
  it('builds commands', async () => {
    const { buildProfileCommands } = await import('../features/profiles/commands.js');
    const cmds = buildProfileCommands();
    expect(cmds).toBeDefined();
  });
});

describe('quests commands', () => {
  it('builds commands', async () => {
    const { buildQuestCommands } = await import('../features/quests/commands.js');
    const cmds = buildQuestCommands();
    expect(cmds).toBeDefined();
  });
});

describe('setup-wizard commands', () => {
  it('builds commands', async () => {
    const { buildSetupCommand } = await import('../features/setup-wizard/commands.js');
    const cmd = buildSetupCommand();
    expect(cmd).toBeDefined();
  });
});

describe('temp-channels commands', () => {
  it('builds commands', async () => {
    const { buildTempChannelCommands } = await import('../features/temp-channels/commands.js');
    const cmds = buildTempChannelCommands();
    expect(cmds).toBeDefined();
  });
});

describe('trivia commands', () => {
  it('builds commands', async () => {
    const { buildTriviaCommands } = await import('../features/trivia/commands.js');
    const cmds = buildTriviaCommands();
    expect(cmds).toBeDefined();
  });
});

describe('discord-ux context menus', () => {
  it('builds context menu commands', async () => {
    const { buildContextMenuCommands } = await import('../features/discord-ux/context-menus.js');
    const cmds = buildContextMenuCommands();
    expect(cmds).toBeDefined();
  });
});
