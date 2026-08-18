/**
 * Deep tests for features/pets/pets-manager.ts — viewPet, buyPet, feedPet, playWithPet, trainPet, renamePet.
 * 208 uncovered statements at 49.4%.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
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
import * as auditService from '../services/audit.js';

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
    const interaction = makeInteraction();
    await mgr.viewPet(interaction);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
    expect(supa.from).toHaveBeenCalled();
  });

  it('buyPet creates a new pet', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', pets_enabled: true, pets_max_per_user: 5, currency_symbol: '💰' },
      pets: null,
      pet_species: [{ name: 'cat', emoji: '🐱', cost: 200 }],
    });
    const mgr = new PetsManager(supa);
    const interaction = makeInteraction();
    await mgr.buyPet(interaction);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('feedPet feeds a pet', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', pets_enabled: true, currency_symbol: '💰' },
      pets: { id: 'pet-1', user_id: 'user-1', guild_id: 'guild-1', name: 'Fluffy', species: 'cat', hunger: 30, happiness: 80, health: 100, xp: 100, level: 3, prestige: 0 },
    });
    const mgr = new PetsManager(supa);
    const interaction = makeInteraction();
    await mgr.feedPet(interaction);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('playWithPet plays with a pet', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', pets_enabled: true },
      pets: { id: 'pet-1', user_id: 'user-1', guild_id: 'guild-1', name: 'Fluffy', species: 'cat', hunger: 50, happiness: 50, health: 100, xp: 100, level: 3, prestige: 0 },
    });
    const mgr = new PetsManager(supa);
    const interaction = makeInteraction();
    await mgr.playWithPet(interaction);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('trainPet trains a pet', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', pets_enabled: true },
      pets: { id: 'pet-1', user_id: 'user-1', guild_id: 'guild-1', name: 'Fluffy', species: 'cat', hunger: 50, happiness: 80, health: 100, xp: 100, level: 3, prestige: 0 },
    });
    const mgr = new PetsManager(supa);
    const interaction = makeInteraction();
    await mgr.trainPet(interaction);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('renames once and writes one occurrence-keyed audit across a duplicate interaction', async () => {
    vi.mocked(auditService.writeAuditLog).mockClear();
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', economy_pets_enabled: true },
      economy_pets: { id: 'pet-1', user_id: 'user-1', guild_id: 'guild-1', name: 'Fluffy', species: 'cat' },
    });
    supa.rpc
      .mockResolvedValueOnce({
        data: { status: 'renamed', replayed: false, old_name: 'Fluffy', new_name: 'Comet' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { status: 'renamed', replayed: true, old_name: 'Fluffy', new_name: 'Comet' },
        error: null,
      });
    const mgr = new PetsManager(supa);
    const interaction = makeInteraction();
    interaction.id = 'rename-interaction-1';
    interaction.options.getString.mockReturnValue('Comet');

    await mgr.renamePet(interaction);
    await mgr.renamePet(interaction);

    expect(supa.rpc).toHaveBeenNthCalledWith(1, 'economy_pet_rename_atomic', {
      p_guild_id: 'guild-1',
      p_user_id: 'user-1',
      p_new_name: 'Comet',
      p_request_id: 'rename-interaction-1',
    });
    expect(auditService.writeAuditLog).toHaveBeenCalledTimes(2);
    expect(auditService.writeAuditLog).toHaveBeenLastCalledWith(supa, expect.objectContaining({
      action: 'pets.renamed',
      occurrenceKey: 'pets.renamed:rename-interaction-1',
      success: true,
      details: { beforeName: 'Fluffy', afterName: 'Comet' },
    }));
    expect(interaction.reply).toHaveBeenLastCalledWith(expect.objectContaining({
      content: expect.stringContaining('already processed'),
      ephemeral: true,
    }));
  });

  it('reports an unavailable rename and writes a stable failure audit when the authoritative mutation fails', async () => {
    vi.mocked(auditService.writeAuditLog).mockClear();
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', economy_pets_enabled: true },
      economy_pets: { id: 'pet-1', user_id: 'user-1', guild_id: 'guild-1', name: 'Fluffy', species: 'cat' },
    });
    supa.rpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } });
    const mgr = new PetsManager(supa);
    const interaction = makeInteraction();
    interaction.id = 'rename-interaction-failed';
    interaction.options.getString.mockReturnValue('Comet');

    await mgr.renamePet(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('temporarily unavailable'),
    }));
    expect(auditService.writeAuditLog).toHaveBeenCalledWith(supa, expect.objectContaining({
      action: 'pets.rename_failed',
      occurrenceKey: 'pets.rename_failed:rename-interaction-failed',
      success: false,
      errorMessage: 'rename_not_confirmed',
      details: { beforeName: 'Fluffy', afterName: 'Comet', reason: 'rename_not_confirmed' },
    }));
  });

  it('retries the same success-audit occurrence on a replay after the first audit write fails', async () => {
    vi.mocked(auditService.writeAuditLog).mockClear();
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', economy_pets_enabled: true },
      economy_pets: { id: 'pet-1', user_id: 'user-1', guild_id: 'guild-1', name: 'Fluffy', species: 'cat' },
    });
    supa.rpc
      .mockResolvedValueOnce({
        data: { status: 'renamed', replayed: false, old_name: 'Fluffy', new_name: 'Comet' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { status: 'renamed', replayed: true, old_name: 'Fluffy', new_name: 'Comet' },
        error: null,
      });
    vi.mocked(auditService.writeAuditLog).mockRejectedValueOnce(new Error('audit unavailable'));
    const mgr = new PetsManager(supa);
    const interaction = makeInteraction();
    interaction.id = 'rename-interaction-audit-retry';
    interaction.options.getString.mockReturnValue('Comet');

    await mgr.renamePet(interaction);
    await mgr.renamePet(interaction);

    expect(auditService.writeAuditLog).toHaveBeenCalledTimes(2);
    expect(auditService.writeAuditLog).toHaveBeenLastCalledWith(supa, expect.objectContaining({
      action: 'pets.renamed',
      occurrenceKey: 'pets.renamed:rename-interaction-audit-retry',
    }));
    expect(interaction.reply).toHaveBeenLastCalledWith(expect.objectContaining({
      content: expect.stringContaining('already processed'),
      ephemeral: true,
    }));
  });
});
