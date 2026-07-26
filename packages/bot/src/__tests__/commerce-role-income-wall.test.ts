/**
 * Collection-time commerce wall boundary.
 *
 * Eligibility, cooldowns, replay protection, and wallet mutation live in the
 * database RPC. These tests keep the bot at that atomic boundary: the command
 * sends the frozen Discord-role snapshot once and never re-implements paid
 * provenance with mutable product metadata or local offsets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { handleEconomyCommand } from '../features/economy/commands.js';

const GUILD = 'g1';
const USER = 'u1';

type CollectRpcResult = {
  status: 'credited' | 'cooldown' | 'no_eligible_roles' | 'verification_unavailable';
  amount_cents: number;
  balance_cents: number | null;
  credited_role_ids: string[];
  blocked_role_ids: string[];
  next_available_at: string | null;
};

function collectResult(overrides: Partial<CollectRpcResult> = {}): CollectRpcResult {
  return {
    status: 'credited',
    amount_cents: 125,
    balance_cents: 1_000,
    credited_role_ids: ['role-earned'],
    blocked_role_ids: [],
    next_available_at: null,
    ...overrides,
  };
}

function makeRpcSupabase(response: Promise<unknown> | unknown) {
  const abortSignal = vi.fn(() => Promise.resolve(response));
  return {
    rpc: vi.fn((_name: string, _args: Record<string, unknown>) => ({ abortSignal })),
    abortSignal,
  };
}

function makeManager() {
  return {
    loadConfig: vi.fn().mockResolvedValue({
      economy_enabled: true,
      currency_emoji: '💰',
      currency_name: 'coins',
    }),
    // Legacy split mutations must never be used by collect-income.
    creditWallet: vi.fn(),
    valkey: {
      get: vi.fn(),
      set: vi.fn(),
    },
  };
}

function makeInteraction(
  supabase: unknown,
  heldRoleIds: string[],
  interactionId = '123456789012345678',
) {
  const cache = new Map(heldRoleIds.map((id) => [id, {}]));
  return {
    id: interactionId,
    client: { supabase },
    guildId: GUILD,
    user: { id: USER },
    member: { roles: { cache } },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    options: { getSubcommand: vi.fn().mockReturnValue('collect-income') },
    commandName: 'collect-income',
  };
}

describe('handleCollectIncome — atomic RPC boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defers before work, calls the RPC exactly once, and renders only its credited result', async () => {
    const supabase = makeRpcSupabase({ data: collectResult(), error: null });
    const mgr = makeManager();
    const interaction = makeInteraction(supabase, ['role-earned', 'role-other']);

    await handleEconomyCommand(interaction as never, mgr as never);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      supabase.rpc.mock.invocationCallOrder[0]!,
    );
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('economy_collect_role_income', {
      p_guild_id: GUILD,
      p_user_id: USER,
      p_discord_role_ids: ['role-earned', 'role-other'],
      p_request_id: '123456789012345678',
    });
    expect(supabase.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('Collected **125 coins** from 1 role'),
    });
    expect(mgr.creditWallet).not.toHaveBeenCalled();
    expect(mgr.valkey.get).not.toHaveBeenCalled();
    expect(mgr.valkey.set).not.toHaveBeenCalled();
  });

  it('passes the same Discord snowflake for concurrent replay deliveries', async () => {
    const supabase = makeRpcSupabase({ data: collectResult(), error: null });
    const mgr = makeManager();
    const replayId = '987654321098765432';
    const first = makeInteraction(supabase, ['role-earned'], replayId);
    const replay = makeInteraction(supabase, ['role-earned'], replayId);

    await Promise.all([
      handleEconomyCommand(first as never, mgr as never),
      handleEconomyCommand(replay as never, mgr as never),
    ]);

    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    expect(supabase.rpc.mock.calls.map((call) => call[1].p_request_id)).toEqual([
      replayId,
      replayId,
    ]);
    expect(mgr.creditWallet).not.toHaveBeenCalled();
    expect(mgr.valkey.set).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'database error',
      response: { data: null, error: { message: 'database unavailable' } },
    },
    {
      label: 'malformed response',
      response: { data: { status: 'credited', amount_cents: 999 }, error: null },
    },
    {
      label: 'explicit fail-closed response',
      response: {
        data: collectResult({
          status: 'verification_unavailable',
          amount_cents: 0,
          balance_cents: null,
          credited_role_ids: [],
        }),
        error: null,
      },
    },
  ])('reports verification unavailable on $label without local mutation or success', async ({ response }) => {
    const supabase = makeRpcSupabase(response);
    const mgr = makeManager();
    const interaction = makeInteraction(supabase, ['role-earned']);

    await handleEconomyCommand(interaction as never, mgr as never);

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(mgr.creditWallet).not.toHaveBeenCalled();
    expect(mgr.valkey.get).not.toHaveBeenCalled();
    expect(mgr.valkey.set).not.toHaveBeenCalled();
    const content = String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? '');
    expect(content.toLowerCase()).toContain('verification is temporarily unavailable');
    expect(content).not.toContain('Collected');
  });

  it('aborts a stalled RPC and reports verification unavailable without a success claim', async () => {
    vi.useFakeTimers();
    try {
      const abortSignal = vi.fn((signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
      const supabase = { rpc: vi.fn(() => ({ abortSignal })) };
      const mgr = makeManager();
      const interaction = makeInteraction(supabase, ['role-earned']);

      const pending = handleEconomyCommand(interaction as never, mgr as never);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(supabase.rpc).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(8_000);
      await pending;

      expect((abortSignal.mock.calls[0]?.[0] as AbortSignal).aborted).toBe(true);
      expect(mgr.creditWallet).not.toHaveBeenCalled();
      expect(mgr.valkey.set).not.toHaveBeenCalled();
      const content = String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? '');
      expect(content.toLowerCase()).toContain('verification is temporarily unavailable');
      expect(content).not.toContain('Collected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not expose blocked role IDs or invent purchase evidence', async () => {
    const supabase = makeRpcSupabase({
      data: collectResult({
        status: 'no_eligible_roles',
        amount_cents: 0,
        balance_cents: null,
        credited_role_ids: [],
        blocked_role_ids: ['role-private-provenance'],
      }),
      error: null,
    });
    const interaction = makeInteraction(supabase, ['role-private-provenance']);

    await handleEconomyCommand(interaction as never, makeManager() as never);

    const content = String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? '');
    expect(content.toLowerCase()).toContain('no eligible role income');
    expect(content).not.toContain('role-private-provenance');
    expect(content.toLowerCase()).not.toContain('purchase');
    expect(content.toLowerCase()).not.toContain('paid');
  });

  it('renders cooldown timing only from the RPC response', async () => {
    const nextAvailableAt = '2026-07-11T12:00:00.000Z';
    const supabase = makeRpcSupabase({
      data: collectResult({
        status: 'cooldown',
        amount_cents: 0,
        balance_cents: null,
        credited_role_ids: [],
        next_available_at: nextAvailableAt,
      }),
      error: null,
    });
    const interaction = makeInteraction(supabase, ['role-earned']);

    await handleEconomyCommand(interaction as never, makeManager() as never);

    const content = String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? '');
    expect(content.toLowerCase()).toContain('cooldown');
    expect(content).toContain(`<t:${Math.floor(Date.parse(nextAvailableAt) / 1000)}:R>`);
    expect(content).not.toContain('Collected');
  });
});
