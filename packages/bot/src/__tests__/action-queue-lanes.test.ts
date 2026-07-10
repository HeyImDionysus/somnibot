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
 * - sweep falls back to legacy created_at ordering if the lane-ordered query
 *   fails (pre-migration environment), instead of stranding the backlog
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
    'deliver_receipt',
    'revoke_roles',
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

  it('mirrors the SQL classification list in migration 20260710020000 exactly', () => {
    // The DB trigger (bot_action_queue_lane_for_action) is the authoritative
    // classifier; COMMERCE_LANE_ACTIONS is the TypeScript mirror used for
    // in-process scheduling and legacy-row fallback. If the two lists drift,
    // a commerce action could be prioritized in one layer but not the other —
    // pin them to each other by parsing the migration's IN (...) list.
    const testDir = dirname(fileURLToPath(import.meta.url));
    const migrationPath = resolve(
      testDir,
      '../../../supabase/migrations/20260710020000_bot_action_queue_lanes.sql',
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
 * Emulates the DB for sweep queries: applies the requested ORDER BY columns
 * (lane, created_at) and LIMIT to the seeded rowset, exactly like Postgres
 * would. If the implementation does NOT ask for lane ordering, rows come back
 * in created_at order — which starves the newer commerce row behind the
 * older game flood. Head/count queries (per-lane depth checks) are answered
 * from the seeded rows without consuming the sweep batch.
 */
function makeLaneSupa(seedRows: any[] = [], opts: {
  staleFailed?: Array<{ id: string; action: string; was_failed: boolean }>;
  staleRow?: Record<string, unknown> | null;
  /** Simulate a pre-migration DB: any lane-ordered query errors. */
  laneColumnMissing?: boolean;
} = {}) {
  const claimOrder: string[] = [];
  const inserts: Record<string, any[]> = {};
  const alertUpdates: any[] = [];
  const failedSweepQueries: string[][] = [];
  let sweepServed = false;
  const realtime: { handler: ((payload: { new: any }) => Promise<void>) | null } = { handler: null };

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
          const orderCols: string[] = [];
          let limitN = Infinity;
          inner.eq = vi.fn((col: string, val: unknown) => { eqFilters[col] = val; return inner; });
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
            if (sweepServed) return resolve({ data: [], error: null });
            sweepServed = true;
            let rows = [...seedRows];
            if (orderCols[0] === 'lane') {
              rows.sort((a, b) =>
                a.lane === b.lane
                  ? a.created_at.localeCompare(b.created_at)
                  : a.lane.localeCompare(b.lane));
            } else {
              rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
            }
            rows = rows.slice(0, limitN);
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
        return { data: [{ id: params.p_action_id }], error: null };
      }
      if (name === 'bot_action_queue_recover_stale') {
        return { data: opts.staleFailed ?? [], error: null };
      }
      return { data: null, error: null };
    }),
    channel: vi.fn(() => {
      const chan: any = {
        on: vi.fn((_ev: string, _filter: unknown, handler: (payload: { new: any }) => Promise<void>) => {
          realtime.handler = handler;
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

  it('falls back to the legacy created_at sweep when the lane column is missing', async () => {
    // A manually-migrated environment can briefly run bot code ahead of
    // migration 20260710020000. The lane-ordered query then fails outright —
    // the sweep must fall back to the legacy created_at order (rows still
    // classified in-process via laneForAction) instead of stranding the
    // offline backlog, which includes paid fulfillment rows.
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
    // … and the fallback still processed the entire backlog.
    expect(supa.__claimOrder).toEqual(['legacy-game-1', 'legacy-commerce-1']);
    expect(mockDeliverReceiptDM).toHaveBeenCalledTimes(1);
  });
});

// ── Realtime flood: per-lane concurrency budgets ───────────

describe('Realtime lane budgets', () => {
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

describe('DLQ lane derivation (trigger-stamped, never written from code)', () => {
  it('dead-letters a final receipt-delivery failure without writing the lane column', async () => {
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

    const dlqRows = supa.__inserts['action_queue_dlq'] ?? [];
    expect(dlqRows).toContainEqual(
      expect.objectContaining({ action: 'deliver_receipt', original_id: 'act-dlq-commerce' }),
    );
    for (const row of dlqRows) {
      expect(row).not.toHaveProperty('lane');
    }
  });

  it('dead-letters stale-recovery failures without writing the lane column', async () => {
    const guild = makeGuild();
    const supa = makeLaneSupa([], {
      staleFailed: [{ id: 'stale-game-1', action: 'market_item_reconcile', was_failed: true }],
      staleRow: {
        action: 'market_item_reconcile',
        payload: { user_id: 'u1', item_id: 'i1', quantity: 2 },
        error_message: 'Stale processing recovery: retry budget exhausted',
        retry_count: 5,
      },
    });

    await startActionQueueListener(guild, supa);

    const dlqRows = supa.__inserts['action_queue_dlq'] ?? [];
    expect(dlqRows).toContainEqual(
      expect.objectContaining({ action: 'market_item_reconcile', original_id: 'stale-game-1' }),
    );
    for (const row of dlqRows) {
      expect(row).not.toHaveProperty('lane');
    }
  });
});
