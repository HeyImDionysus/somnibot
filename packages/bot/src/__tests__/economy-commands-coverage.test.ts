/**
 * economy/commands — coverage tests
 *
 * Tests buildEconomyCommands and handleEconomyCommand (620 lines).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  SlashCommandBuilder: vi.fn().mockImplementation(function () {
    return {
      setName: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      addUserOption: vi.fn().mockImplementation(function (this: any, cb: any) {
        cb({ setName: vi.fn().mockReturnThis(), setDescription: vi.fn().mockReturnThis(), setRequired: vi.fn().mockReturnThis() });
        return this;
      }),
      addIntegerOption: vi.fn().mockImplementation(function (this: any, cb: any) {
        cb({ setName: vi.fn().mockReturnThis(), setDescription: vi.fn().mockReturnThis(), setRequired: vi.fn().mockReturnThis(), setMinValue: vi.fn().mockReturnThis(), setMaxValue: vi.fn().mockReturnThis() });
        return this;
      }),
      addNumberOption: vi.fn().mockImplementation(function (this: any, cb: any) {
        cb({ setName: vi.fn().mockReturnThis(), setDescription: vi.fn().mockReturnThis(), setRequired: vi.fn().mockReturnThis(), setMinValue: vi.fn().mockReturnThis(), setMaxValue: vi.fn().mockReturnThis() });
        return this;
      }),
      addStringOption: vi.fn().mockImplementation(function (this: any, cb: any) {
        cb({ setName: vi.fn().mockReturnThis(), setDescription: vi.fn().mockReturnThis(), setRequired: vi.fn().mockReturnThis(), addChoices: vi.fn().mockReturnThis() });
        return this;
      }),
      addSubcommand: vi.fn().mockImplementation(function (this: any, cb: any) {
        cb({
          setName: vi.fn().mockReturnThis(),
          setDescription: vi.fn().mockReturnThis(),
          addIntegerOption: vi.fn().mockReturnThis(),
          addStringOption: vi.fn().mockReturnThis(),
          addUserOption: vi.fn().mockReturnThis(),
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
      setAuthor: vi.fn().mockReturnThis(),
      setFooter: vi.fn().mockReturnThis(),
      setTimestamp: vi.fn().mockReturnThis(),
      addFields: vi.fn().mockReturnThis(),
      setThumbnail: vi.fn().mockReturnThis(),
    };
  }),
  ActionRowBuilder: vi.fn().mockImplementation(function () {
    return {
      addComponents: vi.fn().mockReturnThis(),
    };
  }),
  ButtonBuilder: vi.fn().mockImplementation(function () {
    return {
      setCustomId: vi.fn().mockReturnThis(),
      setLabel: vi.fn().mockReturnThis(),
      setEmoji: vi.fn().mockReturnThis(),
      setStyle: vi.fn().mockReturnThis(),
      setDisabled: vi.fn().mockReturnThis(),
    };
  }),
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  StringSelectMenuBuilder: vi.fn().mockImplementation(function () {
    return {
      setCustomId: vi.fn().mockReturnThis(),
      setPlaceholder: vi.fn().mockReturnThis(),
      addOptions: vi.fn().mockReturnThis(),
    };
  }),
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { buildEconomyCommands, handleEconomyCommand } from '../features/economy/commands.js';

function makeManager(overrides: any = {}) {
  const cfg = { economy_enabled: true, currency_emoji: '💰', currency_name: 'coins', ...overrides.config };
  return {
    loadConfig: vi.fn().mockResolvedValue(cfg),
    getOrCreateWallet: vi.fn().mockResolvedValue({ wallet: 500, bank: 200, bank_max: 10000, passive: false }),
    claimTimedReward: vi.fn().mockResolvedValue({ success: true, message: 'You got 100 coins!', balance: { wallet: 600 }, streak: { current_streak: 3, longest_streak: 5 } }),
    work: vi.fn().mockResolvedValue({ success: true, message: 'You earned 50 coins', balance: { wallet: 550 } }),
    crime: vi.fn().mockResolvedValue({ success: true, message: 'You stole 200 coins', balance: { wallet: 700 } }),
    beg: vi.fn().mockResolvedValue({ message: 'Someone gave you 10 coins' }),
    search: vi.fn().mockResolvedValue({ message: 'You found 30 coins in a dumpster' }),
    deposit: vi.fn().mockResolvedValue({ success: true, message: 'Deposited 500' }),
    withdraw: vi.fn().mockResolvedValue({ success: true, message: 'Withdrew 200' }),
    pay: vi.fn().mockResolvedValue({ success: true, message: 'Sent 100 to user' }),
    rob: vi.fn().mockResolvedValue({ success: true, message: 'You robbed 150 coins', balance: { wallet: 650 } }),
    togglePassive: vi.fn().mockResolvedValue({ passive: true }),
    getShopItems: vi.fn().mockResolvedValue([{ id: 'item1', name: 'Sword', price: 100, emoji: '⚔️', description: 'A sword' }]),
    // The command path reads the CHECKED variant so a failed catalog read is
    // reported as an outage rather than an empty shop (degraded=false here).
    getShopItemsChecked: vi.fn().mockResolvedValue({
      items: [{ id: 'item1', name: 'Sword', price: 100, emoji: '⚔️', description: 'A sword' }],
      degraded: false,
    }),
    buyItem: vi.fn().mockResolvedValue({ success: true, message: 'Bought Sword' }),
    sellItem: vi.fn().mockResolvedValue({ success: true, message: 'Sold Sword for 50' }),
    getInventory: vi.fn().mockResolvedValue([{ item_name: 'Sword', quantity: 2, emoji: '⚔️', item_id: 'item1' }]),
    useItem: vi.fn().mockResolvedValue({ success: true, message: 'Used Sword' }),
    getLeaderboard: vi.fn().mockResolvedValue([{ user_id: 'u1', wallet: 1000, bank: 500, net_worth: 1500 }]),
    ...overrides,
  };
}

function makeInteraction(commandName: string, options: Record<string, any> = {}) {
  return {
    commandName,
    options: {
      getSubcommand: vi.fn().mockReturnValue(options.sub ?? commandName),
      getUser: vi.fn().mockReturnValue(options.user ?? null),
      getInteger: vi.fn().mockReturnValue(options.amount ?? null),
      getString: vi.fn().mockImplementation((_n: string, _req?: boolean) => options.str ?? null),
    },
    user: { id: 'u1', displayName: 'TestUser', displayAvatarURL: () => 'https://example.com/avatar.png' },
    guild: { id: 'g1' },
    guildId: 'g1',
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('buildEconomyCommands', () => {
  it('builds economy commands object', () => {
    const cmds = buildEconomyCommands();
    expect(cmds).toBeDefined();
    expect(typeof cmds).toBe('object');
    expect(Object.keys(cmds).length).toBeGreaterThan(0);
  });
});

describe('handleEconomyCommand', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('handles balance command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('balance');
    await handleEconomyCommand(int as any, mgr as any);
    expect(int.reply).toHaveBeenCalled();
    expect(mgr.getOrCreateWallet).toHaveBeenCalled();
  });

  it('handles balance for another user', async () => {
    const mgr = makeManager();
    const int = makeInteraction('balance', { user: { id: 'u2', displayName: 'Other', displayAvatarURL: () => '' } });
    await handleEconomyCommand(int as any, mgr as any);
    expect(int.reply).toHaveBeenCalled();
  });

  it('handles daily reward', async () => {
    const mgr = makeManager();
    const int = makeInteraction('daily');
    await handleEconomyCommand(int as any, mgr as any);
    expect(int.deferReply).toHaveBeenCalled();
    expect(mgr.claimTimedReward).toHaveBeenCalledWith('u1', 'daily');
    expect(int.editReply).toHaveBeenCalled();
  });

  it('handles daily reward cooldown', async () => {
    const mgr = makeManager({
      claimTimedReward: vi.fn().mockResolvedValue({ success: false, message: 'Come back in 12h' }),
    });
    const int = makeInteraction('daily');
    await handleEconomyCommand(int as any, mgr as any);
    expect(int.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.any(String) }));
  });

  it('handles weekly reward', async () => {
    const mgr = makeManager();
    const int = makeInteraction('weekly');
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.claimTimedReward).toHaveBeenCalledWith('u1', 'weekly');
  });

  it('handles monthly reward', async () => {
    const mgr = makeManager();
    const int = makeInteraction('monthly');
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.claimTimedReward).toHaveBeenCalledWith('u1', 'monthly');
  });

  it('handles work command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('work');
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.work).toHaveBeenCalledWith('u1');
    expect(int.editReply).toHaveBeenCalled();
  });

  it('handles work on cooldown', async () => {
    const mgr = makeManager({
      work: vi.fn().mockResolvedValue({ success: false, message: 'Wait 30 minutes' }),
    });
    const int = makeInteraction('work');
    await handleEconomyCommand(int as any, mgr as any);
    expect(int.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Wait 30 minutes' }));
  });

  it('handles crime command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('crime');
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.crime).toHaveBeenCalledWith('u1');
  });

  it('handles crime failure', async () => {
    const mgr = makeManager({
      crime: vi.fn().mockResolvedValue({ success: false, message: 'Busted! Lost 100 coins', balance: { wallet: 400 } }),
    });
    const int = makeInteraction('crime');
    await handleEconomyCommand(int as any, mgr as any);
    expect(int.editReply).toHaveBeenCalled();
  });

  it('handles beg command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('beg');
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.beg).toHaveBeenCalled();
  });

  it('handles search command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('search');
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.search).toHaveBeenCalled();
  });

  it('handles deposit command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('deposit', { amount: 100 });
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.deposit).toHaveBeenCalled();
  });

  it('handles deposit with no amount (deposit all)', async () => {
    const mgr = makeManager();
    const int = makeInteraction('deposit');
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.getOrCreateWallet).toHaveBeenCalled();
  });

  it('handles deposit 0 wallet', async () => {
    const mgr = makeManager({
      getOrCreateWallet: vi.fn().mockResolvedValue({ wallet: 0, bank: 0, bank_max: 10000, passive: false }),
    });
    const int = makeInteraction('deposit');
    await handleEconomyCommand(int as any, mgr as any);
    expect(int.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("don't have"),
    }));
  });

  it('handles withdraw command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('withdraw', { amount: 50 });
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.withdraw).toHaveBeenCalled();
  });

  it('handles pay command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('pay', { user: { id: 'u2' }, amount: 100 });
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.pay).toHaveBeenCalled();
  });

  it('handles rob command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('rob', { user: { id: 'u2' } });
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.rob).toHaveBeenCalled();
  });

  it('handles passive command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('passive');
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.togglePassive).toHaveBeenCalled();
  });

  it('handles shop command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('shop');
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.getShopItemsChecked).toHaveBeenCalled();
  });

  it('handles buy command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('buy', { str: 'Sword', amount: 1 });
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.buyItem).toHaveBeenCalled();
  });

  it('handles sell command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('sell', { str: 'Sword', amount: 1 });
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.sellItem).toHaveBeenCalled();
  });

  it('handles inventory command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('inventory');
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.getInventory).toHaveBeenCalled();
  });

  it('handles use command (stub)', async () => {
    const mgr = makeManager();
    const int = makeInteraction('use', { str: 'item1' });
    await handleEconomyCommand(int as any, mgr as any);
    expect(int.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('handles economy-leaderboard command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('economy-leaderboard');
    await handleEconomyCommand(int as any, mgr as any);
    expect(mgr.getLeaderboard).toHaveBeenCalled();
  });

  it('handles unknown command', async () => {
    const mgr = makeManager();
    const int = makeInteraction('unknown-cmd');
    await handleEconomyCommand(int as any, mgr as any);
    expect(int.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Unknown'),
    }));
  });
});
