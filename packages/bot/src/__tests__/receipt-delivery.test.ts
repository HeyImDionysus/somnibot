/**
 * Tests for the `deliver_receipt` action — persistent re-delivery of a paid
 * customer's receipt/license-key DM through bot_action_queue.
 *
 * Defect: receipt delivery failures used to be swallowed as "non-fatal" with
 * no retry and no operator-visible record, so a transient Discord outage
 * could silently drop a paid customer's license key.
 *
 * Covers:
 * - successful delivery → action completed, no DLQ/alert noise
 * - transient failure → retried with the queue's exponential backoff
 * - permanent failure (DMs disabled) → no retry burn, dead-letter + alert
 * - exhausted retries → dead-letter + operator alert
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245 },
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock('../services/guild-snapshot.js', () => ({
  writeGuildSnapshot: vi.fn(async () => {}),
}));

vi.mock('../sync/repair-actions.js', () => ({
  repairDriftItem: vi.fn(async () => ({ success: true })),
  acceptDriftItem: vi.fn(async () => ({ success: true })),
  ignoreDriftItem: vi.fn(async () => ({ success: true })),
  clearAllDrift: vi.fn(async () => {}),
}));

const { mockDeliverReceiptDM } = vi.hoisted(() => ({
  mockDeliverReceiptDM: vi.fn(async () => {}),
}));

vi.mock('../features/commerce/receipt-builder.js', () => ({
  sendReceiptDM: vi.fn(async () => true),
  deliverReceiptDM: mockDeliverReceiptDM,
}));

import { startActionQueueListener } from '../services/action-queue.js';

// ── Mocks ──────────────────────────────────────────────────

/**
 * Recording Supabase mock: captures inserts per table and status updates on
 * bot_action_queue. `retryCount` controls what the pre-retry
 * select('retry_count') lookup returns. `staleFailed`/`staleRow` simulate
 * bot_action_queue_recover_stale returning crash-exhausted rows and the
 * follow-up full-row lookup used for DLQ + alert writes.
 */
function makeSupa(
  pendingActions: any[] = [],
  opts: {
    retryCount?: number;
    staleFailed?: Array<{ id: string; action: string; was_failed: boolean }>;
    staleRow?: Record<string, unknown> | null;
  } = {},
) {
  const inserts: Record<string, any[]> = {};
  const queueUpdates: Record<string, unknown>[] = [];
  let pendingReturned = false;

  const makeChain = () => {
    const chain: any = {};
    for (const m of ['select', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'order', 'limit']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    chain.then = (resolve: Function) => resolve({ data: null, error: null });
    return chain;
  };

  const supa: any = {
    from: vi.fn((table: string) => {
      const chain = makeChain();
      chain.insert = vi.fn((row: Record<string, unknown>) => {
        (inserts[table] ??= []).push(row);
        return chain;
      });
      if (table === 'bot_action_queue') {
        chain.select = vi.fn((cols?: string) => {
          const inner = makeChain();
          if (cols === 'retry_count') {
            inner.maybeSingle = vi.fn().mockResolvedValue({
              data: { retry_count: opts.retryCount ?? 0 },
              error: null,
            });
          }
          if (cols === 'action, payload, error_message, retry_count') {
            inner.maybeSingle = vi.fn().mockResolvedValue({
              data: opts.staleRow ?? null,
              error: null,
            });
          }
          inner.then = (resolve: Function) => {
            if (!pendingReturned) {
              pendingReturned = true;
              return resolve({ data: pendingActions, error: null });
            }
            return resolve({ data: [], error: null });
          };
          return inner;
        });
        chain.update = vi.fn((row: Record<string, unknown>) => {
          queueUpdates.push(row);
          return chain;
        });
      }
      return chain;
    }),
    rpc: vi.fn(async (name: string) => {
      if (name === 'bot_action_queue_recover_stale') {
        return { data: opts.staleFailed ?? [], error: null };
      }
      if (name === 'bot_action_queue_claim') return { data: [{ id: 'claimed' }], error: null };
      return { data: null, error: null };
    }),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: Function) => { cb?.('SUBSCRIBED'); return 'subscribed'; }),
    })),
  };
  supa.__inserts = inserts;
  supa.__queueUpdates = queueUpdates;
  return supa;
}

