/**
 * trivia_payout_retry action handler — X2/39 (money-loss dead letter).
 *
 * TriviaManager queues 'trivia_payout_retry' when a winner's credit fails,
 * but NO handler existed in ACTION_HANDLERS: every retry burned its budget on
 * "Unknown action" and dead-lettered — the owed winner was never paid. These
 * tests pin the registration AND the idempotent-replay contract: the retry
 * calls economy_add_balance with the SAME key the primary payout used
 * (trivia:<roundId>:<userId>), so a replay after a partial success is a no-op
 * in the RPC instead of a double payout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; }
    addFields() { return this; } setAuthor() { return this; } setImage() { return this; }
  },
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
  PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n, ManageRoles: 8n },
  PermissionsBitField: class { static Flags = { ViewChannel: 1n }; },
  ContainerBuilder: class {
    setAccentColor() { return this; }
    addTextDisplayComponents() { return this; }
    addSeparatorComponents() { return this; }
  },
  SectionBuilder: class {
    addTextDisplayComponents() { return this; }
    setButtonAccessory() { return this; }
  },
  SeparatorBuilder: class { setSpacing() { return this; } },
  SeparatorSpacingSize: { Small: 1, Large: 2 },
  TextDisplayBuilder: class { setContent() { return this; } },
}));

// Mock the heavyweight modules action-queue imports (same set as
// boost-action-queue.test.ts) so importing it stays a unit test.
vi.mock('../services/guild-snapshot.js', () => ({ writeGuildSnapshot: vi.fn(async () => {}) }));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../services/commerce-fulfillment.js', () => ({
  CommerceFulfillmentService: class { fulfill = vi.fn(async () => ({ success: true, errors: [] })); },
  RECEIPT_DELIVERY_ACTION: 'deliver_receipt',
  classifyDeliveryError: vi.fn(() => 'transient'),
  writeReceiptDeliveryAlert: vi.fn(async () => {}),
}));
vi.mock('../services/event-bus.js', () => {
  const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { eventBus: bus, PlatformEventBus: class { emit = vi.fn(); on = vi.fn(); off = vi.fn(); } };
});
vi.mock('../services/reconciliation.js', () => ({ runReconciliation: vi.fn(async () => {}) }));

import { ACTION_HANDLERS } from '../services/action-queue.js';
import { clearAlertChannelCache } from '../services/alert-service.js';

// ── Fakes ────────────────────────────────────────────────────

function makeSupa(rpcError: { message: string } | null = null) {
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
  const alertUpdates: any[] = [];
  const supa = {
    rpc: vi.fn(async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push([fn, params]);
      return { data: null, error: rpcError };
    }),
    from: vi.fn((table: string) => {
      if (table === 'guild_config') {
        const cfg: any = {
          select: vi.fn(() => cfg),
          eq: vi.fn(() => cfg),
          maybeSingle: vi.fn(async () => ({ data: { alert_channel_id: null }, error: null })),
        };
        return cfg;
      }
      const chain: any = {
        update: vi.fn((patch: any) => { alertUpdates.push(patch); return chain; }),
        eq: vi.fn(() => chain),
        contains: vi.fn(() => chain),
        select: vi.fn(async () => ({ data: [{ id: 'a1' }], error: null })),
        insert: vi.fn(async () => ({ error: null })),
      };
      return chain;
    }),
  } as any;
  return { supa, rpcCalls, alertUpdates };
}

const guild = { id: 'g1', channels: { cache: new Map() } } as any;
const ctx = { actionId: 'aq-1', claimToken: 'tok-1' };

beforeEach(() => {
  clearAlertChannelCache();
});

// ── Tests ────────────────────────────────────────────────────

describe('trivia_payout_retry handler', () => {
  it('is REGISTERED in ACTION_HANDLERS (the dead letter was a queued action with no handler)', () => {
    expect(typeof ACTION_HANDLERS.trivia_payout_retry).toBe('function');
  });

  it('pays the owed winner via the keyed RPC (same key as the primary payout)', async () => {
    const { supa, rpcCalls } = makeSupa();
    const result = await ACTION_HANDLERS.trivia_payout_retry(guild, supa, {
      user_id: 'u1',
      amount: 150,
      round_id: 'round-abc',
    }, ctx);

    expect(result.success).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0][0]).toBe('economy_add_balance');
    expect(rpcCalls[0][1]).toEqual({
      p_guild_id: 'g1',
      p_user_id: 'u1',
      p_amount: 150,
      p_idempotency_key: 'trivia:round-abc:u1',
    });
  });

  it('replay is idempotent: a second run issues the IDENTICAL key so the RPC dedupes (no double pay)', async () => {
    const { supa, rpcCalls } = makeSupa();
    const payload = { user_id: 'u1', amount: 150, round_id: 'round-abc' };

    const first = await ACTION_HANDLERS.trivia_payout_retry(guild, supa, payload, ctx);
    const second = await ACTION_HANDLERS.trivia_payout_retry(guild, supa, payload, ctx);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    // The stability of this key is the entire replay fence: the keyed
    // economy_add_balance returns the prior result on the second call.
    expect(rpcCalls[0][1].p_idempotency_key).toBe('trivia:round-abc:u1');
    expect(rpcCalls[1][1].p_idempotency_key).toBe('trivia:round-abc:u1');
  });

  it('resolves the trivia_payout_failed alert after a successful retry (#51 recovery)', async () => {
    const { supa, alertUpdates } = makeSupa();
    await ACTION_HANDLERS.trivia_payout_retry(guild, supa, {
      user_id: 'u1',
      amount: 150,
      round_id: 'round-abc',
    }, ctx);
    expect(alertUpdates).toHaveLength(1);
    expect(alertUpdates[0]).toMatchObject({ resolved: true });
  });

  it('retries legacy rows without a round_id unkeyed (pre-roundId queue rows still pay out)', async () => {
    const { supa, rpcCalls } = makeSupa();
    const result = await ACTION_HANDLERS.trivia_payout_retry(guild, supa, {
      user_id: 'u1',
      amount: 75,
    }, ctx);

    expect(result.success).toBe(true);
    expect(rpcCalls[0][1]).toEqual({ p_guild_id: 'g1', p_user_id: 'u1', p_amount: 75 });
    expect('p_idempotency_key' in rpcCalls[0][1]).toBe(false);
  });

  it('legacy rows (no round_id) never auto-resolve alerts — a {user_id}-only match could close a DIFFERENT round', async () => {
    const { supa, alertUpdates } = makeSupa();
    const result = await ACTION_HANDLERS.trivia_payout_retry(guild, supa, {
      user_id: 'u1',
      amount: 75,
    }, ctx);

    expect(result.success).toBe(true);
    // The payout went through, but the still-owed alert for round A must not
    // be closed by paying legacy round B's row for the same user — the owner
    // clears any stale alert from the dashboard instead.
    expect(alertUpdates).toHaveLength(0);
  });

  it('rejects malformed payloads as non-retryable (no budget burn on garbage)', async () => {
    const { supa, rpcCalls } = makeSupa();

    const noUser = await ACTION_HANDLERS.trivia_payout_retry(guild, supa, { amount: 100 }, ctx);
    expect(noUser.success).toBe(false);
    expect(noUser.retryable).toBe(false);

    const badAmount = await ACTION_HANDLERS.trivia_payout_retry(guild, supa, {
      user_id: 'u1',
      amount: -5,
    }, ctx);
    expect(badAmount.success).toBe(false);
    expect(badAmount.retryable).toBe(false);

    expect(rpcCalls).toHaveLength(0);
  });

  it('surfaces an RPC failure as a retryable handler failure (retry budget applies)', async () => {
    const { supa, alertUpdates } = makeSupa({ message: 'db down' });
    const result = await ACTION_HANDLERS.trivia_payout_retry(guild, supa, {
      user_id: 'u1',
      amount: 150,
      round_id: 'round-abc',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('db down');
    expect(result.retryable).not.toBe(false);
    // No recovery resolve on a failed retry.
    expect(alertUpdates).toHaveLength(0);
  });
});
