/**
 * Tests for bot_action_queue lane segregation — commerce vs game.
 *
 * The queue carries BOTH real-commerce fulfillment (fulfill_*, deliver_receipt,
 * revoke_roles — paid customers' money) and game-economy / infra jobs
 * (market_item_reconcile, bulk ops, config reloads — play money and plumbing).
 * Requirement: commerce jobs can NEVER be starved or delayed by game-job
 * floods.
 *
 * Covers:
 * - laneForAction classifies every commerce action into the commerce lane and
 *   everything else into the game lane
 * - lane values sort lexicographically in priority order (the sweep relies on
 *   ORDER BY lane putting commerce rows first, ahead of the batch LIMIT)
 * - LaneScheduler enforces independent per-lane concurrency budgets: a game
 *   flood saturates only the game budget; commerce tasks are admitted
 *   immediately under their own budget
 * - starvation resistance end-to-end: seed N game jobs + 1 newer commerce job,
 *   the commerce job is claimed FIRST in the sweep
 * - Realtime flood: game INSERT events beyond the game budget queue in-process
 *   without claiming rows, while a commerce event is processed immediately
 * - per-lane pending-depth alerts: thresholds, dedupe via 23505 unique-index
 *   tolerance, auto-resolve when the lane drains
 * - COMMERCE_LANE_ACTIONS stays in lock-step with the SQL classification in
 *   migration 20260710020000
 * - DLQ writes do NOT write the lane column from code — the DB trigger derives
 *   it (deploy-skew safety: a code-side lane write would fail with an
 *   undefined-column error wherever the bot runs ahead of the migration)
 * - sweep falls back to an action-name lane partition if the lane-ordered
 *   query fails (pre-migration environment), instead of stranding the
 *   backlog — and that fallback STILL fetches commerce first at the query
 *   level, so a >LIMIT game backlog cannot evict commerce from the batch
 * - stale recovery re-feeds commerce rows first at the QUERY level: the
 *   recovery RPC is uncapped, so the re-fetch budget is spent on commerce
 *   ids before any game id (an unordered capped fetch could fill entirely
 *   with game rows and evict commerce before any in-memory sort ran)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

import {
  ACTION_QUEUE_LANES,
  COMMERCE_LANE_ACTIONS,
  LANE_CONCURRENCY,
  LANE_PENDING_DEPTH_THRESHOLDS,
  LaneScheduler,
  laneDepthAlertType,
  laneForAction,
} from '../services/action-queue-lanes.js';
import {
  checkLanePendingDepthAlerts,
  startActionQueueListener,
} from '../services/action-queue.js';

// ── Helpers ────────────────────────────────────────────────

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

/** A resolvable gate for hanging tasks in scheduler tests. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ── laneForAction classification ───────────────────────────

describe('laneForAction', () => {
  it.each([
    'fulfill_purchase',
    'fulfill_subscription',
    'fulfill_cancellation',
    'fulfill_suspension',
    'fulfill_giveaway_prize',
    'notify_giveaway_winner',
    'deliver_receipt',
    'revoke_roles',
    'reconcile_entitlement_roles',
  ])('classifies %s into the commerce lane', (action) => {
    expect(laneForAction(action)).toBe('commerce');
    expect(COMMERCE_LANE_ACTIONS.has(action)).toBe(true);
  });

  it.each([
    'market_item_reconcile',
    'create_role',
    'delete_channel',
    'config_reload',
    'send_embed',
    'test_welcome',
    'bulk_role_add',
    'bulk_role_remove',
    'bulk_send_dm',
    'emit_audit_event',
    'run_reconciliation',
    'sync_repair_drift',
    'refresh_snapshot',
    'totally_unknown_action',
  ])('classifies %s into the game lane', (action) => {
    expect(laneForAction(action)).toBe('game');
  });

  it('orders lanes commerce-first, and lexicographic order matches priority order', () => {
    // The pending sweep uses ORDER BY lane ASC to put commerce rows ahead of
    // the batch LIMIT. That only works while the lane values sort
    // lexicographically in priority order — guard it here.
    expect(ACTION_QUEUE_LANES).toEqual(['commerce', 'game']);
    expect([...ACTION_QUEUE_LANES].sort()).toEqual([...ACTION_QUEUE_LANES]);
  });

  it('mirrors the final SQL classification list exactly', () => {
    // The DB trigger (bot_action_queue_lane_for_action) is the authoritative
    // classifier; COMMERCE_LANE_ACTIONS is the TypeScript mirror used for
    // in-process scheduling and legacy-row fallback. If the two lists drift,
    // a commerce action could be prioritized in one layer but not the other —
    // pin them to each other by parsing the migration's IN (...) list.
    const testDir = dirname(fileURLToPath(import.meta.url));
    const migrationPath = resolve(
      testDir,
      '../../../supabase/migrations/20260711030000_canonicalize_commerce_role_metadata.sql',
    );
    const sql = readFileSync(migrationPath, 'utf8');

    const caseMatch = sql.match(
      /WHEN\s+p_action\s+IN\s*\(([^)]+)\)\s*THEN\s*'commerce'/i,
    );
    expect(caseMatch, 'commerce IN (...) list not found in migration').not.toBeNull();

    const sqlActions = [...caseMatch![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(new Set(sqlActions)).toEqual(new Set(COMMERCE_LANE_ACTIONS));
  });
});

// ── LaneScheduler ──────────────────────────────────────────

describe('LaneScheduler', () => {
  it('caps concurrent tasks per lane at the lane budget', async () => {
    const scheduler = new LaneScheduler({ commerce: 2, game: 2 });
    const g = gate();
    let started = 0;

    const tasks = Array.from({ length: 5 }, () =>
      scheduler.run('game', async () => { started++; await g.promise; }),
    );
    await flushMicrotasks();

    expect(started).toBe(2);
    expect(scheduler.activeCount('game')).toBe(2);
    expect(scheduler.queuedCount('game')).toBe(3);

    g.release();
    await Promise.all(tasks);
    expect(started).toBe(5);
    expect(scheduler.activeCount('game')).toBe(0);
    expect(scheduler.queuedCount('game')).toBe(0);
  });

  it('admits commerce tasks immediately while the game lane is saturated', async () => {
    const scheduler = new LaneScheduler({ commerce: 1, game: 1 });
    const gameGate = gate();
    const gameTask = scheduler.run('game', async () => { await gameGate.promise; });
    // More game tasks than budget — all queued behind the first
    const gameFlood = Array.from({ length: 3 }, () =>
      scheduler.run('game', async () => { await gameGate.promise; }),
    );
    await flushMicrotasks();
    expect(scheduler.activeCount('game')).toBe(1);
    expect(scheduler.queuedCount('game')).toBe(3);

    // Commerce is NOT behind the game backlog
    let commerceRan = false;
    await scheduler.run('commerce', async () => { commerceRan = true; });
    expect(commerceRan).toBe(true);

    gameGate.release();
    await Promise.all([gameTask, ...gameFlood]);
  });

  it('releases the slot when a task throws, and keeps FIFO order', async () => {
    const scheduler = new LaneScheduler({ commerce: 1, game: 1 });
    const order: string[] = [];
    const first = scheduler
      .run('game', async () => { order.push('first'); throw new Error('boom'); })
      .catch((err: Error) => err.message);
    const second = scheduler.run('game', async () => { order.push('second'); });
    const third = scheduler.run('game', async () => { order.push('third'); });

    expect(await first).toBe('boom');
    await Promise.all([second, third]);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(scheduler.activeCount('game')).toBe(0);
  });
});

// ── Recording supabase mock with DB-ordering emulation ─────

/**
 * Emulates the DB for sweep/recovery queries: applies the requested filters
 * (eq, in, not-in), ORDER BY columns (lane, created_at) and LIMIT to the
 * seeded rowset, exactly like Postgres would. If the implementation does NOT
 * ask for lane ordering (or an equivalent query-level partition), rows come
 * back in created_at order — which starves the newer commerce row behind the
 * older game flood. Each seeded row is served at most once across queries
 * (emulating rows leaving 'pending' once claimed), so multi-phase fetches
 * and repeat sweeps behave like the real DB. Head/count queries (per-lane
 * depth checks) are answered from the seeded rows without consuming rows.
 */
