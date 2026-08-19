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
  prepareReceiptDM: vi.fn(async (...args: unknown[]) => async () => {
    await (mockDeliverReceiptDM as (...values: unknown[]) => Promise<void>)(...args);
  }),
}));

import { ACTION_HANDLERS, startActionQueueListener } from '../services/action-queue.js';
import { laneForAction } from '../services/action-queue-lanes.js';
import { writeAuditLog } from '../services/audit.js';

// ── Mocks ──────────────────────────────────────────────────

function receiptGenerationEvidence(
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    action_id: args.p_action_id,
    claim_token: args.p_claim_token,
    order_id: args.p_order_id,
    guild_id: args.p_guild_id,
    customer_id: args.p_customer_id,
    discord_id: args.p_discord_id,
    product_id: args.p_product_id,
    order_number: args.p_order_number,
    product_name: args.p_product_name,
    amount_cents: args.p_amount_cents,
    currency: args.p_currency,
    license_key_id: args.p_license_key_id,
    outward_generation_id: '77777777-7777-4777-8777-777777777777',
    disposition: 'prepared',
    ...overrides,
  };
}

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
  let outwardState: 'absent' | 'sending' | 'sent' | 'uncertain' = 'absent';
  let outwardToken: string | null = null;

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
      if (name === 'commerce_prepare_action_outward_generation') {
        return {
          data: receiptGenerationEvidence(args),
          error: null,
        };
      }
      if (name === 'commerce_begin_fulfillment_outward_intent') {
        if (outwardState === 'absent') {
          outwardState = 'sending';
          outwardToken = '88888888-8888-4888-8888-888888888888';
          return {
            data: {
              order_id: args.p_order_id,
              guild_id: args.p_guild_id,
              intent_kind: args.p_intent_kind,
              outward_generation_id: args.p_outward_generation_id,
              disposition: 'send',
              state: 'sending',
              attempt_token: outwardToken,
              alert_id: null,
            },
            error: null,
          };
        }
        if (outwardState === 'sending') {
          outwardState = 'uncertain';
          outwardToken = null;
        }
        return {
          data: {
            order_id: args.p_order_id,
            guild_id: args.p_guild_id,
            intent_kind: args.p_intent_kind,
            outward_generation_id: args.p_outward_generation_id,
            disposition: outwardState === 'sent' ? 'sent' : 'uncertain',
            state: outwardState,
            attempt_token: null,
            alert_id: outwardState === 'uncertain' ? 'alert-outward-uncertain' : null,
          },
          error: null,
        };
      }
      if (name === 'commerce_finish_fulfillment_outward_intent') {
        if (outwardToken !== args.p_attempt_token) {
          return { data: null, error: { message: 'outward attempt mismatch' } };
        }
        outwardState = args.p_outcome === 'sent' ? 'sent' : 'uncertain';
        outwardToken = null;
        return {
          data: {
            order_id: args.p_order_id,
            guild_id: args.p_guild_id,
            intent_kind: args.p_intent_kind,
            outward_generation_id: args.p_outward_generation_id,
            state: outwardState,
            alert_id: outwardState === 'uncertain' ? 'alert-outward-uncertain' : null,
          },
          error: null,
        };
      }
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
      customer_id: 'customer-1',
      discord_id: 'user-1',
      product_id: 'product-1',
      order_id: 'order-1',
      order_number: 'ORD-001',
      product_name: 'VIP Pass',
      amount_cents: 999,
      currency: 'USD',
      license_key_id: 'license-1',
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
  vi.resetAllMocks();
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
      // White-label: the receipt DM now renders through the guild's brand kit.
      expect.objectContaining({ brandName: expect.any(String) }),
    );
    expect(supa.__queueUpdates).toContainEqual(
      expect.objectContaining({ status: 'completed' }),
    );
    // No failure artifacts on the happy path
    expect(supa.__inserts['action_queue_dlq']).toBeUndefined();
    expect(supa.__inserts['alerts']).toBeUndefined();
  });

  it('does not resend an accepted receipt when action finalization is lost and the exact claim is recovered', async () => {
    const guild = makeGuild();
    const supa = makeSupa();
    const originalRpc = supa.rpc.getMockImplementation();
    let outwardState: 'absent' | 'sending' | 'sent' = 'absent';
    supa.rpc.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
      if (name === 'commerce_prepare_action_outward_generation') {
        return {
          data: receiptGenerationEvidence(args),
          error: null,
        };
      }
      if (name === 'commerce_begin_fulfillment_outward_intent') {
        if (outwardState === 'sent') {
          return {
            data: {
              order_id: args.p_order_id,
              guild_id: args.p_guild_id,
              intent_kind: 'receipt_dm',
              outward_generation_id: args.p_outward_generation_id,
              disposition: 'sent',
              state: 'sent',
              attempt_token: null,
              alert_id: null,
            },
            error: null,
          };
        }
        outwardState = 'sending';
        return {
          data: {
            order_id: args.p_order_id,
            guild_id: args.p_guild_id,
            intent_kind: 'receipt_dm',
            outward_generation_id: args.p_outward_generation_id,
            disposition: 'send',
            state: 'sending',
            attempt_token: '88888888-8888-4888-8888-888888888888',
            alert_id: null,
          },
          error: null,
        };
      }
      if (name === 'commerce_finish_fulfillment_outward_intent') {
        outwardState = 'sent';
        return {
          data: {
            order_id: args.p_order_id,
            guild_id: args.p_guild_id,
            intent_kind: 'receipt_dm',
            outward_generation_id: args.p_outward_generation_id,
            state: 'sent',
            alert_id: null,
          },
          error: null,
        };
      }
      return originalRpc!(name, args);
    });
    const payload = deliveryAction().payload;
    const handler = ACTION_HANDLERS.deliver_receipt!;
    const context = {
      actionId: 'act-deliver-1',
      claimToken: '44444444-4444-4444-8444-444444444444',
    };

    const acceptedBeforeLostFinalization = await handler(guild, supa, payload, context);
    const recoveredClaim = await handler(guild, supa, payload, context);

    expect(acceptedBeforeLostFinalization.success).toBe(true);
    expect(recoveredClaim.success).toBe(true);
    expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(1);
    expect(outwardState).toBe('sent');
  });

  it('holds an accepted DM when outward finish has no committed response and never sends it again', async () => {
    const guild = makeGuild();
    const supa = makeSupa();
    const originalRpc = supa.rpc.getMockImplementation();
    let outwardState: 'absent' | 'sending' | 'uncertain' = 'absent';
    supa.rpc.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
      if (name === 'commerce_prepare_action_outward_generation') {
        return {
          data: receiptGenerationEvidence(args),
          error: null,
        };
      }
      if (name === 'commerce_begin_fulfillment_outward_intent') {
        if (outwardState === 'absent') {
          outwardState = 'sending';
          return {
            data: {
              order_id: args.p_order_id,
              guild_id: args.p_guild_id,
              intent_kind: 'receipt_dm',
              outward_generation_id: args.p_outward_generation_id,
              disposition: 'send',
              state: 'sending',
              attempt_token: '88888888-8888-4888-8888-888888888888',
              alert_id: null,
            },
            error: null,
          };
        }
        outwardState = 'uncertain';
        return {
        data: {
          order_id: args.p_order_id,
          guild_id: args.p_guild_id,
          intent_kind: 'receipt_dm',
            outward_generation_id: args.p_outward_generation_id,
            disposition: 'uncertain',
            state: 'uncertain',
            attempt_token: null,
            alert_id: 'alert-outward-uncertain',
          },
          error: null,
        };
      }
      if (name === 'commerce_finish_fulfillment_outward_intent') {
        return { data: null, error: { message: 'commit response unavailable' } };
      }
      return originalRpc!(name, args);
    });
    const handler = ACTION_HANDLERS.deliver_receipt!;
    const payload = deliveryAction().payload;
    const context = {
      actionId: 'act-deliver-1',
      claimToken: '44444444-4444-4444-8444-444444444444',
    };

    const first = await handler(guild, supa, payload, context);
    const recovered = await handler(guild, supa, payload, context);

    expect(first.success).toBe(false);
    expect(recovered).toMatchObject({ success: false, retryable: false });
    expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(1);
    expect(outwardState).toBe('uncertain');
  });

  it('keeps pre-send user preparation safely retryable with no outward row, then sends once', async () => {
    const guild = makeGuild();
    guild.client.users.fetch
      .mockRejectedValueOnce(new Error('user preparation unavailable'))
      .mockResolvedValue({ id: 'user-1' });
    const supa = makeSupa();
    const handler = ACTION_HANDLERS.deliver_receipt!;
    const payload = deliveryAction().payload;
    const context = {
      actionId: 'act-deliver-1',
      claimToken: '44444444-4444-4444-8444-444444444444',
    };

    const first = await handler(guild, supa, payload, context);
    const beginCallsBeforeRetry = supa.rpc.mock.calls.filter(
      ([name]: [string]) => name === 'commerce_begin_fulfillment_outward_intent',
    );
    const retry = await handler(guild, supa, payload, context);

    expect(first).toMatchObject({ success: false, retryable: true });
    expect(beginCallsBeforeRetry).toEqual([]);
    expect(retry.success).toBe(true);
    expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(1);
  });

  it('fails a retried legacy receipt with no generation closed and sends no DM', async () => {
    const guild = makeGuild();
    const supa = makeSupa();
    const originalRpc = supa.rpc.getMockImplementation();
    supa.rpc.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
      if (name === 'commerce_prepare_action_outward_generation') {
        return {
          data: null,
          error: {
            message: 'legacy receipt retry has no durable generation',
            code: '23514',
          },
        };
      }
      return originalRpc!(name, args);
    });

    const result = await ACTION_HANDLERS.deliver_receipt!(
      guild,
      supa,
      deliveryAction({ retry_count: 1 }).payload,
      {
        actionId: 'act-deliver-1',
        claimToken: '44444444-4444-4444-8444-444444444444',
      },
    );

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(mockDeliverReceiptDM).not.toHaveBeenCalled();
    expect(supa.rpc).not.toHaveBeenCalledWith(
      'commerce_begin_fulfillment_outward_intent',
      expect.anything(),
    );
  });

  it('retries a lost generation-bind response with the same carrier and sends once', async () => {
    const guild = makeGuild();
    const supa = makeSupa();
    const originalRpc = supa.rpc.getMockImplementation();
    let bindCalls = 0;
    supa.rpc.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
      if (name === 'commerce_prepare_action_outward_generation') {
        bindCalls += 1;
        if (bindCalls === 1) {
          // The SQL transaction may have committed even though the transport
          // did not return its evidence.
          return { data: null, error: { message: 'connection closed after commit' } };
        }
        return {
          data: receiptGenerationEvidence(args, { disposition: 'replay' }),
          error: null,
        };
      }
      return originalRpc!(name, args);
    });
    const handler = ACTION_HANDLERS.deliver_receipt!;
    const payload = deliveryAction().payload;
    const context = {
      actionId: 'act-deliver-1',
      claimToken: '44444444-4444-4444-8444-444444444444',
    };

    const lost = await handler(guild, supa, payload, context);
    const recovered = await handler(guild, supa, payload, context);

    expect(lost).toMatchObject({ success: false, retryable: true });
    expect(recovered.success).toBe(true);
    expect(bindCalls).toBe(2);
    expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(1);
  });

  it('retries provably pre-send preparation failures with exponential backoff', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const guild = makeGuild();
    guild.client.users.fetch.mockRejectedValue(new Error('503 Service Unavailable'));
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
      const guild = makeGuild();
      guild.client.users.fetch.mockRejectedValue(new Error('503 Service Unavailable'));
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
      const guild = makeGuild();
      guild.client.users.fetch.mockRejectedValue(new Error('503 Service Unavailable'));
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
      const guild = makeGuild();
      guild.client.users.fetch.mockRejectedValue(new Error('503 Service Unavailable'));
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
      const guild = makeGuild();
      guild.client.users.fetch.mockRejectedValue(new Error('503 Service Unavailable'));
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

  it('waits for a concurrent intent controller before scheduling the sole valid requeue transition', async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const guild = makeGuild();
      guild.client.users.fetch.mockRejectedValue(new Error('503 Service Unavailable'));
      const supa = makeSupa([deliveryAction()], {
        retryResults: [
          { data: [{ applied: false, disposition: 'intent_raced' }], error: null },
          { data: [{ applied: false, disposition: 'intent_raced' }], error: null },
          { data: [{ applied: false, disposition: 'intent_raced' }], error: null },
          { data: [{ applied: true, disposition: 'requeued' }], error: null },
        ],
      });

      const listenerStarted = startActionQueueListener(guild, supa);
      await vi.advanceTimersByTimeAsync(3_000);
      await listenerStarted;

      expect(
        supa.rpc.mock.calls.filter(([name]: [string]) =>
          name === 'bot_action_queue_retry_claim'),
      ).toHaveLength(4);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
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
      // White-label: the receipt DM now renders through the guild's brand kit.
      expect.objectContaining({ brandName: expect.any(String) }),
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
      // White-label: the receipt DM now renders through the guild's brand kit.
      expect.objectContaining({ brandName: expect.any(String) }),
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
      // White-label: the receipt DM now renders through the guild's brand kit.
      expect.objectContaining({ brandName: expect.any(String) }),
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
