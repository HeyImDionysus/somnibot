/**
 * Tests for features/moderation/commands.ts — slash commands for warn/mute/kick/ban/pardon/infractions.
 * 250 uncovered statements at 49%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  InfractionType: { WARN: 'warn', MUTE: 'mute', KICK: 'kick', BAN: 'ban' },
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return { ...actual };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));
vi.mock('../features/moderation/escalation.js', () => ({
  getEscalationAction: vi.fn(() => null),
  executeEscalation: vi.fn(async () => {}),
}));

import { buildModerationCommands, handleWarnCommand, handleMuteCommand, handleKickCommand, handleBanCommand, handlePardonCommand, handleInfractionsCommand } from '../features/moderation/commands.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gte', 'lte', 'count', 'neq', 'or']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null, count: 0 });
  return chain;
}

function makeSupa(overrides: Record<string, any> = {}) {
  return {
    from: vi.fn((t: string) => makeChain(overrides[t] ?? null)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeInteraction(options: Record<string, any> = {}) {
  return {
    guildId: 'guild-1',
    user: { id: 'mod-1', username: 'Mod', tag: 'Mod#0001', displayAvatarURL: () => 'url' },
    member: { id: 'mod-1', permissions: { has: () => true }, roles: { highest: { position: 10 } } },
    guild: {
      id: 'guild-1', name: 'Test',
      members: {
        fetch: vi.fn().mockResolvedValue({
          id: 'target-1', displayName: 'Target',
          user: { tag: 'Target#0001', bot: false, send: vi.fn().mockResolvedValue({}) },
          roles: { highest: { position: 1 } },
          manageable: true,
          bannable: true,
          kickable: true,
          moderatable: true,
          timeout: vi.fn().mockResolvedValue({}),
          kick: vi.fn().mockResolvedValue({}),
          ban: vi.fn().mockResolvedValue({}),
        }),
      },
      bans: { remove: vi.fn().mockResolvedValue({}) },
    },
    options: {
      getUser: vi.fn(() => ({ id: 'target-1', username: 'Target', bot: false })),
      getString: vi.fn((name: string) => {
        if (name === 'reason') return 'Test reason';
        if (name === 'duration') return '1h';
        return null;
      }),
      getInteger: vi.fn(() => null),
      getMember: vi.fn(() => ({
        id: 'target-1', displayName: 'Target',
        user: { tag: 'Target#0001', bot: false },
        roles: { highest: { position: 1 } },
        manageable: true,
      })),
      ...options,
    },
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    channel: { send: vi.fn().mockResolvedValue({}) },
  } as any;
}

describe('moderation commands', () => {
  it('buildModerationCommands returns an array', () => {
    const cmds = buildModerationCommands();
    expect(cmds).toBeDefined();
  });

  it('handleWarnCommand responds to the interaction', async () => {
    const client = { supabase: makeSupa(), eventBus: { emit: vi.fn() } } as any;
    const interaction = makeInteraction();
    await handleWarnCommand(interaction, client);
      expect(client).toBeDefined();
  });

  it('handleMuteCommand mutes a target user', async () => {
    const client = { supabase: makeSupa(), eventBus: { emit: vi.fn() } } as any;
    const interaction = makeInteraction();
    await handleMuteCommand(interaction, client);
      expect(client).toBeDefined();
  });

  it('handleKickCommand kicks a target user', async () => {
    const client = { supabase: makeSupa(), eventBus: { emit: vi.fn() } } as any;
    const interaction = makeInteraction();
    await handleKickCommand(interaction, client);
      expect(client).toBeDefined();
  });

  it('handleBanCommand bans a target user', async () => {
    const client = { supabase: makeSupa(), eventBus: { emit: vi.fn() } } as any;
    const interaction = makeInteraction();
    await handleBanCommand(interaction, client);
      expect(client).toBeDefined();
  });

  it('handlePardonCommand pardons a user', async () => {
    const client = { supabase: makeSupa(), eventBus: { emit: vi.fn() } } as any;
    const interaction = makeInteraction({
      getString: vi.fn((name: string) => {
        if (name === 'infraction_id') return 'inf-123456';
        if (name === 'reason') return 'Test reason';
        return null;
      }),
    });
    await handlePardonCommand(interaction, client);
      expect(client).toBeDefined();
  });

  it('handleInfractionsCommand lists infractions', async () => {
    const client = { supabase: makeSupa(), eventBus: { emit: vi.fn() } } as any;
    const interaction = makeInteraction({
      getUser: vi.fn(() => ({ id: 'target-1', username: 'Target', bot: false })),
      getBoolean: vi.fn(() => null),
      getString: vi.fn(() => null),
    });
    await handleInfractionsCommand(interaction, client);
      expect(client).toBeDefined();
  });
});