function makeLaneSupa(seedRows: any[] = [], opts: {
  staleFailed?: Array<{
    id: string;
    action: string;
    disposition: 'completed' | 'requeued' | 'failed' | 'operator_held';
  }>;
  staleRow?: Record<string, unknown> | null;
  /** Simulate a pre-migration DB: any lane-ordered query errors. */
  laneColumnMissing?: boolean;
} = {}) {
  const claimOrder: string[] = [];
  const inserts: Record<string, any[]> = {};
  const alertUpdates: any[] = [];
  const failedSweepQueries: string[][] = [];
  const servedIds = new Set<string>();
  const claimCandidates = new Map(seedRows.map((row) => [row.id as string, row]));
  const realtime: {
    handler: ((payload: { new: any }) => Promise<void>) | null;
    handlers: Partial<Record<'INSERT' | 'UPDATE', (payload: { new: any }) => Promise<void>>>;
  } = { handler: null, handlers: {} };

  const genericChain = () => {
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
      const chain = genericChain();
      chain.insert = vi.fn((row: Record<string, unknown>) => {
        (inserts[table] ??= []).push(row);
        return chain;
      });
      if (table === 'alerts') {
        chain.update = vi.fn((row: Record<string, unknown>) => {
          alertUpdates.push(row);
          return chain;
        });
      }
      if (table === 'bot_action_queue') {
        chain.select = vi.fn((cols?: string, selectOpts?: { count?: string; head?: boolean }) => {
          const inner = genericChain();
          const eqFilters: Record<string, unknown> = {};
          const inFilters: Record<string, unknown[]> = {};
          let notInActions: string[] | null = null;
          const orderCols: string[] = [];
          let limitN = Infinity;
          inner.eq = vi.fn((col: string, val: unknown) => { eqFilters[col] = val; return inner; });
          inner.in = vi.fn((col: string, vals: unknown[]) => { inFilters[col] = vals; return inner; });
          inner.not = vi.fn((col: string, op: string, val: string) => {
            // PostgREST not-in filter: .not('action', 'in', '(a,b,c)')
            if (col === 'action' && op === 'in') {
              notInActions = val
                .replace(/^\(|\)$/g, '')
                .split(',')
                .map((s) => s.trim().replace(/^"|"$/g, ''));
            }
            return inner;
          });
          inner.order = vi.fn((col: string) => { orderCols.push(col); return inner; });
          inner.limit = vi.fn((n: number) => { limitN = n; return inner; });
          if (cols === 'retry_count') {
            inner.maybeSingle = vi.fn().mockResolvedValue({ data: { retry_count: 0 }, error: null });
          }
          if (cols === 'action, payload, error_message, retry_count') {
            inner.maybeSingle = vi.fn().mockResolvedValue({ data: opts.staleRow ?? null, error: null });
          }
          inner.then = (resolve: Function) => {
            if (selectOpts?.head) {
              // Per-lane depth check: count seeded pending rows for the lane
              const count = seedRows.filter(
                (r) => (eqFilters.lane === undefined || r.lane === eqFilters.lane) &&
                       (eqFilters.status === undefined || r.status === eqFilters.status),
              ).length;
              return resolve({ data: null, count, error: null });
            }
            if (opts.laneColumnMissing && orderCols.includes('lane')) {
              // Postgres rejects the whole query when ORDER BY references a
              // missing column — exactly what a pre-migration DB does.
              failedSweepQueries.push([...orderCols]);
              return resolve({
                data: null,
                error: { message: 'column bot_action_queue.lane does not exist' },
              });
            }
            let rows = seedRows.filter((r) =>
              !servedIds.has(r.id) &&
              (eqFilters.guild_id === undefined || r.guild_id === eqFilters.guild_id) &&
              (eqFilters.status === undefined || r.status === eqFilters.status) &&
              (inFilters.id === undefined || (inFilters.id as string[]).includes(r.id)) &&
              (inFilters.action === undefined || (inFilters.action as string[]).includes(r.action)) &&
              (notInActions === null || !notInActions.includes(r.action)),
            );
            if (orderCols[0] === 'lane') {
              rows.sort((a, b) =>
                a.lane === b.lane
                  ? a.created_at.localeCompare(b.created_at)
                  : a.lane.localeCompare(b.lane));
            } else {
              rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
            }
            rows = rows.slice(0, limitN);
            for (const r of rows) servedIds.add(r.id);
            return resolve({ data: rows, error: null });
          };
          return inner;
        });
      }
      return chain;
    }),
    rpc: vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (name === 'bot_action_queue_claim') {
        claimOrder.push(params.p_action_id as string);
        const candidate = claimCandidates.get(params.p_action_id as string);
        return {
          data: candidate ? [{
            ...candidate,
            status: 'processing',
            retry_count: candidate.retry_count ?? 0,
            claim_token: `claim-${candidate.id}`,
            lane: laneForAction(candidate.action),
          }] : null,
          error: null,
        };
      }
      if (name === 'bot_action_queue_recover_stale') {
        return { data: opts.staleFailed ?? [], error: null };
      }
      if (name === 'bot_action_queue_retry_claim') {
        return { data: [{ applied: true, disposition: 'requeued' }], error: null };
      }
      if (name === 'bot_action_queue_finish_claim') {
        return {
          data: [{
            applied: true,
            disposition: params.p_success === true ? 'completed' : 'failed',
          }],
          error: null,
        };
      }
      return { data: null, error: null };
    }),
    channel: vi.fn(() => {
      const chan: any = {
        on: vi.fn((_ev: string, filter: { event?: 'INSERT' | 'UPDATE' }, handler: (payload: { new: any }) => Promise<void>) => {
          const authoritativeHandler = async (payload: { new: any }) => {
            if (payload.new?.id) claimCandidates.set(payload.new.id, payload.new);
            await handler(payload);
          };
          if (filter.event) realtime.handlers[filter.event] = authoritativeHandler;
          if (filter.event === 'INSERT') realtime.handler = authoritativeHandler;
          return chan;
        }),
        subscribe: vi.fn((cb: Function) => { cb?.('SUBSCRIBED'); return 'subscribed'; }),
      };
      return chan;
    }),
  };
  supa.__claimOrder = claimOrder;
  supa.__inserts = inserts;
  supa.__alertUpdates = alertUpdates;
  supa.__realtime = realtime;
  supa.__failedSweepQueries = failedSweepQueries;
  return supa;
}

