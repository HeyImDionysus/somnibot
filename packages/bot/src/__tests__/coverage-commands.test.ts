/**
 * Coverage tests — All feature command builders
 * Exercises buildXxxCommands() for every feature.
 */
import { describe, it, expect, vi } from 'vitest';

// ── Shared mocks ────────────────────────────────────────────
vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, warning: 0xfee75c, error: 0xed4245 },
  DEFAULT_ESCALATION_CHAIN: [],
}));

/** Returns a proxy that is callable, iterable, and returns itself for every property access. */
function fluent(): any {
  const handler: ProxyHandler<Function> = {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'then') return undefined; // prevent await-hanging
      if (prop === 'toJSON') return () => ({});
      if (prop === 'length') return 0;
      return fluent();
    },
    apply() { return fluent(); },
  };
  return new Proxy(function () {}, handler);
}

vi.mock('discord.js', () => {
  class SlashCommandBuilder {
    [key: string]: any;
    constructor() {
      return new Proxy(this, {
        get(target, prop) {
          if (prop === 'toJSON') return () => ({ name: target._name || '' });
          if (prop === 'constructor') return SlashCommandBuilder;
          if (typeof prop === 'symbol') return undefined;
          // Methods that take a callback: pass in a fluent proxy as arg
          const cbMethods = new Set([
            'addSubcommand', 'addSubcommandGroup',
            'addUserOption', 'addStringOption', 'addIntegerOption',
            'addBooleanOption', 'addNumberOption', 'addChannelOption',
            'addRoleOption', 'addAttachmentOption', 'addMentionableOption',
          ]);
          if (cbMethods.has(prop as string)) {
            return (fn: Function) => { try { fn(fluent()); } catch {} return target; };
          }
          if (prop === 'setName') return (n: string) => { target._name = n; return target; };
          if (prop === 'setDescription' || prop === 'setDefaultMemberPermissions') return () => target;
          return fluent();
        },
      });
    }
  }
  class EmbedBuilder {
    [key: string]: any;
    constructor() {
      return new Proxy(this, {
        get(target, prop) {
          if (typeof prop === 'symbol') return undefined;
          if (prop === 'toJSON') return () => ({});
          return (..._args: any[]) => target;
        },
      });
    }
  }
  class ActionRowBuilder { addComponents() { return this; } }
  class ButtonBuilder {
    [key: string]: any;
    constructor() { return new Proxy(this, { get: (t) => () => t }); }
  }
  class StringSelectMenuBuilder {
    [key: string]: any;
    constructor() { return new Proxy(this, { get: (t) => (..._a: any[]) => t }); }
  }
  class ContextMenuCommandBuilder {
    [key: string]: any;
    constructor() { return new Proxy(this, { get: (t) => () => t }); }
  }
  class ModalBuilder {
    [key: string]: any;
    constructor() { return new Proxy(this, { get: (t) => (..._a: any[]) => t }); }
  }
  class TextInputBuilder {
    [key: string]: any;
    constructor() { return new Proxy(this, { get: (t) => () => t }); }
  }
  class AttachmentBuilder { constructor() {} }

  return {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    StringSelectMenuBuilder,
    ContextMenuCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    AttachmentBuilder,
    PermissionFlagsBits: {
      Administrator: 1n, ManageGuild: 2n, ManageRoles: 4n, ManageChannels: 8n,
      ModerateMembers: 16n, KickMembers: 32n, BanMembers: 64n, ManageMessages: 128n,
      SendMessages: 256n, ViewChannel: 512n, ManageNicknames: 1024n,
    },
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildForum: 15 },
    ComponentType: { Button: 2, StringSelect: 3 },
    ApplicationCommandType: { User: 2, Message: 3 },
    TextInputStyle: { Short: 1, Paragraph: 2 },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

// ═════════════════════════════════════════════════════════════
// Test each feature's command builder
// ═════════════════════════════════════════════════════════════

const commandBuilders: [string, string, string][] = [
  ['achievements', '../features/achievements/commands.js', 'buildAchievementCommands'],
  ['adventures', '../features/adventures/commands.js', 'buildAdventureCommands'],
  ['crafting', '../features/crafting/commands.js', 'buildCraftingCommands'],
  ['economy', '../features/economy/commands.js', 'buildEconomyCommands'],
  ['farming', '../features/farming/commands.js', 'buildFarmingCommands'],
  ['fishing', '../features/fishing/commands.js', 'buildFishingCommands'],
  ['games', '../features/games/commands.js', 'buildGameCommands'],
  ['gathering', '../features/gathering/commands.js', 'buildGatheringCommands'],
  ['giveaways', '../features/giveaways/commands.js', 'buildGiveawayCommands'],
  ['heist', '../features/heist/commands.js', 'buildHeistCommands'],
  ['levels', '../features/levels/commands.js', 'buildLevelCommands'],
  ['lottery', '../features/lottery/commands.js', 'buildLotteryCommands'],
  ['market', '../features/market/commands.js', 'buildMarketCommands'],
  ['music', '../features/music/commands.js', 'buildMusicCommands'],
  ['pets', '../features/pets/commands.js', 'buildPetCommands'],
  ['polls', '../features/polls/commands.js', 'buildPollCommands'],
  ['profiles', '../features/profiles/commands.js', 'buildProfileCommands'],
  ['quests', '../features/quests/commands.js', 'buildQuestCommands'],
  ['trivia', '../features/trivia/commands.js', 'buildTriviaCommands'],
];

for (const [name, path, fn] of commandBuilders) {
  describe(`${name} commands`, () => {
    it('builds commands', async () => {
      const mod = await import(path);
      expect(mod[fn]).toBeDefined();
      const cmds = mod[fn]();
      expect(cmds).toBeDefined();
    });
  });
}

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

describe('level admin commands', () => {
  it('builds xp admin commands', async () => {
    const { buildXpAdminCommands } = await import('../features/levels/admin-commands.js');
    const cmds = buildXpAdminCommands();
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
