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
 * - audit log never contains the plaintext key (queue/DLQ rows keep it)
 * - sweeps respect the next_retry_at backoff window; the periodic sweep
 *   retries due rows so they never strand across restarts
 * - redelivered receipts render the original order date
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
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
import { laneForAction } from '../services/action-queue-lanes.js';
import { writeAuditLog } from '../services/audit.js';

// ── Mocks ──────────────────────────────────────────────────

/**
 * Recording Supabase mock: captures inserts per table and status updates on
 * bot_action_queue. `retryCount` controls what the pre-retry
 * select('retry_count') lookup returns. `staleFailed` simulates the
 * SQL-owned stale-recovery finalization result; DLQ + alert writes are atomic
 * inside that RPC and must not be duplicated by the bot. `secondSweep`
 * is returned by the SECOND pending-rows query — i.e. rows that appeared
 * between the startup sweep and the Realtime subscription going live —
 * and `laterSweeps` by subsequent queries (e.g. the periodic catch-up
 * sweep). Sweep queries honor the `next_retry_at` .or() filter the way
 * the real DB would: rows still inside their backoff window are excluded.
 */
function makeSupa(
  pendingActions: any[] = [],
  opts: {
    retryCount?: number;
    staleFailed?: Array<{
      id: string;
      action: string;
      disposition: 'completed' | 'requeued' | 'failed' | 'operator_held';
    }>;
    staleRow?: Record<string, unknown> | null;
    secondSweep?: any[];
    laterSweeps?: any[][];
    retryResults?: Array<{
      data: unknown;
      error: { message: string } | null;
    }>;
  } = {},
) {
  const inserts: Record<string, any[]> = {};
  const queueUpdates: Record<string, unknown>[] = [];
  const sweepOrFilters: string[] = [];
  const sweepBatches: any[][] = [pendingActions, opts.secondSweep ?? [], ...(opts.laterSweeps ?? [])];
  const claimCandidates = new Map(
    sweepBatches.flat().map((row) => [row.id as string, row]),
  );
  let sweepCalls = 0;
  let retryCall = 0;

  const makeChain = () => {
    const chain: any = {};
    for (const m of ['select', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'or', 'order', 'limit']) {
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
          let dueOnly = false;
          inner.or = vi.fn((expr: string) => {
            if (typeof expr === 'string' && expr.includes('next_retry_at')) {
              dueOnly = true;
              sweepOrFilters.push(expr);
            }
            return inner;
          });
          inner.then = (resolve: Function) => {
            const batch = sweepBatches[sweepCalls] ?? [];
            sweepCalls++;
            const rows = dueOnly
              ? batch.filter(
                  (r: any) =>
                    !r.next_retry_at || new Date(r.next_retry_at).getTime() <= Date.now(),
                )
              : batch;
            return resolve({ data: rows, error: null });
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
    rpc: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
      if (name === 'bot_action_queue_recover_stale') {
        return { data: opts.staleFailed ?? [], error: null };
      }
      if (name === 'bot_action_queue_claim') {
        const candidate = claimCandidates.get(args.p_action_id as string);
        return {
          data: candidate ? [{
            ...candidate,
            status: 'processing',
            retry_count: candidate.retry_count ?? opts.retryCount ?? 0,
            claim_token: '44444444-4444-4444-8444-444444444444',
            lane: laneForAction(candidate.action),
          }] : null,
          error: null,
        };
      }
      if (name === 'bot_action_queue_retry_claim') {
        const response = opts.retryResults?.[retryCall++]
          ?? { data: [{ applied: true, disposition: 'requeued' }], error: null };
        const evidence = Array.isArray(response.data) ? response.data[0] : null;
        if (
          evidence
          && typeof evidence === 'object'
          && evidence.applied === true
          && evidence.disposition === 'requeued'
        ) {
          const candidate = claimCandidates.get(args.p_action_id as string);
          if (candidate) {
            candidate.retry_count = (candidate.retry_count ?? opts.retryCount ?? 0) + 1;
            candidate.status = 'pending';
            candidate.next_retry_at = args.p_next_retry_at;
            queueUpdates.push({
              status: 'pending',
              retry_count: candidate.retry_count,
              next_retry_at: args.p_next_retry_at,
              error_message: args.p_error ?? null,
            });
          }
        }
        return response;
      }
      if (name === 'bot_action_queue_finish_claim') {
        const candidate = claimCandidates.get(args.p_action_id as string);
        const status = args.p_success === true ? 'completed' : 'failed';
        queueUpdates.push({
          status,
          result: args.p_success === true ? args.p_result ?? null : null,
          error_message: args.p_success === true ? null : args.p_error ?? null,
        });
        if (candidate && status === 'failed') {
          (inserts.action_queue_dlq ??= []).push({
            guild_id: candidate.guild_id,
            action: candidate.action,
            payload: candidate.payload,
            error_message: args.p_error ?? null,
            retry_count: candidate.retry_count ?? opts.retryCount ?? 0,
            max_retries: 5,
            original_id: candidate.id,
            lane: laneForAction(candidate.action),
          });
          if (candidate.action === 'deliver_receipt') {
            (inserts.alerts ??= []).push({
              guild_id: candidate.guild_id,
              alert_type: 'receipt_delivery_failed',
              severity: 'critical',
              title: 'Paid receipt delivery failed',
              message: 'A paid receipt action exhausted its retry budget. Inspect the dead-letter queue and retry the exact action.',
              metadata: {
                action_id: candidate.id,
                next_step: 'inspect_action_queue_dlq',
              },
              resolved: false,
            });
          }
        }
        return {
          data: [{
            applied: true,
            disposition: status,
          }],
          error: null,
        };
      }
      return { data: null, error: null };
    }),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: Function) => { cb?.('SUBSCRIBED'); return 'subscribed'; }),
    })),
  };
  supa.__inserts = inserts;
  supa.__queueUpdates = queueUpdates;
  supa.__sweepOrFilters = sweepOrFilters;
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

    // Re-queued as pending with retry_count bumped, retry scheduled at 30s.
    // next_retry_at persists the backoff window so sweeps (startup, post-
    // subscribe, periodic) don't retry the row early.
    const retryUpdate = supa.__queueUpdates.find(
      (u: any) => u.status === 'pending' && u.retry_count === 1,
    );
    expect(retryUpdate).toBeDefined();
    expect(retryUpdate.next_retry_at).toEqual(expect.any(String));
    expect(new Date(retryUpdate.next_retry_at).getTime() - Date.now()).toBe(30_000);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    // Not dead-lettered yet — retries still available
    expect(supa.__inserts['action_queue_dlq']).toBeUndefined();
    expect(supa.__inserts['alerts']).toBeUndefined();

    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('accepts exact durable completion evidence instead of scheduling a stale retry', async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      mockDeliverReceiptDM.mockRejectedValue(new Error('503 Service Unavailable'));
      const guild = makeGuild();
      const supa = makeSupa([deliveryAction()], {
        retryResults: [{
          data: [{ applied: false, disposition: 'completed' }],
          error: null,
        }],
      });

      await startActionQueueListener(guild, supa);

      expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(
        supa.rpc.mock.calls.filter(([name]: [string]) =>
          name === 'bot_action_queue_finish_claim'),
      ).toHaveLength(0);
      const actionAudit = vi.mocked(writeAuditLog).mock.calls.find(
        ([, entry]) => entry.action === 'bot.deliver_receipt',
      )?.[1];
      expect(actionAudit).toMatchObject({
        success: true,
        details: { finalDisposition: 'completed_from_evidence' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not schedule or finalize a retry whose exact claim is stale', async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      mockDeliverReceiptDM.mockRejectedValue(new Error('503 Service Unavailable'));
      const guild = makeGuild();
      const supa = makeSupa([deliveryAction()], {
        retryResults: [{
          data: [{ applied: false, disposition: 'stale_claim' }],
          error: null,
        }],
      });

      await startActionQueueListener(guild, supa);

      expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(
        supa.rpc.mock.calls.filter(([name]: [string]) =>
          name === 'bot_action_queue_finish_claim'),
      ).toHaveLength(0);
      expect(vi.mocked(writeAuditLog).mock.calls.some(
        ([, entry]) => entry.action === 'bot.deliver_receipt',
      )).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a non-string retry disposition even when string coercion looks valid', async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      mockDeliverReceiptDM.mockRejectedValue(new Error('503 Service Unavailable'));
      const guild = makeGuild();
      const supa = makeSupa([deliveryAction()], {
        retryResults: [{
          data: [{
            applied: true,
            disposition: { toString: (): string => 'requeued' },
          }],
          error: null,
        }],
      });

      await startActionQueueListener(guild, supa);

      expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(
        supa.rpc.mock.calls.filter(([name]: [string]) =>
          name === 'bot_action_queue_finish_claim'),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('audits an SQL-owned operator hold without retrying or re-finalizing it', async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      mockDeliverReceiptDM.mockRejectedValue(new Error('503 Service Unavailable'));
      const guild = makeGuild();
      const supa = makeSupa([deliveryAction()], {
        retryResults: [{
          data: [{ applied: false, disposition: 'operator_held' }],
          error: null,
        }],
      });

      await startActionQueueListener(guild, supa);

      expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(
        supa.rpc.mock.calls.filter(([name]: [string]) =>
          name === 'bot_action_queue_finish_claim'),
      ).toHaveLength(0);
      const actionAudit = vi.mocked(writeAuditLog).mock.calls.find(
        ([, entry]) => entry.action === 'bot.deliver_receipt',
      )?.[1];
      expect(actionAudit).toMatchObject({
        success: false,
        details: { finalDisposition: 'failed' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reclassifies an intent race before scheduling the sole valid requeue transition', async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      mockDeliverReceiptDM.mockRejectedValue(new Error('503 Service Unavailable'));
      const guild = makeGuild();
      const supa = makeSupa([deliveryAction()], {
        retryResults: [
          { data: [{ applied: false, disposition: 'intent_raced' }], error: null },
          { data: [{ applied: true, disposition: 'requeued' }], error: null },
        ],
      });

      await startActionQueueListener(guild, supa);

      expect(
        supa.rpc.mock.calls.filter(([name]: [string]) =>
          name === 'bot_action_queue_retry_claim'),
      ).toHaveLength(2);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(
        supa.rpc.mock.calls.filter(([name]: [string]) =>
          name === 'bot_action_queue_finish_claim'),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
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

    // The exact finish-claim RPC atomically dead-letters the failed generation.
    expect(supa.__inserts['action_queue_dlq']).toContainEqual(
      expect.objectContaining({
        guild_id: 'guild-1',
        action: 'deliver_receipt',
        original_id: 'act-deliver-1',
      }),
    );

    // The same SQL transition emits the minimal operator alert without copying
    // receipt PII or the plaintext license key into long-retained metadata.
    const alerts = supa.__inserts['alerts'];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      guild_id: 'guild-1',
      alert_type: 'receipt_delivery_failed',
      severity: 'critical',
    });
    expect(alerts[0].message).toContain('dead-letter queue');
    expect(alerts[0].metadata).toEqual({
      action_id: 'act-deliver-1',
      next_step: 'inspect_action_queue_dlq',
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
        retry_count: 3,
      }),
    );

    const alerts = supa.__inserts['alerts'];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      alert_type: 'receipt_delivery_failed',
      severity: 'critical',
    });
    expect(alerts[0].metadata).toEqual({
      action_id: 'act-deliver-1',
      next_step: 'inspect_action_queue_dlq',
    });

    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('processes deliver_receipt rows queued during the startup sweep once Realtime subscribes', async () => {
    // Startup race: the startup pending sweep runs BEFORE the Realtime
    // subscription exists. Processing a backlogged fulfill_purchase whose
    // receipt DM fails inserts a NEW pending deliver_receipt row — after the
    // sweep's snapshot, before the subscription — so Realtime never fires
    // for it. The listener must re-sweep pending rows once the subscription
    // reports SUBSCRIBED, or the redelivery sits stuck until next restart.
    const guild = makeGuild();
    const supa = makeSupa([], { secondSweep: [deliveryAction()] });

    await startActionQueueListener(guild, supa);

    // The post-subscribe sweep is fire-and-forget — wait for it to land.
    await vi.waitFor(() => {
      expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(1);
    });
    expect(mockDeliverReceiptDM).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({
        orderNumber: 'ORD-001',
        licenseKey: 'SMNI-AAAA-BBBB-CCCC-DDDD',
      }),
    );
    await vi.waitFor(() => {
      expect(supa.__queueUpdates).toContainEqual(
        expect.objectContaining({ status: 'completed' }),
      );
    });
  });

  it('does not duplicate SQL-owned receipt DLQ/alert writes after stale recovery', async () => {
    // Exhaustion has a second path: the bot repeatedly crashed mid-delivery,
    // so bot_action_queue_recover_stale (not the in-process retry loop)
    // flipped the row to failed. That path must ALSO dead-letter + alert —
    // a paid customer's license key must never disappear silently.
    const guild = makeGuild();
    const supa = makeSupa([], {
      staleFailed: [{ id: 'act-stale-1', action: 'deliver_receipt', disposition: 'failed' }],
      staleRow: {
        action: 'deliver_receipt',
        payload: { discord_id: 'user-1', order_number: 'ORD-001', product_name: 'VIP Pass' },
        error_message: 'Stale processing recovery: retry budget exhausted',
        retry_count: 5,
      },
    });

    await startActionQueueListener(guild, supa);

    expect(supa.__inserts['action_queue_dlq']).toBeUndefined();
    expect(supa.__inserts['alerts']).toBeUndefined();
  });

  it('does not alert when a non-receipt action exhausts retries via stale recovery', async () => {
    const guild = makeGuild();
    const supa = makeSupa([], {
      staleFailed: [{ id: 'act-stale-2', action: 'channel_create', disposition: 'failed' }],
      staleRow: {
        action: 'channel_create',
        payload: { name: 'general' },
        error_message: 'Stale processing recovery: retry budget exhausted',
        retry_count: 5,
      },
    });

    await startActionQueueListener(guild, supa);

    // The recovery RPC owns all final DLQ writes, including non-receipts.
    expect(supa.__inserts['action_queue_dlq']).toBeUndefined();
    expect(supa.__inserts['alerts']).toBeUndefined();
  });

  it('dead-letters other final failures without emitting a receipt alert', async () => {
    const guild = makeGuild();
    const supa = makeSupa([{
      id: 'act-unknown', guild_id: 'guild-1', action: 'totally_unknown', status: 'pending',
      payload: {}, created_at: new Date().toISOString(), retry_count: 0,
    }]);

    await startActionQueueListener(guild, supa);

    expect(supa.__queueUpdates).toContainEqual(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(supa.__inserts['action_queue_dlq']).toContainEqual(
      expect.objectContaining({
        action: 'totally_unknown',
        original_id: 'act-unknown',
        lane: 'game',
      }),
    );
    expect(supa.__inserts['alerts']).toBeUndefined();
  });

  it('redacts the plaintext license key from the audit log while the live payload keeps it', async () => {
    // audit_logs has long, guild-configurable retention (default 180 days) —
    // the plaintext key must never be copied there. The queue/DLQ payload
    // keeping the key is intentional (retryability); only the audit copy is
    // redacted, and redaction must not mutate the payload the handler uses.
    const guild = makeGuild();
    const action = deliveryAction();
    const supa = makeSupa([action]);

    await startActionQueueListener(guild, supa);

    // Delivery itself used the real key…
    expect(mockDeliverReceiptDM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ licenseKey: 'SMNI-AAAA-BBBB-CCCC-DDDD' }),
    );
    // …and the queue row's payload still carries it (not mutated by redaction)
    expect(action.payload.license_key_plaintext).toBe('SMNI-AAAA-BBBB-CCCC-DDDD');

    // But the audit entry never sees the plaintext key
    const auditCalls = vi.mocked(writeAuditLog).mock.calls
      .filter(([, entry]) => entry.action === 'bot.deliver_receipt');
    expect(auditCalls).toHaveLength(1);
    const auditEntry = auditCalls[0][1];
    expect((auditEntry.details?.payload as any).license_key_plaintext).toBe('[REDACTED]');
    expect(JSON.stringify(auditEntry)).not.toContain('SMNI-AAAA-BBBB-CCCC-DDDD');
    // Non-sensitive payload fields are preserved for the audit trail
    expect(auditEntry.details?.payload).toMatchObject({ order_number: 'ORD-001' });
  });

  it('sweeps skip rows still inside their retry backoff window', async () => {
    // processAction returns transiently-failed rows to 'pending' with
    // next_retry_at at the end of their 30/60/120s backoff. The post-
    // subscribe sweep (which fires on every Realtime reconnect) must not
    // retry them early — that would defeat the backoff.
    const guild = makeGuild();
    const parked = deliveryAction({
      retry_count: 1,
      next_retry_at: new Date(Date.now() + 20_000).toISOString(), // still backing off
    });
    const supa = makeSupa([], { secondSweep: [parked] });

    await startActionQueueListener(guild, supa);

    // Wait for the fire-and-forget post-subscribe sweep to run its query…
    await vi.waitFor(() => {
      expect(supa.__sweepOrFilters.length).toBeGreaterThanOrEqual(2);
    });
    // …every sweep filtered on the backoff schedule, and the parked row was
    // not retried early.
    expect(supa.__sweepOrFilters[0]).toMatch(/next_retry_at\.is\.null,next_retry_at\.lte\./);
    expect(mockDeliverReceiptDM).not.toHaveBeenCalled();
  });

  it('the periodic sweep picks up rows whose backoff elapsed, so they never strand', async () => {
    // If the bot restarts during a backoff window, the in-process retry
    // timer is lost and the startup/subscribe sweeps skip the row (still
    // inside its window). The periodic sweep must retry it once due —
    // otherwise the original P1 (stranded redelivery) comes back.
    vi.useFakeTimers();
    try {
      const guild = makeGuild();
      const due = deliveryAction({
        retry_count: 1,
        next_retry_at: new Date(Date.now() - 1_000).toISOString(), // backoff elapsed
      });
      // Sweeps: startup → [], post-subscribe → [], periodic (60s) → [due]
      const supa = makeSupa([], { secondSweep: [], laterSweeps: [[due]] });

      await startActionQueueListener(guild, supa);
      expect(mockDeliverReceiptDM).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(1);
      expect(supa.__queueUpdates).toContainEqual(
        expect.objectContaining({ status: 'completed' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a delayed redelivery with the original order date, not the retry time', async () => {
    const guild = makeGuild();
    const orderDate = '2026-07-01T15:30:00.000Z';
    const supa = makeSupa([
      deliveryAction({
        payload: { ...deliveryAction().payload, order_date: orderDate },
      }),
    ]);

    await startActionQueueListener(guild, supa);

    expect(mockDeliverReceiptDM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ date: new Date(orderDate) }),
    );
  });

  it('falls back to now for legacy queued rows without order_date', async () => {
    const guild = makeGuild();
    const supa = makeSupa([deliveryAction()]); // fixture has no order_date

    const before = Date.now();
    await startActionQueueListener(guild, supa);
    const after = Date.now();

    const [, receipt] = mockDeliverReceiptDM.mock.calls[0] as unknown as [unknown, { date: Date }];
    expect(receipt.date.getTime()).toBeGreaterThanOrEqual(before);
    expect(receipt.date.getTime()).toBeLessThanOrEqual(after);
  });
});