afterEach(() => {
  vi.clearAllMocks();
  mockDeliverReceiptDM.mockReset();
  mockDeliverReceiptDM.mockImplementation(async () => {});
});

// ── Starvation resistance: sweep claims commerce first ─────

describe('sweep lane priority', () => {
  it('claims the commerce job before a pre-existing game flood (starvation resistance)', async () => {
    // 30 game jobs enqueued BEFORE the commerce job. Under plain created_at
    // ordering the commerce row is claimed last (and with a flood deeper
    // than the batch LIMIT it would not be claimed at all). Lane-priority
    // ordering must claim it FIRST.
    const base = Date.now() - 60_000;
    const gameRows = Array.from({ length: 30 }, (_, i) => ({
      id: `game-${i}`,
      guild_id: 'guild-1',
      action: 'config_reload',
      lane: 'game',
      status: 'pending',
      payload: { section: 'all' },
      created_at: new Date(base + i).toISOString(),
      retry_count: 0,
    }));
    const commerceRow = {
      id: 'commerce-1',
      guild_id: 'guild-1',
      action: 'deliver_receipt',
      lane: 'commerce',
      status: 'pending',
      payload: {
        guild_id: 'guild-1',
        discord_id: 'user-1',
        order_id: 'order-1',
        order_number: 'ORD-001',
        product_name: 'VIP Pass',
        amount_cents: 999,
        currency: 'USD',
      },
      created_at: new Date(base + 50_000).toISOString(), // newest row
      retry_count: 0,
    };
    const guild = makeGuild();
    const supa = makeLaneSupa([...gameRows, commerceRow]);

    await startActionQueueListener(guild, supa);

    expect(supa.__claimOrder.length).toBeGreaterThan(0);
    expect(supa.__claimOrder[0]).toBe('commerce-1');
    // Every game claim happened after the commerce claim
    expect(supa.__claimOrder.indexOf('commerce-1')).toBe(0);
    expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(1);
  });

  it('falls back to an action-name lane partition when the lane column is missing', async () => {
    // A manually-migrated environment can briefly run bot code ahead of
    // migration 20260710020000. The lane-ordered query then fails outright —
    // the sweep must fall back to partitioning by action name (lane is a
    // pure function of the action type) instead of stranding the offline
    // backlog, which includes paid fulfillment rows — and the fallback must
    // still fetch commerce rows FIRST, at the query level.
    const base = Date.now() - 60_000;
    const rows = [
      {
        id: 'legacy-game-1', guild_id: 'guild-1', action: 'config_reload',
        status: 'pending', payload: { section: 'all' },
        created_at: new Date(base).toISOString(), retry_count: 0,
        // no `lane` — the column does not exist pre-migration
      },
      {
        id: 'legacy-commerce-1', guild_id: 'guild-1', action: 'deliver_receipt',
        status: 'pending',
        payload: {
          guild_id: 'guild-1', discord_id: 'user-1', order_id: 'order-1',
          order_number: 'ORD-100', product_name: 'VIP Pass',
          amount_cents: 999, currency: 'USD',
        },
        created_at: new Date(base + 1000).toISOString(), retry_count: 0,
      },
    ];
    const supa = makeLaneSupa(rows, { laneColumnMissing: true });

    await startActionQueueListener(makeGuild(), supa);

    // The lane-ordered attempt failed at least once …
    expect(supa.__failedSweepQueries.length).toBeGreaterThan(0);
    // … and the fallback still processed the entire backlog, commerce first.
    expect(supa.__claimOrder).toEqual(['legacy-commerce-1', 'legacy-game-1']);
    expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(1);
  });

  it('fallback sweep keeps commerce in the batch when the game backlog exceeds the batch limit', async () => {
    // Pre-migration environment (no lane column) AND a game backlog deeper
    // than the 1000-row sweep batch limit. A single created_at-ordered
    // capped query would fill the entire batch with the older game rows and
    // evict every commerce row — the action-name partition must keep the
    // query-level guarantee instead.
    const base = Date.now() - 120_000;
    const gameRows = Array.from({ length: 1005 }, (_, i) => ({
      id: `fb-game-${i}`, guild_id: 'guild-1', action: 'refresh_snapshot',
      status: 'pending', payload: {},
      created_at: new Date(base + i).toISOString(), retry_count: 0,
      // no `lane` — the column does not exist pre-migration
    }));
    const commerceRows = Array.from({ length: 2 }, (_, i) => ({
      id: `fb-commerce-${i}`, guild_id: 'guild-1', action: 'deliver_receipt',
      status: 'pending',
      payload: {
        guild_id: 'guild-1', discord_id: `user-${i}`, order_id: `order-${i}`,
        order_number: `ORD-80${i}`, product_name: 'VIP Pass',
        amount_cents: 999, currency: 'USD',
      },
      // Newest rows — worst case for created_at ordering.
      created_at: new Date(base + 110_000 + i).toISOString(), retry_count: 0,
    }));
    const supa = makeLaneSupa([...gameRows, ...commerceRows], { laneColumnMissing: true });

    await startActionQueueListener(makeGuild(), supa);

    expect(supa.__failedSweepQueries.length).toBeGreaterThan(0);
    // Every commerce row is in the processed set, ahead of all game rows.
    expect(supa.__claimOrder.slice(0, 2)).toEqual(['fb-commerce-0', 'fb-commerce-1']);
    expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(2);
    // The batch still holds its budget: 2 commerce + 998 game. The 7
    // leftover game rows stay 'pending' for later sweeps (the fire-and-
    // forget post-subscribe sweep may or may not have drained them yet).
    expect(supa.__claimOrder.length).toBeGreaterThanOrEqual(1000);
    expect(new Set(supa.__claimOrder).size).toBe(supa.__claimOrder.length); // no double-claims
  });
});

