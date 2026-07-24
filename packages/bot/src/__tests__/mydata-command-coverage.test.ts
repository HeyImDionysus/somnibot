/**
 * account/mydata-command — coverage tests (218 lines)
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
      setTitle: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      setColor: vi.fn().mockReturnThis(),
      setFooter: vi.fn().mockReturnThis(),
      setTimestamp: vi.fn().mockReturnThis(),
    };
  }),
  AttachmentBuilder: vi.fn().mockImplementation(function (_buf: any, opts: any) {
    return {
      name: opts?.name,
    };
  }),
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { buildMyDataCommand, handleMyDataCommand } from '../features/account/mydata-command.js';

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'maybeSingle', 'single']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeClient(overrides: any = {}) {
  return {
    supabase: {
      from: vi.fn().mockReturnValue(chainBuilder({ data: [], error: null })),
      ...overrides,
    },
  };
}

function makeInteraction(overrides: any = {}) {
  return {
    client: makeClient(),
    user: {
      id: 'u1',
      createDM: vi.fn().mockResolvedValue({ send: vi.fn().mockResolvedValue(undefined) }),
      ...overrides.user,
    },
    guild: { name: 'Test Guild' },
    guildId: 'g1',
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('buildMyDataCommand', () => {
  it('builds mydata command', () => {
    const cmd = buildMyDataCommand();
    expect(cmd).toBeDefined();
  });
});

describe('handleMyDataCommand', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('exports data and DMs it', async () => {
    const int = makeInteraction();
    await handleMyDataCommand(int as any);
    expect(int.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(int.user.createDM).toHaveBeenCalled();
    expect(int.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('DMs'),
    }));
  });

  it('falls back to ephemeral reply when DMs disabled', async () => {
    const int = makeInteraction({
      user: {
        id: 'u1',
        createDM: vi.fn().mockRejectedValue(new Error('Cannot DM')),
      },
    });
    await handleMyDataCommand(int as any);
    expect(int.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("couldn't DM"),
    }));
  });

  it('handles DB error gracefully', async () => {
    const int = makeInteraction();
    // Make supabase.from throw
    int.client.supabase.from = vi.fn().mockImplementation(() => {
      throw new Error('DB down');
    });
    await handleMyDataCommand(int as any);
    expect(int.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('went wrong'),
    }));
  });

  it('collects data from all 18 tables', async () => {
    const fromCalls: string[] = [];
    const int = makeInteraction();
    int.client.supabase.from = vi.fn().mockImplementation((table: string) => {
      fromCalls.push(table);
      return chainBuilder({ data: table.includes('wallets') ? { wallet: 100 } : [], error: null });
    });
    await handleMyDataCommand(int as any);
    // Should query at least 18 tables
    expect(fromCalls.length).toBeGreaterThanOrEqual(18);
    expect(fromCalls).toContain('economy_wallets');
    expect(fromCalls).toContain('member_levels');
    expect(fromCalls).toContain('infractions');
    expect(fromCalls).toContain('tickets');
    expect(fromCalls).toContain('poll_votes');
  });
});

describe('handleMyDataCommand — infractions column', () => {
  it('queries infractions by member_id (guards the 42703 user_id regression)', async () => {
    const eqCalls: Array<[string, any]> = [];
    const chain: any = {};
    for (const m of ['select', 'order', 'limit', 'maybeSingle', 'single']) chain[m] = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: any) => { eqCalls.push([col, val]); return chain; });
    chain.then = (res: any) => Promise.resolve({ data: [], error: null }).then(res);
    const client = { supabase: { from: vi.fn(() => chain) } };
    const interaction = makeInteraction({ client });
    await handleMyDataCommand(interaction as any);
    // member_id is used ONLY by the infractions query in this flow, so its
    // presence proves the export no longer selects the non-existent user_id column.
    expect(eqCalls).toContainEqual(['member_id', 'u1']);
  });
});
