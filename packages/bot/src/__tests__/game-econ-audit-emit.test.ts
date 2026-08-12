/**
 * [game-econ observability] Audit-emit tests.
 *
 * Every game-economy feature must emit an append-only audit event on its
 * auditable state change (and denied/failure branches). These tests spy on the
 * shared platform eventBus and assert the emit fires at the state change — the
 * AuditService (subscribed to the same bus) maps each event to an audit_logs row.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: Record<string, unknown> = {};
    setTitle() { return this; } setDescription() { return this; } setColor() { return this; }
    setFooter() { return this; } addFields() { return this; } setTimestamp() { return this; }
    setThumbnail() { return this; } setImage() { return this; } setAuthor() { return this; }
  }
  class ActionRowBuilder { addComponents() { return this; } }
  class ButtonBuilder { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } setEmoji() { return this; } setDisabled() { return this; } }
  return {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ComponentType: { Button: 2 },
  };
});

import { eventBus } from '../services/event-bus.js';
import { QuestsManager } from '../features/quests/quests-manager.js';
import { GamesManager } from '../features/games/games-manager.js';
import { AchievementsManager } from '../features/achievements/achievements-manager.js';
import { AdventureManager } from '../features/adventures/adventure-manager.js';
import { CraftingManager } from '../features/crafting/crafting-manager.js';
import { MarketManager } from '../features/market/market-manager.js';
import { FarmingManager } from '../features/farming/farming-manager.js';
import { GatheringManager } from '../features/gathering/gathering-manager.js';
import { FishingManager } from '../features/fishing/fishing-manager.js';
import { HeistManager } from '../features/heist/heist-manager.js';
import { LotteryManager } from '../features/lottery/lottery-manager.js';
import { PetsManager } from '../features/pets/pets-manager.js';
import { TriviaManager } from '../features/trivia/trivia-manager.js';
import { EconomyManager } from '../features/economy/economy-manager.js';

// A permissive Supabase query-builder stub: every builder method is chainable,
// single/maybeSingle resolve to { data, error }, and awaiting the builder
// resolves to a list-shaped { data, error, count }.
function supaChain(data: any = null, error: any = null, count?: number): any {
  const c: any = {};
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'ilike', 'contains', 'order',
    'limit', 'range', 'head'];
  for (const m of methods) c[m] = (..._a: any[]) => c;
  c.single = async () => ({ data, error });
  c.maybeSingle = async () => ({ data, error });
  c.then = (resolve: any) =>
    resolve({ data: Array.isArray(data) ? data : (data ? [data] : []), error, count });
  return c;
}

function makeSupabase(tableMap: Record<string, () => any> = {}, rpcMap: Record<string, (a?: any) => any> = {}): any {
  return {
    from: vi.fn((t: string) => (tableMap[t] ? tableMap[t]() : supaChain())),
    rpc: vi.fn(async (fn: string, args?: any) => (rpcMap[fn] ? rpcMap[fn](args) : { data: null, error: null })),
  };
}

function makeInteraction(overrides: Record<string, any> = {}): any {
  return {
    guildId: 'g1',
    channelId: 'c1',
    user: { id: 'u1' },
    options: { getString: () => null, getUser: () => null, getInteger: () => null, getSubcommand: () => '' },
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    ...overrides,
  };
}

function spyEmit() {
  return vi.spyOn(eventBus, 'emit').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('game-economy-quests', () => {
  it('emits quest.claimed on a successful claim + payout', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({}, {
      economy_quest_atomic_claim: () => ({ data: [{ id: 'q1', reward_currency: 100, reward_xp: 50 }], error: null }),
      economy_add_balance: () => ({ data: null, error: null }),
    });
    const mgr = new QuestsManager(supabase);
    await mgr.claimQuests(makeInteraction());
    expect(emit).toHaveBeenCalledWith('quest.claimed', 'g1', expect.objectContaining({ userId: 'u1', questCount: 1, currency: 100 }));
  });

  it('emits quest.claim_failed when the payout RPC errors', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({}, {
      economy_quest_atomic_claim: () => ({ data: [{ id: 'q1', reward_currency: 100, reward_xp: 0 }], error: null }),
      economy_add_balance: () => ({ data: null, error: { message: 'boom' } }),
    });
    const mgr = new QuestsManager(supabase);
    await mgr.claimQuests(makeInteraction());
    expect(emit).toHaveBeenCalledWith('quest.claim_failed', 'g1', expect.objectContaining({ userId: 'u1' }));
  });
});

describe('game-economy-casino', () => {
  it('emits casino.bet_settled when a bet resolves', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({}, { economy_resolve_bet: () => ({ data: { status: 'ok' }, error: null }) });
    const mgr = new GamesManager(supabase);
    const ok = await (mgr as any).settleBet('g1', 'u1', 250, 'coinflip', 'i1');
    expect(ok).toBe(true);
    expect(emit).toHaveBeenCalledWith('casino.bet_settled', 'g1', expect.objectContaining({ userId: 'u1', game: 'coinflip', net: 250 }));
  });
});

describe('game-economy-achievements-prestige', () => {
  it('emits achievement.unlocked when a badge is newly unlocked', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_achievements_enabled: true }),
      economy_achievement_defs: () => supaChain([{ id: 'a1', condition_value: 5, reward_currency: 100, name: 'First Steps' }]),
      economy_user_achievements: () => supaChain([{ id: 'x' }]),
    }, { economy_add_balance: () => ({ data: null, error: null }) });
    const mgr = new AchievementsManager(supabase);
    await mgr.checkAndUnlock('g1', 'u1', 'messages', 10);
    expect(emit).toHaveBeenCalledWith('achievement.unlocked', 'g1', expect.objectContaining({ userId: 'u1', achievementId: 'a1', name: 'First Steps' }));
  });

  it('emits prestige.performed on a successful prestige', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_prestige_enabled: true }),
    }, { economy_prestige_apply: () => ({ data: { status: 'prestiged', new_level: 2, new_multiplier: 20 }, error: null }) });
    const mgr = new AchievementsManager(supabase);
    await mgr.prestige(makeInteraction());
    expect(emit).toHaveBeenCalledWith('prestige.performed', 'g1', expect.objectContaining({ userId: 'u1', newLevel: 2, newMultiplier: 20 }));
  });
});

describe('game-economy-adventures', () => {
  it('emits adventure.completed when a session ends', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({}, { economy_add_balance: () => ({ data: null, error: null }) });
    const mgr = new AdventureManager({ id: 'g1', client: {} } as any, supabase, {} as any);
    await (mgr as any).endSession({ id: 's1', user_id: 'u1' }, 'completed', [], 100);
    expect(emit).toHaveBeenCalledWith('adventure.completed', 'g1', expect.objectContaining({ userId: 'u1', sessionId: 's1', currency: 100 }));
  });

  it('emits adventure.payout_failed + writes an owner alert on payout error', async () => {
    const emit = spyEmit();
    let alertInserted = false;
    const supabase = makeSupabase({
      alerts: () => { alertInserted = true; return supaChain(); },
    }, { economy_add_balance: () => ({ data: null, error: { message: 'boom' } }) });
    const mgr = new AdventureManager({ id: 'g1', client: {} } as any, supabase, {} as any);
    await (mgr as any).endSession({ id: 's1', user_id: 'u1' }, 'completed', [], 100);
    expect(emit).toHaveBeenCalledWith('adventure.payout_failed', 'g1', expect.objectContaining({ userId: 'u1', sessionId: 's1', amount: 100 }));
    expect(alertInserted).toBe(true);
  });
});

describe('game-economy-crafting', () => {
  it('emits craft.completed on a successful craft', async () => {
    const emit = spyEmit();
    let invCall = 0;
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_crafting_enabled: true, economy_crafting_cooldown_seconds: 60 }),
      economy_recipes: () => supaChain([{ id: 'r1', name: 'Gold Bar', emoji: '🥇', description: '', inputs: [{ item_name: 'Gold Nugget', qty: 5 }], output_item_id: 'o1', output_qty: 1, cooldown_seconds: 120, category: 'Materials' }]),
      economy_inventory: () => {
        invCall += 1;
        return invCall === 1
          ? supaChain([{ quantity: 10, item_id: 'gn', economy_items: { name: 'Gold Nugget' } }])
          : supaChain([{ item_id: 'gn', economy_items: { name: 'Gold Nugget' } }]);
      },
      economy_wallets: () => supaChain({ wallet: 0 }),
    }, {
      economy_decrement_inventory: () => ({ data: true, error: null }),
      economy_upsert_inventory: () => ({ data: null, error: null }),
    });
    const valkey: any = { set: async () => 'OK', pttl: async () => 0 };
    const mgr = new CraftingManager({ id: 'g1' } as any, supabase, valkey);
    await mgr.craft('u1', 'Gold Bar');
    expect(emit).toHaveBeenCalledWith('craft.completed', 'g1', expect.objectContaining({ userId: 'u1', recipeName: 'Gold Bar', outputQty: 1 }));
  });

  it('emits craft.failed + writes an owner alert when the output grant fails', async () => {
    const emit = spyEmit();
    let alertInserted = false;
    let invCall = 0;
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_crafting_enabled: true, economy_crafting_cooldown_seconds: 60 }),
      economy_recipes: () => supaChain([{ id: 'r1', name: 'Gold Bar', emoji: '🥇', description: '', inputs: [{ item_name: 'Gold Nugget', qty: 5 }], output_item_id: 'o1', output_qty: 1, cooldown_seconds: 120, category: 'Materials' }]),
      economy_inventory: () => {
        invCall += 1;
        return invCall === 1
          ? supaChain([{ quantity: 10, item_id: 'gn', economy_items: { name: 'Gold Nugget' } }])
          : supaChain([{ item_id: 'gn', economy_items: { name: 'Gold Nugget' } }]);
      },
      alerts: () => { alertInserted = true; return supaChain(); },
    }, {
      economy_decrement_inventory: () => ({ data: true, error: null }),
      economy_upsert_inventory: (a: any) => (a?.p_item_id === 'o1' ? { data: null, error: { message: 'boom' } } : { data: null, error: null }),
    });
    const valkey: any = { set: async () => 'OK', pttl: async () => 0 };
    const mgr = new CraftingManager({ id: 'g1' } as any, supabase, valkey);
    await mgr.craft('u1', 'Gold Bar');
    expect(emit).toHaveBeenCalledWith('craft.failed', 'g1', expect.objectContaining({ userId: 'u1', recipeName: 'Gold Bar' }));
    expect(alertInserted).toBe(true);
  });
});

describe('game-economy-shop-market', () => {
  it('emits market.listed when a listing is created', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_market_enabled: true, economy_market_fee_pct: 5, economy_market_listing_days: 7, economy_market_max_listings: 10 }),
      economy_market_listings: () => supaChain([], null, 0),
      economy_inventory: () => supaChain([{ item_id: 'it1', quantity: 5, economy_items: { id: 'it1', name: 'Sword', tradeable: true } }]),
    }, { economy_market_atomic_create_listing: () => ({ data: { listing: { id: 'l1' } }, error: null }) });
    const mgr = new MarketManager({ id: 'g1' } as any, supabase, {} as any);
    await mgr.listItem('u1', 'Sword', 2, 100);
    expect(emit).toHaveBeenCalledWith('market.listed', 'g1', expect.objectContaining({ sellerId: 'u1', listingId: 'l1', itemName: 'Sword', quantity: 2, pricePerUnit: 100 }));
  });

  it('emits market.bought on a settled purchase', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_market_enabled: true, economy_market_fee_pct: 5 }),
      economy_market_listings: () => supaChain([{ id: 'l1abc', seller_id: 's1', item_name: 'Sword', remaining: 3, price_per_unit: 100 }]),
    }, { economy_market_settle_buy: () => ({ data: { status: 'purchased', item_name: 'Sword', quantity: 1, total_cost: 100, fee: 5 }, error: null }) });
    const mgr = new MarketManager({ id: 'g1' } as any, supabase, {} as any);
    await mgr.buy('u1', 'l1abc', 1, 'req1');
    expect(emit).toHaveBeenCalledWith('market.bought', 'g1', expect.objectContaining({ buyerId: 'u1', sellerId: 's1', listingId: 'l1abc', totalCost: 100 }));
  });

  it('emits market.cancelled when a listing is cancelled', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({
      economy_market_listings: () => supaChain([{ id: 'l1' }]),
    }, {
      economy_market_atomic_cancel: () => ({ data: [{ id: 'l1', item_id: 'it1', item_name: 'Sword', remaining: 2 }], error: null }),
      economy_upsert_inventory: () => ({ data: null, error: null }),
    });
    const mgr = new MarketManager({ id: 'g1' } as any, supabase, {} as any);
    await mgr.cancelListing('u1', 'l1');
    expect(emit).toHaveBeenCalledWith('market.cancelled', 'g1', expect.objectContaining({ sellerId: 'u1', listingId: 'l1', itemName: 'Sword', quantity: 2 }));
  });
});

describe('game-economy-farming', () => {
  const readyPlot = { id: 'p1', plot_index: 0, crop_id: 'c1', planted_at: '2000-01-01T00:00:00Z', watered_at: '2000-01-01T00:00:00Z', fertilized: false, harvested: false };
  const crop = { id: 'c1', name: 'Potato', emoji: '🥔', grow_seconds: 1, wilt_seconds: 100000000, sell_price: 30, seeds_returned: 0, seed_item_id: null };

  it('emits farm.harvested on a successful harvest', async () => {
    const emit = spyEmit();
    let plotCall = 0;
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_farming_enabled: true, economy_farm_grid_size: 9, economy_farming_wilt_enabled: false, economy_fertilizer_time_reduction_pct: 50 }),
      economy_farm_plots: () => { plotCall += 1; return plotCall === 1 ? supaChain([readyPlot]) : supaChain([{ id: 'p1', crop_id: 'c1' }]); },
      economy_crops: () => supaChain([crop]),
      economy_wallets: () => supaChain({ wallet: 30 }),
    }, { economy_add_balance: () => ({ data: null, error: null }) });
    const mgr = new FarmingManager({ id: 'g1' } as any, supabase, {} as any);
    await mgr.harvest('u1');
    expect(emit).toHaveBeenCalledWith('farm.harvested', 'g1', expect.objectContaining({ userId: 'u1', cropCount: 1, earnings: 30 }));
  });

  it('emits farm.payout_failed + writes an owner alert when payout reverts', async () => {
    const emit = spyEmit();
    let alertInserted = false;
    let plotCall = 0;
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_farming_enabled: true, economy_farm_grid_size: 9, economy_farming_wilt_enabled: false, economy_fertilizer_time_reduction_pct: 50 }),
      economy_farm_plots: () => { plotCall += 1; return plotCall === 1 ? supaChain([readyPlot]) : supaChain([{ id: 'p1', crop_id: 'c1' }]); },
      economy_crops: () => supaChain([crop]),
      alerts: () => { alertInserted = true; return supaChain(); },
    }, { economy_add_balance: () => ({ data: null, error: { message: 'boom' } }) });
    const mgr = new FarmingManager({ id: 'g1' } as any, supabase, {} as any);
    await mgr.harvest('u1');
    expect(emit).toHaveBeenCalledWith('farm.payout_failed', 'g1', expect.objectContaining({ userId: 'u1', amount: 30 }));
    expect(alertInserted).toBe(true);
  });
});

describe('game-economy-gathering', () => {
  const lootEntry = { id: 'l1', item_name: 'Rabbit Meat', emoji: '🥩', rarity: 'common', min_qty: 1, max_qty: 1, weight: 40, tool_tier: 0, sell_value: 15, gives_item_id: null };

  it('emits gather.completed on a successful gather', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_gathering_enabled: true, economy_gathering_cooldown_seconds: 300, currency_name: 'Coins', currency_emoji: '🪙' }),
      economy_inventory: () => supaChain([]),
      economy_loot_tables: () => supaChain([lootEntry]),
      economy_wallets: () => supaChain({ wallet: 15 }),
    }, { economy_add_balance: () => ({ data: null, error: null }) });
    const valkey: any = { set: async () => 'OK', pttl: async () => 0 };
    const mgr = new GatheringManager({ id: 'g1' } as any, supabase, valkey);
    await mgr.gather('u1', 'hunt', 'i1');
    expect(emit).toHaveBeenCalledWith('gather.completed', 'g1', expect.objectContaining({ userId: 'u1', sourceType: 'hunt', value: 15 }));
  });

  it('emits gather.payout_failed + writes an owner alert when the credit fails', async () => {
    const emit = spyEmit();
    let alertInserted = false;
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_gathering_enabled: true, economy_gathering_cooldown_seconds: 300, currency_name: 'Coins', currency_emoji: '🪙' }),
      economy_inventory: () => supaChain([]),
      economy_loot_tables: () => supaChain([lootEntry]),
      alerts: () => { alertInserted = true; return supaChain(); },
    }, { economy_add_balance: () => ({ data: null, error: { message: 'boom' } }) });
    const valkey: any = { set: async () => 'OK', pttl: async () => 0 };
    const mgr = new GatheringManager({ id: 'g1' } as any, supabase, valkey);
    await mgr.gather('u1', 'hunt', 'i1');
    expect(emit).toHaveBeenCalledWith('gather.payout_failed', 'g1', expect.objectContaining({ userId: 'u1', sourceType: 'hunt', amount: 15 }));
    expect(alertInserted).toBe(true);
  });
});

describe('game-economy-fishing', () => {
  it('emits fishing.catch when a fish is caught', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({
      economy_fish_catches: () => supaChain({ id: 'fc1' }),
    }, { economy_add_balance: () => ({ data: null, error: null }) });
    const mgr = new FishingManager({ id: 'g1' } as any, supabase, {} as any);
    (mgr as any).speciesCache = [{ id: 's1', name: 'Cod', emoji: '🐟', rarity: 'common', min_weight: 1, max_weight: 2, base_price: 10 }];
    await (mgr as any).rollFishCatch('u1', null);
    expect(emit).toHaveBeenCalledWith('fishing.catch', 'g1', expect.objectContaining({ userId: 'u1', species: 'Cod', paid: true }));
  });

  it('emits fishing.payout_failed when the auto-sell credit fails', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({
      economy_fish_catches: () => supaChain({ id: 'fc1' }),
      alerts: () => supaChain(),
    }, { economy_add_balance: () => ({ data: null, error: { message: 'boom' } }) });
    const mgr = new FishingManager({ id: 'g1' } as any, supabase, {} as any);
    (mgr as any).speciesCache = [{ id: 's1', name: 'Cod', emoji: '🐟', rarity: 'common', min_weight: 1, max_weight: 2, base_price: 10 }];
    await (mgr as any).rollFishCatch('u1', null);
    expect(emit).toHaveBeenCalledWith('fishing.payout_failed', 'g1', expect.objectContaining({ userId: 'u1', species: 'Cod' }));
  });
});

describe('game-economy-heist', () => {
  it('emits heist.settlement_failed + writes an owner alert when retries exhaust', async () => {
    const emit = spyEmit();
    let alertInserted = false;
    const supabase = makeSupabase({ alerts: () => { alertInserted = true; return supaChain(); } });
    const client: any = { channels: { cache: { get: () => undefined } } };
    const mgr = new HeistManager(supabase, client);
    (mgr as any).retryAttempts.set('h1', 5); // at MAX — next attempt exhausts
    (mgr as any).scheduleResolveRetry('g1', 'h1', 'c1');
    expect(emit).toHaveBeenCalledWith('heist.settlement_failed', 'g1', expect.objectContaining({ heistId: 'h1' }));
    await Promise.resolve();
    expect(alertInserted).toBe(true);
  });
});

describe('game-economy-lottery', () => {
  it('emits lottery.drawn when the jackpot is paid to a winner', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({}, {
      lottery_claim_drawing: () => ({ data: [{ id: 'd1' }], error: null }),
      lottery_award_jackpot: () => ({ data: [{ winner_user_id: 'w1', jackpot: 1000, winning_number: 7 }], error: null }),
    });
    const mgr = new LotteryManager(supabase);
    await (mgr as any).drawWinner('g1', { id: 'd1', status: 'active', winner_user_id: 'w1', created_at: new Date().toISOString() });
    expect(emit).toHaveBeenCalledWith('lottery.drawn', 'g1', expect.objectContaining({ drawingId: 'd1', winnerId: 'w1', jackpot: 1000, winningNumber: 7 }));
  });

  it('emits lottery.payout_failed + writes an owner alert on award error', async () => {
    const emit = spyEmit();
    let alertInserted = false;
    const supabase = makeSupabase({
      alerts: () => { alertInserted = true; return supaChain(); },
    }, {
      lottery_claim_drawing: () => ({ data: [{ id: 'd1' }], error: null }),
      lottery_award_jackpot: () => ({ data: null, error: { message: 'boom' } }),
    });
    const mgr = new LotteryManager(supabase);
    await (mgr as any).drawWinner('g1', { id: 'd1', status: 'active', winner_user_id: 'w1', created_at: new Date().toISOString() });
    expect(emit).toHaveBeenCalledWith('lottery.payout_failed', 'g1', expect.objectContaining({ drawingId: 'd1' }));
    expect(alertInserted).toBe(true);
  });
});

describe('game-economy-pets', () => {
  it('emits pet.acquired when a pet is bought', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_pets_enabled: true }),
      economy_pets: () => supaChain(null),
      economy_wallets: () => supaChain({ wallet: 99999 }),
    }, {
      economy_pet_buy_atomic: () => ({
        data: { status: 'purchased', replayed: false },
        error: null,
      }),
    });
    const mgr = new PetsManager(supabase);
    const interaction = makeInteraction({ options: { getString: () => 'hunting', getUser: () => null } });
    await mgr.buyPet(interaction);
    expect(emit).toHaveBeenCalledWith('pet.acquired', 'g1', expect.objectContaining({ userId: 'u1', petType: 'hunting', price: 5000 }));
  });

  it('emits pet.battle_payout_failed + writes an owner alert when the reward credit fails', async () => {
    const emit = spyEmit();
    let alertInserted = false;
    const pet = { name: 'Rex', level: 3, attack: 5, defense: 5, speed: 5, health: 20, status: 'happy' };
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_pets_enabled: true, economy_pet_battle_enabled: true }),
      economy_pets: () => supaChain(pet),
      alerts: () => { alertInserted = true; return supaChain(); },
    }, { economy_add_balance: () => ({ data: null, error: { message: 'boom' } }), economy_pet_add_xp: () => ({ data: null, error: null }) });
    const mgr = new PetsManager(supabase);
    const interaction = makeInteraction({ options: { getString: () => null, getUser: () => ({ id: 'u2' }) } });
    await mgr.battlePet(interaction);
    expect(emit).toHaveBeenCalledWith('pet.battle_payout_failed', 'g1', expect.objectContaining({ reward: expect.any(Number) }));
    expect(alertInserted).toBe(true);
  });
});

describe('game-economy-trivia', () => {
  it('emits trivia.completed when a round ends', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_trivia_base_payout: 50, economy_trivia_streak_multiplier_pct: 10, economy_trivia_cooldown_seconds: 30 }),
    }, { economy_add_balance: () => ({ data: null, error: null }) });
    const valkey: any = { get: async () => null, set: async () => 'OK', ttl: async () => 0 };
    const mgr = new TriviaManager(supabase, valkey);
    const round = {
      question: { question: 'Q', correct: 'A', wrong: ['B'], category: 'x', difficulty: 'easy' },
      answers: new Map([['u1', 0]]),
      correctIndex: 0,
      shuffled: ['A', 'B'],
      guildId: 'g1',
      edit: vi.fn(async () => {}),
      timeout: setTimeout(() => {}, 100000),
    };
    (mgr as any).activeRounds.set('c1', round);
    await (mgr as any).endRound('c1');
    expect(emit).toHaveBeenCalledWith('trivia.completed', 'g1', expect.objectContaining({ channelId: 'c1', winners: 1 }));
  });

  it('emits trivia.payout_failed + writes an owner alert when a winner payout fails', async () => {
    const emit = spyEmit();
    let alertInserted = false;
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_trivia_base_payout: 50, economy_trivia_streak_multiplier_pct: 10, economy_trivia_cooldown_seconds: 30 }),
      alerts: () => { alertInserted = true; return supaChain(); },
    }, { economy_add_balance: () => ({ data: null, error: { message: 'boom' } }) });
    const valkey: any = { get: async () => null, set: async () => 'OK', ttl: async () => 0 };
    const mgr = new TriviaManager(supabase, valkey);
    const round = {
      question: { question: 'Q', correct: 'A', wrong: ['B'], category: 'x', difficulty: 'easy' },
      answers: new Map([['u1', 0]]),
      correctIndex: 0,
      shuffled: ['A', 'B'],
      guildId: 'g1',
      edit: vi.fn(async () => {}),
      timeout: setTimeout(() => {}, 100000),
    };
    (mgr as any).activeRounds.set('c1', round);
    await (mgr as any).endRound('c1');
    expect(emit).toHaveBeenCalledWith('trivia.payout_failed', 'g1', expect.objectContaining({ userId: 'u1' }));
    expect(alertInserted).toBe(true);
  });
});

describe('game-economy-wallet-rewards', () => {
  it('emits economy.reward_claimed on a successful timed-reward claim', async () => {
    const emit = spyEmit();
    const wallet = { guild_id: 'g1', user_id: 'u1', wallet: 1000, bank: 0, bank_max: 10000, passive: false, total_earned: 1000, total_spent: 0 };
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_enabled: true, economy_daily_amount: 500, economy_streak_bonus_pct: 5, economy_log_channel_id: null }),
      economy_streaks: () => supaChain(null),
      economy_wallets: () => supaChain(wallet),
    }, { economy_add_balance: () => ({ data: null, error: null }) });
    const valkey: any = { set: async () => 'OK', get: async () => null };
    const mgr = new EconomyManager({ id: 'g1' } as any, supabase, valkey);
    await mgr.claimTimedReward('u1', 'daily');
    expect(emit).toHaveBeenCalledWith('economy.reward_claimed', 'g1', expect.objectContaining({ userId: 'u1', rewardType: 'daily', amount: 500 }));
  });

  it('emits economy.reward_failed + writes an owner alert when the credit RPC fails', async () => {
    const emit = spyEmit();
    let alertInserted = false;
    const wallet = { guild_id: 'g1', user_id: 'u1', wallet: 1000, bank: 0, bank_max: 10000, passive: false, total_earned: 1000, total_spent: 0 };
    const supabase = makeSupabase({
      guild_config: () => supaChain({ economy_enabled: true, economy_daily_amount: 500, economy_streak_bonus_pct: 5, economy_log_channel_id: null }),
      economy_streaks: () => supaChain(null),
      economy_wallets: () => supaChain(wallet),
      alerts: () => { alertInserted = true; return supaChain(); },
    }, { economy_add_balance: () => ({ data: null, error: { message: 'boom' } }) });
    const valkey: any = { set: async () => 'OK', get: async () => null };
    const mgr = new EconomyManager({ id: 'g1' } as any, supabase, valkey);
    await mgr.claimTimedReward('u1', 'daily');
    expect(emit).toHaveBeenCalledWith('economy.reward_failed', 'g1', expect.objectContaining({ userId: 'u1', rewardType: 'daily', amount: 500 }));
    expect(alertInserted).toBe(true);
  });
});