// ── Starvation resistance: stale recovery re-fetch ─────────

describe('stale recovery lane priority', () => {
  it('re-feeds recovered commerce rows even when a game flood exceeds the re-fetch budget', async () => {
    // The recovery RPC is uncapped: a crash during a game flood can hand
    // back MORE re-queued ids than the 1000-row re-fetch budget. With a
    // single unordered capped fetch, game rows could fill the whole batch
    // and evict every commerce row before any in-memory prioritization ran.
    // The budget must be spent on commerce ids FIRST, at the query level.
    const base = Date.now() - 120_000;
    const gameRows = Array.from({ length: 1050 }, (_, i) => ({
      id: `stale-game-${i}`, guild_id: 'guild-1', action: 'refresh_snapshot',
      lane: 'game', status: 'pending', payload: {},
      created_at: new Date(base + i).toISOString(), retry_count: 1,
    }));
    const commerceRows = Array.from({ length: 3 }, (_, i) => ({
      id: `stale-commerce-${i}`, guild_id: 'guild-1', action: 'deliver_receipt',
      lane: 'commerce', status: 'pending',
      payload: {
        guild_id: 'guild-1', discord_id: `user-${i}`, order_id: `order-${i}`,
        order_number: `ORD-90${i}`, product_name: 'VIP Pass',
        amount_cents: 999, currency: 'USD',
      },
      // Newest rows — worst case for created_at ordering.
      created_at: new Date(base + 110_000 + i).toISOString(), retry_count: 1,
    }));
    // Worst case: the RPC returns every game stub BEFORE the commerce stubs.
    const staleFailed = [
      ...gameRows.map((r) => ({
        id: r.id, action: r.action, disposition: 'requeued' as const,
      })),
      ...commerceRows.map((r) => ({
        id: r.id, action: r.action, disposition: 'requeued' as const,
      })),
    ];
    const supa = makeLaneSupa([...gameRows, ...commerceRows], { staleFailed });

    await startActionQueueListener(makeGuild(), supa);

    // Every commerce row survives the cap and is processed FIRST.
    expect(supa.__claimOrder.slice(0, 3).sort()).toEqual(
      commerceRows.map((r) => r.id).sort(),
    );
    expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(3);
    // The re-fetch budget still bounds the recovery pass (3 commerce + 997
    // game); the 53 leftover game rows are NOT lost — the lane-ordered
    // startup sweep in the same listener start picks them up.
    expect(supa.__claimOrder).toHaveLength(1053);
    expect(new Set(supa.__claimOrder).size).toBe(1053); // each row claimed exactly once
  });
});

