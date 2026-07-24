/**
 * Deep tests for features/games/games-manager.ts — coinflip, slots, dice, rps, blackjack.
 * 229 uncovered statements at 61.7%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return { ...actual };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { GamesManager } from '../features/games/games-manager.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range', 'ilike', 'like']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null, count: 0 });
  return chain;
}

function makeSupa() {
  return {
    from: vi.fn(() => makeChain({
      guild_id: 'guild-1', games_enabled: true,
      games_min_bet: 10, games_max_bet: 10000,
      games_daily_loss_limit: 50000,
      currency_symbol: '💰', currency_name: 'coins',
    })),
    rpc: vi.fn(async () => ({ data: 5000, error: null })),
  } as any;
}

function makeInteraction() {
  return {
    guildId: 'guild-1',
    channelId: 'ch-1',
    user: { id: 'user-1', username: 'Tester', displayAvatarURL: () => 'url' },
    member: { id: 'user-1' },
    options: {
      getString: vi.fn(() => 'heads'),
      getInteger: vi.fn(() => 100),
    },
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    channel: {
      id: 'ch-1',
      send: vi.fn().mockResolvedValue({
        id: 'msg-1',
        createMessageComponentCollector: vi.fn(() => ({
          on: vi.fn(),
          stop: vi.fn(),
        })),
      }),
    },
  } as any;
}

describe('GamesManager deep', () => {
  let mgr: GamesManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new GamesManager(makeSupa());
  });

  it('coinflip plays a coin flip game', async () => {
    const interaction = makeInteraction();
    await mgr.coinflip(interaction, 100);
    // Should respond to the interaction
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('slots plays a slot machine game', async () => {
    const interaction = makeInteraction();
    await mgr.slots(interaction, 100);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('rps plays rock-paper-scissors', async () => {
    const interaction = makeInteraction();
    await mgr.rps(interaction, 100, 'rock');
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('dice plays a dice game', async () => {
    const interaction = makeInteraction();
    await mgr.dice(interaction, 100);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('blackjack starts a blackjack game', async () => {
    const interaction = makeInteraction();
    await mgr.blackjack(interaction, 100);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0 || interaction.channel.send.mock.calls.length > 0;
    expect(responded).toBe(true);
  });
});

// ── [game-economy-casino] white-label currency branding ───────────────────
// The casino outcome surfaces must brand with the guild's configured
// currency_name/currency_emoji instead of the literal word "coins".
describe('GamesManager white-label currency branding', () => {
  // Table-aware mock so validateBet reaches the outcome embed: an enabled
  // config, a funded wallet, and no-error RPCs for the balance mutations.
  function makeBrandedSupa() {
    const config = {
      guild_id: 'guild-1',
      economy_games_enabled: true,
      economy_coinflip_max_bet: 10000,
      economy_slots_max_bet: 10000,
      economy_daily_loss_limit: 0,
      currency_name: 'Gems',
      currency_emoji: '💎',
    };
    return {
      from: vi.fn((table: string) => {
        if (table === 'economy_wallets') return makeChain({ wallet: 100000 });
        return makeChain(config);
      }),
      rpc: vi.fn(async () => ({ data: 0, error: null })),
    } as any;
  }

  function lastEmbedText(interaction: any): string {
    const calls = interaction.reply.mock.calls;
    const args = calls[calls.length - 1][0];
    const embed = args.embeds[0];
    const data = embed.data ?? embed;
    return `${data.title ?? ''} ${data.description ?? ''}`;
  }

  it('coinflip outcome embed uses the configured currency, never "coins"', async () => {
    const mgr = new GamesManager(makeBrandedSupa());
    const interaction = makeInteraction();
    await mgr.coinflip(interaction, 100);
    const text = lastEmbedText(interaction);
    expect(text).toContain('Gems');
    expect(text).toContain('💎');
    expect(text.toLowerCase()).not.toContain('coins');
  });

  it('slots outcome embed uses the configured currency, never "coins"', async () => {
    const mgr = new GamesManager(makeBrandedSupa());
    const interaction = makeInteraction();
    await mgr.slots(interaction, 100);
    const text = lastEmbedText(interaction);
    expect(text).toContain('Gems');
    expect(text.toLowerCase()).not.toContain('coins');
  });
});
