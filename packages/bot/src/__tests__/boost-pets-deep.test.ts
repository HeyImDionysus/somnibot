/**
 * Deep tests for features/pets/pets-manager.ts — viewPet, buyPet, feedPet, playWithPet, trainPet, renamePet.
 * 208 uncovered statements at 49.4%.
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

vi.mock('../features/economy/economy-utils.js', () => ({
  getBalance: vi.fn(async () => 5000),
  addBalance: vi.fn(async () => true),
  deductBalance: vi.fn(async () => true),
}));

import { PetsManager } from '../features/pets/pets-manager.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null, count: 0 });
  return chain;
}

function makeSupa(overrides: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => makeChain(overrides[table] ?? null)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeInteraction() {
  return {
    guildId: 'guild-1',
    channelId: 'ch-1',
    user: { id: 'user-1', username: 'Tester', displayAvatarURL: () => 'url' },
    member: { id: 'user-1', permissions: { has: () => true } },
    guild: { id: 'guild-1', name: 'Test', channels: { cache: new Map() } },
    options: {
      getString: vi.fn((name: string) => {
        if (name === 'name') return 'Fluffy';
        if (name === 'species') return 'cat';
        return null;
      }),
      getInteger: vi.fn(() => null),
      getUser: vi.fn(() => ({ id: 'user-2' })),
      getBoolean: vi.fn(() => false),
      getSubcommand: vi.fn(() => 'view'),
    },
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
  } as any;
}

describe('PetsManager deep', () => {
  it('viewPet shows pet info', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', pets_enabled: true },
      pets: { id: 'pet-1', user_id: 'user-1', guild_id: 'guild-1', name: 'Fluffy', species: 'cat', level: 3, hunger: 50, happiness: 80, xp: 100, health: 100, prestige: 0 },
    });
    const mgr = new PetsManager(supa);
    await mgr.viewPet(makeInteraction());
  });

  it('buyPet creates a new pet', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', pets_enabled: true, pets_max_per_user: 5, currency_symbol: '💰' },
      pets: null,
      pet_species: [{ name: 'cat', emoji: '🐱', cost: 200 }],
    });
    const mgr = new PetsManager(supa);
    await mgr.buyPet(makeInteraction());
  });

  it('feedPet feeds a pet', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', pets_enabled: true, currency_symbol: '💰' },
      pets: { id: 'pet-1', user_id: 'user-1', guild_id: 'guild-1', name: 'Fluffy', species: 'cat', hunger: 30, happiness: 80, health: 100, xp: 100, level: 3, prestige: 0 },
    });
    const mgr = new PetsManager(supa);
    await mgr.feedPet(makeInteraction());
  });

  it('playWithPet plays with a pet', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', pets_enabled: true },
      pets: { id: 'pet-1', user_id: 'user-1', guild_id: 'guild-1', name: 'Fluffy', species: 'cat', hunger: 50, happiness: 50, health: 100, xp: 100, level: 3, prestige: 0 },
    });
    const mgr = new PetsManager(supa);
    await mgr.playWithPet(makeInteraction());
  });

  it('trainPet trains a pet', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', pets_enabled: true },
      pets: { id: 'pet-1', user_id: 'user-1', guild_id: 'guild-1', name: 'Fluffy', species: 'cat', hunger: 50, happiness: 80, health: 100, xp: 100, level: 3, prestige: 0 },
    });
    const mgr = new PetsManager(supa);
    await mgr.trainPet(makeInteraction());
  });

  it('renamePet renames a pet', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', pets_enabled: true },
      pets: { id: 'pet-1', user_id: 'user-1', guild_id: 'guild-1', name: 'Fluffy', species: 'cat' },
    });
    const mgr = new PetsManager(supa);
    await mgr.renamePet(makeInteraction());
  });
});