// ── Realtime flood: per-lane concurrency budgets ───────────

describe('Realtime lane budgets', () => {
  it('dispatches staged-to-pending UPDATE releases while ignoring staged and future-backoff rows', async () => {
    const supa = makeLaneSupa([]);
    await startActionQueueListener(makeGuild(), supa);

    const updateHandler = supa.__realtime.handlers.UPDATE;
    expect(updateHandler).toBeTypeOf('function');
    const baseRow = {
      id: 'staged-release-1',
      guild_id: 'guild-1',
      action: 'deliver_receipt',
      lane: 'commerce',
      payload: {
        guild_id: 'guild-1', discord_id: 'user-1', order_id: 'order-1',
        order_number: 'ORD-STAGED', product_name: 'VIP Pass',
        amount_cents: 999, currency: 'USD',
      },
      created_at: new Date().toISOString(),
      retry_count: 0,
    };

    await updateHandler!({ new: { ...baseRow, status: 'staged' } });
    await updateHandler!({
      new: {
        ...baseRow,
        id: 'future-retry-1',
        status: 'pending',
        next_retry_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(supa.__claimOrder).toEqual([]);

    await updateHandler!({ new: { ...baseRow, status: 'pending', next_retry_at: null } });

    expect(supa.__claimOrder).toEqual(['staged-release-1']);
    expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(1);
  });

  it('a game event flood cannot consume commerce processing capacity', async () => {
    const guild = makeGuild();
    // bulk_send_dm handlers hang at members.fetch — simulates slow game jobs
    guild.members.fetch = vi.fn(() => new Promise(() => {}));
    const supa = makeLaneSupa([]);

    await startActionQueueListener(guild, supa);
    const handler = supa.__realtime.handler!;
    expect(handler).toBeTypeOf('function');

    const flood = Array.from({ length: 12 }, (_, i) =>
      handler({
        new: {
          id: `game-rt-${i}`, guild_id: 'guild-1', action: 'bulk_send_dm', lane: 'game',
          status: 'pending', payload: { member_id: `m-${i}`, message: 'hi' },
          created_at: new Date().toISOString(), retry_count: 0,
        },
      }),
    );
    await flushMicrotasks(20);

    // Only the game budget's worth of jobs was admitted (claimed + started);
    // the rest wait in-process WITHOUT claiming their rows.
    expect(guild.members.fetch).toHaveBeenCalledTimes(LANE_CONCURRENCY.game);
    expect(supa.__claimOrder).toHaveLength(LANE_CONCURRENCY.game);

    // A commerce event arriving mid-flood is processed immediately under the
    // commerce budget — the saturated game lane cannot delay it.
    await handler({
      new: {
        id: 'commerce-rt-1', guild_id: 'guild-1', action: 'deliver_receipt', lane: 'commerce',
        status: 'pending',
        payload: {
          guild_id: 'guild-1', discord_id: 'user-1', order_id: 'order-1',
          order_number: 'ORD-002', product_name: 'VIP Pass',
          amount_cents: 999, currency: 'USD',
        },
        created_at: new Date().toISOString(), retry_count: 0,
      },
    });

    expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(1);
    expect(supa.__claimOrder).toContain('commerce-rt-1');
    // The hung game flood keeps its promises pending — intentionally not awaited.
    void flood;
  });
});

// ── Per-lane pending-depth alerts ──────────────────────────

function makeDepthSupa(config: {
  counts?: Partial<Record<'commerce' | 'game', number>>;
  countError?: { message: string };
  insertError?: { code?: string; message: string } | null;
}) {
  const inserts: any[] = [];
  const alertUpdates: Array<{ row: any; filters: Record<string, unknown> }> = [];
  const supa: any = {
    from: vi.fn((table: string) => {
      if (table === 'bot_action_queue') {
        const inner: any = {};
        const eqFilters: Record<string, unknown> = {};
        inner.select = vi.fn(() => inner);
        inner.eq = vi.fn((col: string, val: unknown) => { eqFilters[col] = val; return inner; });
        inner.then = (resolve: Function) => {
          if (config.countError) return resolve({ data: null, count: null, error: config.countError });
          const lane = eqFilters.lane as 'commerce' | 'game';
          return resolve({ data: null, count: config.counts?.[lane] ?? 0, error: null });
        };
        return inner;
      }
      if (table === 'alerts') {
        const chain: any = {};
        const filters: Record<string, unknown> = {};
        chain.insert = vi.fn((row: any) => {
          inserts.push(row);
          return { then: (resolve: Function) => resolve({ data: null, error: config.insertError ?? null }) };
        });
        chain.update = vi.fn((row: any) => {
          alertUpdates.push({ row, filters });
          return chain;
        });
        chain.eq = vi.fn((col: string, val: unknown) => { filters[col] = val; return chain; });
        chain.then = (resolve: Function) => resolve({ data: null, error: null });
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
  supa.__inserts = inserts;
  supa.__alertUpdates = alertUpdates;
  return supa;
}

describe('per-lane pending-depth alerts', () => {
  it('fires a critical commerce alert above the commerce threshold', async () => {
    const supa = makeDepthSupa({
      counts: { commerce: LANE_PENDING_DEPTH_THRESHOLDS.commerce + 1, game: 0 },
    });
    await checkLanePendingDepthAlerts(makeGuild(), supa);

    const commerceAlerts = supa.__inserts.filter(
      (a: any) => a.alert_type === laneDepthAlertType('commerce'),
    );
    expect(commerceAlerts).toHaveLength(1);
    expect(commerceAlerts[0]).toMatchObject({
      guild_id: 'guild-1',
      severity: 'critical',
    });
    expect(commerceAlerts[0].metadata).toMatchObject({
      lane: 'commerce',
      depth: LANE_PENDING_DEPTH_THRESHOLDS.commerce + 1,
      threshold: LANE_PENDING_DEPTH_THRESHOLDS.commerce,
    });
    // Game lane is quiet — no game alert
    expect(supa.__inserts.some((a: any) => a.alert_type === laneDepthAlertType('game'))).toBe(false);
  });

  it('fires a warning game alert only above the game threshold', async () => {
    const atThreshold = makeDepthSupa({ counts: { commerce: 0, game: LANE_PENDING_DEPTH_THRESHOLDS.game } });
    await checkLanePendingDepthAlerts(makeGuild(), atThreshold);
    expect(atThreshold.__inserts).toHaveLength(0);

    const above = makeDepthSupa({ counts: { commerce: 0, game: LANE_PENDING_DEPTH_THRESHOLDS.game + 1 } });
    await checkLanePendingDepthAlerts(makeGuild(), above);
    const gameAlerts = above.__inserts.filter(
      (a: any) => a.alert_type === laneDepthAlertType('game'),
    );
    expect(gameAlerts).toHaveLength(1);
    expect(gameAlerts[0].severity).toBe('warning');
  });

  it('dedupes via the unique index: 23505 on insert refreshes the existing alert', async () => {
    const supa = makeDepthSupa({
      counts: { commerce: LANE_PENDING_DEPTH_THRESHOLDS.commerce + 5, game: 0 },
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    await checkLanePendingDepthAlerts(makeGuild(), supa);

    // Insert attempted (atomic dedupe — no check-then-insert race) …
    expect(supa.__inserts).toHaveLength(1);
    // … and the loser refreshed the existing unresolved alert instead.
    const refresh = supa.__alertUpdates.find(
      (u: any) => u.filters.alert_type === laneDepthAlertType('commerce') && u.filters.resolved === false,
    );
    expect(refresh).toBeDefined();
    expect(refresh!.row.metadata).toMatchObject({
      depth: LANE_PENDING_DEPTH_THRESHOLDS.commerce + 5,
    });
    expect(refresh!.row.resolved).toBeUndefined(); // refresh must not resolve it
  });

  it('auto-resolves the lane alert once the lane drains below threshold', async () => {
    const supa = makeDepthSupa({ counts: { commerce: 0, game: 0 } });
    await checkLanePendingDepthAlerts(makeGuild(), supa);

    expect(supa.__inserts).toHaveLength(0);
    for (const lane of ACTION_QUEUE_LANES) {
      const resolve = supa.__alertUpdates.find(
        (u: any) => u.filters.alert_type === laneDepthAlertType(lane) && u.filters.resolved === false,
      );
      expect(resolve).toBeDefined();
      expect(resolve!.row).toMatchObject({ resolved: true });
    }
  });

  it('neither fires nor resolves when the depth query fails', async () => {
    const supa = makeDepthSupa({ countError: { message: 'db unavailable' } });
    await checkLanePendingDepthAlerts(makeGuild(), supa);
    expect(supa.__inserts).toHaveLength(0);
    expect(supa.__alertUpdates).toHaveLength(0);
  });
});

// ── DLQ lane derivation ────────────────────────────────────
//
// The lane on action_queue_dlq rows is stamped by the DB trigger (migration
// 20260710020000), derived from `action` — which is exactly the original
// row's lane, since lane is a pure function of the action type. Code must
// NOT write the column: a code-side `lane:` would make the DLQ insert fail
// with an undefined-column error wherever the bot runs ahead of the
// migration, and these inserts are the last-resort persistence of commerce
// payloads (incl. the only copy of a paid customer's license key — PR #265).
// These tests pin that deploy-skew-safe design.

describe('SQL-owned final DLQ transitions', () => {
  it('does not duplicate a final receipt-delivery DLQ write in bot code', async () => {
    mockDeliverReceiptDM.mockRejectedValue(
      Object.assign(new Error('Cannot send messages to this user'), { code: 50007 }),
    );
    const guild = makeGuild();
    const supa = makeLaneSupa([{
      id: 'act-dlq-commerce', guild_id: 'guild-1', action: 'deliver_receipt', lane: 'commerce',
      status: 'pending',
      payload: {
        guild_id: 'guild-1', discord_id: 'user-1', order_id: 'order-1',
        order_number: 'ORD-003', product_name: 'VIP Pass', amount_cents: 999, currency: 'USD',
      },
      created_at: new Date().toISOString(), retry_count: 0,
    }]);

    await startActionQueueListener(guild, supa);

    expect(supa.__inserts['action_queue_dlq']).toBeUndefined();
  });

  it('does not duplicate a stale-recovery DLQ write in bot code', async () => {
    const guild = makeGuild();
    const supa = makeLaneSupa([], {
      staleFailed: [{
        id: 'stale-game-1',
        action: 'market_item_reconcile',
        disposition: 'failed',
      }],
      staleRow: {
        action: 'market_item_reconcile',
        payload: { user_id: 'u1', item_id: 'i1', quantity: 2 },
        error_message: 'Stale processing recovery: retry budget exhausted',
        retry_count: 5,
      },
    });

    await startActionQueueListener(guild, supa);

    expect(supa.__inserts['action_queue_dlq']).toBeUndefined();
  });
});