function makeGuild() {
  return {
    id: 'guild-1',
    name: 'Test Guild',
    client: { users: { fetch: vi.fn().mockResolvedValue({ id: 'user-1' }) } },
    roles: { cache: new Map() },
    channels: { cache: new Map() },
    members: { cache: new Map(), fetch: vi.fn() },
  } as any;
}

function deliveryAction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'act-deliver-1',
    guild_id: 'guild-1',
    action: 'deliver_receipt',
    status: 'pending',
    payload: {
      guild_id: 'guild-1',
      discord_id: 'user-1',
      order_id: 'order-1',
      order_number: 'ORD-001',
      product_name: 'VIP Pass',
      amount_cents: 999,
      currency: 'USD',
      license_key_plaintext: 'SMNI-AAAA-BBBB-CCCC-DDDD',
    },
    created_at: new Date().toISOString(),
    retry_count: 0,
    ...overrides,
  };
}

function permanentDmError() {
  // discord.js DiscordAPIError shape: 50007 = Cannot send messages to this user
  return Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
}

afterEach(() => {
  vi.clearAllMocks();
  mockDeliverReceiptDM.mockReset();
  mockDeliverReceiptDM.mockImplementation(async () => {});
});

// ── Tests ──────────────────────────────────────────────────

describe('deliver_receipt action', () => {
  it('delivers the receipt DM and marks the action completed', async () => {
    const guild = makeGuild();
    const supa = makeSupa([deliveryAction()]);

    await startActionQueueListener(guild, supa);

    expect(guild.client.users.fetch).toHaveBeenCalledWith('user-1');
    expect(mockDeliverReceiptDM).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({
        orderNumber: 'ORD-001',
        productName: 'VIP Pass',
        licenseKey: 'SMNI-AAAA-BBBB-CCCC-DDDD',
      }),
    );
    expect(supa.__queueUpdates).toContainEqual(
      expect.objectContaining({ status: 'completed' }),
    );
    // No failure artifacts on the happy path
    expect(supa.__inserts['action_queue_dlq']).toBeUndefined();
    expect(supa.__inserts['alerts']).toBeUndefined();
  });

  it('retries transient delivery failures with exponential backoff', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mockDeliverReceiptDM.mockRejectedValue(new Error('503 Service Unavailable'));

    const guild = makeGuild();
    const supa = makeSupa([deliveryAction()]);

    await startActionQueueListener(guild, supa);

    // Re-queued as pending with retry_count bumped, retry scheduled at 30s
    expect(supa.__queueUpdates).toContainEqual(
      expect.objectContaining({ status: 'pending', retry_count: 1 }),
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    // Not dead-lettered yet — retries still available
    expect(supa.__inserts['action_queue_dlq']).toBeUndefined();
    expect(supa.__inserts['alerts']).toBeUndefined();

    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('classifies DMs-disabled as permanent: no retry burn, dead-letter + alert', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mockDeliverReceiptDM.mockRejectedValue(permanentDmError());

    const guild = makeGuild();
    const supa = makeSupa([deliveryAction()]);

    await startActionQueueListener(guild, supa);

    // No retry scheduled — retrying a DMs-disabled user can never succeed
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(supa.__queueUpdates).not.toContainEqual(
      expect.objectContaining({ status: 'pending' }),
    );
    expect(supa.__queueUpdates).toContainEqual(
      expect.objectContaining({ status: 'failed' }),
    );

    // Dead-lettered for manual handling from the dashboard
    expect(supa.__inserts['action_queue_dlq']).toContainEqual(
      expect.objectContaining({
        guild_id: 'guild-1',
        action: 'deliver_receipt',
        original_id: 'act-deliver-1',
      }),
    );

    // Operator alert with the actionable alternative (portal pickup / manual contact)
    const alerts = supa.__inserts['alerts'];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      guild_id: 'guild-1',
      alert_type: 'receipt_delivery_failed',
      severity: 'critical',
    });
    expect(alerts[0].metadata).toMatchObject({
      kind: 'permanent',
      orderNumber: 'ORD-001',
    });

    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('dead-letters + alerts after exhausting transient retries', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mockDeliverReceiptDM.mockRejectedValue(new Error('503 Service Unavailable'));

    const guild = makeGuild();
    // retry_count = 3 in DB → this failure is attempt 4, past the retry budget
    const supa = makeSupa([deliveryAction({ retry_count: 3 })], { retryCount: 3 });

    await startActionQueueListener(guild, supa);

    // Budget exhausted — no further retry
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(supa.__queueUpdates).toContainEqual(
      expect.objectContaining({ status: 'failed' }),
    );

    expect(supa.__inserts['action_queue_dlq']).toContainEqual(
      expect.objectContaining({
        action: 'deliver_receipt',
        original_id: 'act-deliver-1',
        retry_count: 4,
      }),
    );

    const alerts = supa.__inserts['alerts'];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      alert_type: 'receipt_delivery_failed',
      severity: 'critical',
    });
    expect(alerts[0].metadata).toMatchObject({
      kind: 'transient',
      attempts: 4,
      orderNumber: 'ORD-001',
    });

    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('alerts when a deliver_receipt row exhausts retries via stale crash recovery', async () => {
    // Exhaustion has a second path: the bot repeatedly crashed mid-delivery,
    // so bot_action_queue_recover_stale (not the in-process retry loop)
    // flipped the row to failed. That path must ALSO dead-letter + alert —
    // a paid customer's license key must never disappear silently.
    const guild = makeGuild();
    const supa = makeSupa([], {
      staleFailed: [{ id: 'act-stale-1', action: 'deliver_receipt', was_failed: true }],
      staleRow: {
        action: 'deliver_receipt',
        payload: { discord_id: 'user-1', order_number: 'ORD-001', product_name: 'VIP Pass' },
        error_message: 'Stale processing recovery: retry budget exhausted',
        retry_count: 5,
      },
    });

    await startActionQueueListener(guild, supa);

    expect(supa.__inserts['action_queue_dlq']).toContainEqual(
      expect.objectContaining({ action: 'deliver_receipt', original_id: 'act-stale-1' }),
    );

    const alerts = supa.__inserts['alerts'];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      guild_id: 'guild-1',
      alert_type: 'receipt_delivery_failed',
      severity: 'critical',
    });
    expect(alerts[0].metadata).toMatchObject({
      orderNumber: 'ORD-001',
      discordId: 'user-1',
      attempts: 5,
    });
  });

  it('does not alert when a non-receipt action exhausts retries via stale recovery', async () => {
    const guild = makeGuild();
    const supa = makeSupa([], {
      staleFailed: [{ id: 'act-stale-2', action: 'channel_create', was_failed: true }],
      staleRow: {
        action: 'channel_create',
        payload: { name: 'general' },
        error_message: 'Stale processing recovery: retry budget exhausted',
        retry_count: 5,
      },
    });

    await startActionQueueListener(guild, supa);

    // DLQ write is pre-existing behavior for all stale-exhausted actions...
    expect(supa.__inserts['action_queue_dlq']).toContainEqual(
      expect.objectContaining({ action: 'channel_create', original_id: 'act-stale-2' }),
    );
    // ...but the receipt alert is only for deliver_receipt
    expect(supa.__inserts['alerts']).toBeUndefined();
  });

  it('does not dead-letter or alert other failing actions', async () => {
    const guild = makeGuild();
    const supa = makeSupa([{
      id: 'act-unknown', guild_id: 'guild-1', action: 'totally_unknown', status: 'pending',
      payload: {}, created_at: new Date().toISOString(), retry_count: 0,
    }]);

    await startActionQueueListener(guild, supa);

    expect(supa.__queueUpdates).toContainEqual(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(supa.__inserts['action_queue_dlq']).toBeUndefined();
    expect(supa.__inserts['alerts']).toBeUndefined();
  });
});
