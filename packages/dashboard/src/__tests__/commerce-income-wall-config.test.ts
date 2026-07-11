/**
 * Canonical commerce/role-income wall regression tests.
 *
 * These exercise the pure post-write evaluator and every dashboard mutation
 * surface against an interpreting PostgREST fake. The fake applies guild and
 * cursor filters, so assertions cover behavior rather than query spelling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/rbac', () => ({
  requirePermission: vi.fn(),
  authErrorResponse: vi.fn(),
}));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn(),
  getPayPalToken: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { POST as productsPOST, PUT as productsPUT } from '@/app/api/store/products/route';
import {
  DELETE as plansDELETE,
  POST as plansPOST,
  PUT as plansPUT,
} from '@/app/api/store/plans/route';
import { POST as roleIncomePOST } from '@/app/api/economy/role-income/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { requirePermission } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { getPayPalRuntimeConfig, getPayPalToken } from '@/lib/paypal';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  evaluateEffectivePostWriteProduct,
  fetchAllRows,
  selectCheapestActivePayPalPlan,
} from '@/lib/api/commerce-income-wall';
import { buildRequest, mockAuthSuccess, mockRateLimitPass } from './helpers';

const GUILD = 'guild-1';
const FOREIGN_GUILD = 'guild-2';
const ROLE = '111111111111111111';
const PRODUCT_ID = '00000000-0000-0000-0000-00000000000a';
const DESTINATION_ID = '00000000-0000-0000-0000-00000000000c';
const PLAN_ID = '00000000-0000-0000-0000-00000000000b';
const SECOND_PLAN_ID = '00000000-0000-0000-0000-00000000000d';

type Row = Record<string, unknown>;
type DbError = { message: string; code?: string };

interface TableConfig {
  rows?: Row[];
  readError?: DbError;
  nullData?: boolean;
  writeError?: DbError;
  writeData?: unknown;
}

interface RecordedWrite {
  op: 'insert' | 'update' | 'upsert' | 'delete';
  payload: unknown;
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function createFakeSupabase(tables: Record<string, TableConfig>) {
  const writes: Record<string, RecordedWrite[]> = {};
  const cursors: Record<string, string[]> = {};

  function from(table: string) {
    const config = tables[table] ?? {};
    let op: RecordedWrite['op'] | 'read' = 'read';
    let payload: unknown;
    let limitCount: number | null = null;
    const filters: Array<(row: Row) => boolean> = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];

    const record = (nextOp: RecordedWrite['op'], nextPayload: unknown) => {
      op = nextOp;
      payload = nextPayload;
      (writes[table] ??= []).push({ op: nextOp, payload: nextPayload });
    };

    const result = () => {
      if (op !== 'read') {
        return {
          data:
            config.writeData ??
            (op === 'delete'
              ? null
              : { id: 'written-row', ...(payload as Record<string, unknown>) }),
          error: config.writeError ?? null,
        };
      }
      if (config.readError) return { data: null, error: config.readError };
      if (config.nullData) return { data: null, error: null };

      let rows = [...(config.rows ?? [])].filter((row) =>
        filters.every((filter) => filter(row)),
      );
      if (orders.length > 0) {
        rows.sort((left, right) => {
          for (const order of orders) {
            const compared = compareValues(left[order.column], right[order.column]);
            if (compared !== 0) return order.ascending ? compared : -compared;
          }
          return 0;
        });
      }
      if (limitCount !== null) rows = rows.slice(0, limitCount);
      return { data: rows, error: null };
    };

    const query: Record<string, unknown> = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return query;
      },
      neq: (column: string, value: unknown) => {
        filters.push((row) => row[column] !== value);
        return query;
      },
      gt: (column: string, value: unknown) => {
        filters.push((row) => compareValues(row[column], value) > 0);
        if (column === 'id') (cursors[table] ??= []).push(String(value));
        return query;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return query;
      },
      overlaps: (column: string, values: unknown[]) => {
        filters.push((row) => {
          const actual = row[column];
          return Array.isArray(actual) && actual.some((value) => values.includes(value));
        });
        return query;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return query;
      },
      order: (column: string, options: { ascending?: boolean } = {}) => {
        orders.push({ column, ascending: options.ascending !== false });
        return query;
      },
      limit: (count: number) => {
        limitCount = count;
        return query;
      },
      insert: (value: unknown) => {
        record('insert', value);
        return query;
      },
      update: (value: unknown) => {
        record('update', value);
        return query;
      },
      upsert: (value: unknown) => {
        record('upsert', value);
        return query;
      },
      delete: () => {
        record('delete', null);
        return query;
      },
      maybeSingle: async () => {
        const resolved = result();
        return {
          ...resolved,
          data: Array.isArray(resolved.data) ? resolved.data[0] ?? null : resolved.data,
        };
      },
      single: async () => {
        const resolved = result();
        return {
          ...resolved,
          data: Array.isArray(resolved.data) ? resolved.data[0] ?? null : resolved.data,
        };
      },
      then: (
        onFulfilled: (value: ReturnType<typeof result>) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(result()).then(onFulfilled, onRejected),
    };
    return query;
  }

  return { from, _writes: writes, _cursors: cursors };
}

function product(overrides: Row = {}): Row {
  return {
    id: PRODUCT_ID,
    guild_id: GUILD,
    type: 'subscription',
    active: true,
    price_cents: 1000,
    granted_role_ids: [],
    metadata: {},
    ...overrides,
  };
}

function plan(overrides: Row = {}): Row {
  return {
    id: PLAN_ID,
    guild_id: GUILD,
    product_id: PRODUCT_ID,
    active: true,
    price_cents: 1000,
    paypal_plan_id: 'P-1',
    ...overrides,
  };
}

function income(overrides: Row = {}): Row {
  return {
    id: '00000000-0000-0000-0000-000000000101',
    guild_id: GUILD,
    role_id: ROLE,
    amount: 100,
    ...overrides,
  };
}

function temporaryRole(overrides: Row = {}): Row {
  return {
    id: '00000000-0000-0000-0000-000000000201',
    guild_id: GUILD,
    product_id: PRODUCT_ID,
    role_id: ROLE,
    duration_seconds: 3600,
    ...overrides,
  };
}

function uuidAt(index: number): string {
  return `00000000-0000-0000-0001-${String(index).padStart(12, '0')}`;
}

function useFake(tables: Record<string, TableConfig>) {
  const fake = createFakeSupabase(tables);
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(fake);
  return fake;
}

function productBody(overrides: Row = {}) {
  return {
    name: 'Product',
    description: 'Description',
    type: 'one_time',
    delivery_type: 'access_pass',
    price_cents: 1000,
    currency: 'USD',
    granted_role_ids: [],
    granted_channel_ids: [],
    active: true,
    ...overrides,
  };
}

function planBody(overrides: Row = {}) {
  return {
    product_id: PRODUCT_ID,
    name: 'Monthly',
    interval_unit: 'MONTH',
    interval_count: 1,
    price_cents: 1000,
    active: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: GUILD });
  (requirePermission as ReturnType<typeof vi.fn>).mockResolvedValue({ guildId: GUILD });
  (notifyBot as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (getPayPalRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
    apiBase: 'https://api-m.sandbox.paypal.com',
    clientId: 'client',
    clientSecret: 'secret',
    webhookId: 'webhook',
    webhookUrl: '',
    sandbox: true,
    sources: {},
  });
  (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue('token');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'PAYPAL-ID' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pure effective post-write truth table', () => {
  it('evaluates one-time products from active and price', () => {
    expect(evaluateEffectivePostWriteProduct({
      type: 'one_time',
      active: true,
      price_cents: 1,
      granted_role_ids: [ROLE],
    }, [], []).buyable).toBe(true);
    expect(evaluateEffectivePostWriteProduct({
      type: 'one_time',
      active: true,
      price_cents: 0,
      granted_role_ids: [ROLE],
    }, [], []).buyable).toBe(false);
    expect(evaluateEffectivePostWriteProduct({
      type: 'one_time',
      active: false,
      price_cents: 1000,
      granted_role_ids: [ROLE],
    }, [], []).buyable).toBe(false);
  });

  it('unions canonical and typed temporary role vectors exactly once', () => {
    const evaluation = evaluateEffectivePostWriteProduct({
      type: 'one_time',
      active: true,
      price_cents: 1,
      granted_role_ids: [ROLE],
    }, [], [ROLE, '222222222222222222']);
    expect(evaluation.grantedRoleIds).toEqual([ROLE, '222222222222222222']);
    expect(() => evaluateEffectivePostWriteProduct({
      type: 'one_time',
      active: true,
      price_cents: 1,
      granted_role_ids: [],
    }, [], [null] as never)).toThrow(/temporary role ids/);
  });

  it('filters to active nonblank PayPal plans and breaks price ties by id', () => {
    const selected = selectCheapestActivePayPalPlan([
      { id: 'z', active: true, price_cents: 0, paypal_plan_id: null },
      { id: 'c', active: false, price_cents: 1, paypal_plan_id: 'P-C' },
      { id: 'b', active: true, price_cents: 5, paypal_plan_id: 'P-B' },
      { id: 'a', active: true, price_cents: 5, paypal_plan_id: 'P-A' },
      { id: 'd', active: true, price_cents: 1, paypal_plan_id: '   ' },
    ]);
    expect(selected?.id).toBe('a');
  });

  it('fails closed on unknown, missing, or null state', () => {
    expect(() => evaluateEffectivePostWriteProduct({
      type: 'future',
      active: true,
      price_cents: 1,
      granted_role_ids: [],
    }, [], [])).toThrow(/unknown type/);
    expect(() => evaluateEffectivePostWriteProduct({
      type: 'subscription',
      active: null,
      price_cents: 1,
      granted_role_ids: [],
    } as never, [], [])).toThrow(/active flag/);
    expect(() => selectCheapestActivePayPalPlan([
      { id: 'a', active: undefined, price_cents: 1, paypal_plan_id: 'P' } as never,
    ])).toThrow(/active flag/);
  });
});

describe('reserved legacy role metadata', () => {
  it.each(['grant_role_id', 'historical_grant_role_ids', 'role_duration_hours'])(
    'POST rejects metadata.%s with canonical migration guidance',
    async (key) => {
      useFake({});
      const res = await productsPOST(buildRequest('/api/store/products', {
        method: 'POST',
        body: productBody({ type: 'free', price_cents: 0, metadata: { [key]: ROLE } }),
      }) as never);
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.details).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: `metadata.${key}`,
          message: expect.stringContaining('granted_role_ids'),
        }),
      ]));
    },
  );

  it.each(['grant_role_id', 'historical_grant_role_ids', 'role_duration_hours'])(
    'PUT rejects metadata.%s with canonical migration guidance',
    async (key) => {
      useFake({});
      const res = await productsPUT(buildRequest('/api/store/products', {
        method: 'PUT',
        body: { id: PRODUCT_ID, metadata: { [key]: ROLE } },
      }) as never);
      expect(res.status).toBe(400);
    },
  );
});

describe('product mutations', () => {
  it('models generated PayPal ids before POST, including a zero-price explicit plan', async () => {
    const fake = useFake({ economy_role_income: { rows: [income()] } });
    const res = await productsPOST(buildRequest('/api/store/products', {
      method: 'POST',
      body: productBody({
        type: 'subscription',
        price_cents: 1000,
        granted_role_ids: [ROLE],
        plans: [{ name: 'Zero', interval_unit: 'MONTH', price_cents: 0 }],
      }),
    }) as never);
    expect(res.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    expect(fake._writes.products ?? []).toHaveLength(0);
  });

  it('allows a subscription whose complete generated plan set has no PayPal path', async () => {
    const fake = useFake({
      products: { rows: [] },
      economy_role_income: { rows: [income()] },
    });
    const res = await productsPOST(buildRequest('/api/store/products', {
      method: 'POST',
      body: productBody({
        type: 'subscription',
        price_cents: 0,
        granted_role_ids: [ROLE],
        plans: [{ name: 'Zero', interval_unit: 'MONTH', price_cents: 0 }],
      }),
    }) as never);
    expect(res.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(fake._writes.products?.[0]?.op).toBe('insert');
  });

  it('merges stored and submitted PUT state before checking', async () => {
    const fake = useFake({
      products: {
        rows: [product({
          type: 'one_time',
          active: false,
          price_cents: 1000,
          granted_role_ids: [ROLE],
        })],
      },
      economy_role_income: { rows: [income()] },
    });
    const res = await productsPUT(buildRequest('/api/store/products', {
      method: 'PUT',
      body: { id: PRODUCT_ID, active: true },
    }) as never);
    expect(res.status).toBe(409);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });

  it('includes typed temporary roles when a product update opens the purchase path', async () => {
    const fake = useFake({
      products: {
        rows: [product({
          type: 'one_time',
          active: false,
          price_cents: 1000,
          granted_role_ids: [],
        })],
      },
      commerce_product_temp_role_config: { rows: [temporaryRole()] },
      economy_role_income: { rows: [income()] },
    });
    const res = await productsPUT(buildRequest('/api/store/products', {
      method: 'PUT',
      body: { id: PRODUCT_ID, active: true },
    }) as never);
    expect(res.status).toBe(409);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });

  it('fails closed when a required stored product field is null', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', active: null })] },
    });
    const res = await productsPUT(buildRequest('/api/store/products', {
      method: 'PUT',
      body: { id: PRODUCT_ID, price_cents: 2000 },
    }) as never);
    expect(res.status).toBe(500);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });

  it('keeps the precheck guild-scoped', async () => {
    const fake = useFake({
      products: {
        rows: [product({ type: 'one_time', active: false, granted_role_ids: [ROLE] })],
      },
      economy_role_income: {
        rows: [income({ guild_id: FOREIGN_GUILD })],
      },
    });
    const res = await productsPUT(buildRequest('/api/store/products', {
      method: 'PUT',
      body: { id: PRODUCT_ID, active: true },
    }) as never);
    expect(res.status).toBe(200);
    expect(fake._writes.products?.[0]?.op).toBe('update');
  });

  it.each([
    [{ code: 'P0001', message: 'COMMERCE_INCOME_WALL_CONFLICT: race' }, 409],
    [{ code: 'P0001', message: 'some other trigger failure' }, 500],
    [{ code: 'P0001', message: 'wrapped COMMERCE_INCOME_WALL_CONFLICT' }, 500],
    [{ code: '23505', message: 'COMMERCE_INCOME_WALL_CONFLICT lookalike' }, 500],
  ])('maps only the exact trigger conflict on product writes', async (writeError, status) => {
    useFake({ products: { writeError } });
    const res = await productsPUT(buildRequest('/api/store/products', {
      method: 'PUT',
      body: { id: PRODUCT_ID, name: 'Renamed' },
    }) as never);
    expect(res.status).toBe(status);
  });
});

describe('plan mutations use complete source and destination plan sets', () => {
  it('POST blocks when the new plan opens a typed temporary-role purchase path', async () => {
    const fake = useFake({
      products: { rows: [product({ granted_role_ids: [] })] },
      plans: { rows: [plan({ paypal_plan_id: null })] },
      commerce_product_temp_role_config: { rows: [temporaryRole()] },
      economy_role_income: { rows: [income()] },
    });
    const res = await plansPOST(buildRequest('/api/store/plans', {
      method: 'POST',
      body: planBody({ paypal_plan_id: 'P-NEW' }),
    }) as never);
    expect(res.status).toBe(409);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('POST also sees an already-chargeable sibling plan', async () => {
    const fake = useFake({
      products: { rows: [product({ granted_role_ids: [ROLE] })] },
      plans: { rows: [plan()] },
      economy_role_income: { rows: [income()] },
    });
    const res = await plansPOST(buildRequest('/api/store/plans', {
      method: 'POST',
      body: planBody({ active: false, paypal_plan_id: null }),
    }) as never);
    expect(res.status).toBe(409);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('PUT deactivation blocks while a chargeable sibling remains', async () => {
    const fake = useFake({
      products: { rows: [product({ granted_role_ids: [ROLE] })] },
      plans: {
        rows: [
          plan(),
          plan({ id: SECOND_PLAN_ID, price_cents: 2000, paypal_plan_id: 'P-2' }),
        ],
      },
      economy_role_income: { rows: [income()] },
    });
    const res = await plansPUT(buildRequest('/api/store/plans', {
      method: 'PUT',
      body: { id: PLAN_ID, active: false },
    }) as never);
    expect(res.status).toBe(409);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('PUT deactivation is allowed when it closes the only purchase path', async () => {
    const fake = useFake({
      products: { rows: [product({ granted_role_ids: [ROLE] })] },
      plans: { rows: [plan()] },
      economy_role_income: { rows: [income()] },
    });
    const res = await plansPUT(buildRequest('/api/store/plans', {
      method: 'PUT',
      body: { id: PLAN_ID, active: false },
    }) as never);
    expect(res.status).toBe(200);
    expect(fake._writes.plans?.[0]?.op).toBe('update');
  });

  it('PUT moving a plan checks the source typed temporary-role post-write set', async () => {
    const fake = useFake({
      products: {
        rows: [
          product({ granted_role_ids: [] }),
          product({ id: DESTINATION_ID, granted_role_ids: [] }),
        ],
      },
      commerce_product_temp_role_config: { rows: [temporaryRole()] },
      plans: {
        rows: [
          plan(),
          plan({ id: SECOND_PLAN_ID, price_cents: 2000, paypal_plan_id: 'P-2' }),
        ],
      },
      economy_role_income: { rows: [income()] },
    });
    const res = await plansPUT(buildRequest('/api/store/plans', {
      method: 'PUT',
      body: { id: PLAN_ID, product_id: DESTINATION_ID },
    }) as never);
    expect(res.status).toBe(409);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('PUT moving a plan checks the destination typed temporary-role post-write set', async () => {
    const fake = useFake({
      products: {
        rows: [
          product({ granted_role_ids: [] }),
          product({ id: DESTINATION_ID, granted_role_ids: [] }),
        ],
      },
      commerce_product_temp_role_config: {
        rows: [temporaryRole({ product_id: DESTINATION_ID })],
      },
      plans: { rows: [plan()] },
      economy_role_income: { rows: [income()] },
    });
    const res = await plansPUT(buildRequest('/api/store/plans', {
      method: 'PUT',
      body: { id: PLAN_ID, product_id: DESTINATION_ID },
    }) as never);
    expect(res.status).toBe(409);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('DELETE allows removing the only chargeable plan', async () => {
    const fake = useFake({
      products: { rows: [product({ granted_role_ids: [ROLE] })] },
      plans: { rows: [plan()] },
      economy_role_income: { rows: [income()] },
    });
    const res = await plansDELETE(buildRequest('/api/store/plans', {
      method: 'DELETE',
      searchParams: { id: PLAN_ID },
    }) as never);
    expect(res.status).toBe(200);
    expect(fake._writes.plans?.[0]?.op).toBe('delete');
  });

  it('DELETE blocks while another chargeable plan remains', async () => {
    const fake = useFake({
      products: { rows: [product({ granted_role_ids: [ROLE] })] },
      plans: {
        rows: [
          plan(),
          plan({ id: SECOND_PLAN_ID, paypal_plan_id: 'P-2' }),
        ],
      },
      economy_role_income: { rows: [income()] },
    });
    const res = await plansDELETE(buildRequest('/api/store/plans', {
      method: 'DELETE',
      searchParams: { id: PLAN_ID },
    }) as never);
    expect(res.status).toBe(409);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('fails closed on malformed plan rows', async () => {
    const fake = useFake({
      products: { rows: [product()] },
      plans: { rows: [plan({ active: null })] },
    });
    const res = await plansPUT(buildRequest('/api/store/plans', {
      method: 'PUT',
      body: { id: PLAN_ID, name: 'Renamed' },
    }) as never);
    expect(res.status).toBe(500);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('404s a foreign-guild destination and never updates', async () => {
    const fake = useFake({
      products: {
        rows: [
          product({ granted_role_ids: [] }),
          product({ id: DESTINATION_ID, guild_id: FOREIGN_GUILD }),
        ],
      },
      plans: { rows: [plan()] },
    });
    const res = await plansPUT(buildRequest('/api/store/plans', {
      method: 'PUT',
      body: { id: PLAN_ID, product_id: DESTINATION_ID },
    }) as never);
    expect(res.status).toBe(404);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('maps the exact deferred-trigger conflict on a plan write', async () => {
    useFake({
      products: { rows: [product({ granted_role_ids: [ROLE] })] },
      plans: {
        rows: [plan()],
        writeError: {
          code: 'P0001',
          message: 'COMMERCE_INCOME_WALL_CONFLICT: concurrent insert',
        },
      },
      economy_role_income: { rows: [income()] },
    });
    const res = await plansDELETE(buildRequest('/api/store/plans', {
      method: 'DELETE',
      searchParams: { id: PLAN_ID },
    }) as never);
    expect(res.status).toBe(409);
  });
});

describe('income-side wall, keysets, and trigger mapping', () => {
  it('ignores legacy metadata and uses canonical granted_role_ids only', async () => {
    const fake = useFake({
      products: {
        rows: [product({
          type: 'one_time',
          metadata: { grant_role_id: ROLE },
          granted_role_ids: [],
        })],
      },
      economy_role_income: { rows: [] },
    });
    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 100, interval_minutes: 60 },
    }) as never);
    expect(res.status).toBe(200);
    expect(fake._writes.economy_role_income?.[0]?.op).toBe('upsert');
  });

  it('blocks income for a role sold only through typed temporary config', async () => {
    const fake = useFake({
      products: {
        rows: [product({ type: 'one_time', granted_role_ids: [] })],
      },
      commerce_product_temp_role_config: { rows: [temporaryRole()] },
      economy_role_income: { rows: [] },
    });
    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 100, interval_minutes: 60 },
    }) as never);
    expect(res.status).toBe(409);
    expect(fake._writes.economy_role_income ?? []).toHaveLength(0);
  });

  it('finds a typed temporary role after the first 1,000-row cursor page', async () => {
    const fillers = Array.from({ length: 1000 }, (_, index) => temporaryRole({
      id: uuidAt(index + 1),
      role_id: String(700_000_000_000_000_000n + BigInt(index)),
    }));
    const target = temporaryRole({ id: uuidAt(1001) });
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', granted_role_ids: [] })] },
      commerce_product_temp_role_config: { rows: [...fillers, target] },
      economy_role_income: { rows: [] },
    });
    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 100, interval_minutes: 60 },
    }) as never);
    expect(res.status).toBe(409);
    expect(fake._cursors.commerce_product_temp_role_config).toContain(uuidAt(1000));
    expect(fake._writes.economy_role_income ?? []).toHaveLength(0);
  });

  it.each([
    { readError: { message: 'temporary config unavailable' } },
    { rows: [temporaryRole({ product_id: null })] },
  ])('fails closed on temporary-role scan errors or malformed rows', async (config) => {
    const fake = useFake({
      products: { rows: [] },
      commerce_product_temp_role_config: config as TableConfig,
      economy_role_income: { rows: [] },
    });
    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 100, interval_minutes: 60 },
    }) as never);
    expect(res.status).toBe(500);
    expect(fake._writes.economy_role_income ?? []).toHaveLength(0);
  });

  it('does not let a foreign-guild typed temporary role block the caller guild', async () => {
    const fake = useFake({
      products: { rows: [] },
      commerce_product_temp_role_config: {
        rows: [temporaryRole({ guild_id: FOREIGN_GUILD })],
      },
      economy_role_income: { rows: [] },
    });
    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 100, interval_minutes: 60 },
    }) as never);
    expect(res.status).toBe(200);
    expect(fake._writes.economy_role_income?.[0]?.op).toBe('upsert');
  });

  it('finds a buyable canonical product after the first 1,000-row cursor page', async () => {
    const fillers = Array.from({ length: 1000 }, (_, index) =>
      product({
        id: uuidAt(index + 1),
        type: 'one_time',
        active: false,
        granted_role_ids: [ROLE],
      }));
    const target = product({
      id: uuidAt(1001),
      type: 'one_time',
      active: true,
      price_cents: 1000,
      granted_role_ids: [ROLE],
    });
    const fake = useFake({
      products: { rows: [...fillers, target] },
      economy_role_income: { rows: [] },
    });
    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 100, interval_minutes: 60 },
    }) as never);
    expect(res.status).toBe(409);
    expect(fake._cursors.products).toContain(uuidAt(1000));
    expect(fake._writes.economy_role_income ?? []).toHaveLength(0);
  });

  it('does not let a foreign guild product block the caller guild', async () => {
    const fake = useFake({
      products: {
        rows: [product({
          guild_id: FOREIGN_GUILD,
          type: 'one_time',
          granted_role_ids: [ROLE],
        })],
      },
      economy_role_income: { rows: [] },
    });
    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 100, interval_minutes: 60 },
    }) as never);
    expect(res.status).toBe(200);
    expect(fake._writes.economy_role_income?.[0]?.op).toBe('upsert');
  });

  it('fetchAllRows uses id cursors and fails closed on null data', async () => {
    const fake = createFakeSupabase({
      scan: {
        rows: Array.from({ length: 5 }, (_, index) => ({ id: uuidAt(index + 1) })),
      },
    });
    const rows = await fetchAllRows(
      () => fake.from('scan') as never,
      'scan failed',
      2,
    );
    expect(rows).toHaveLength(5);
    expect(fake._cursors.scan).toEqual([uuidAt(2), uuidAt(4)]);

    const nullFake = createFakeSupabase({ scan: { nullData: true } });
    await expect(fetchAllRows(
      () => nullFake.from('scan') as never,
      'scan failed',
      2,
    )).rejects.toThrow(/returned no data/);
  });

  it.each([
    [{ code: 'P0001', message: 'COMMERCE_INCOME_WALL_CONFLICT: race' }, 409],
    [{ code: 'P0001', message: 'unrelated trigger failure' }, 500],
    [{ code: 'P0001', message: 'wrapped COMMERCE_INCOME_WALL_CONFLICT' }, 500],
    [{ code: '23505', message: 'COMMERCE_INCOME_WALL_CONFLICT lookalike' }, 500],
  ])('maps only the exact trigger conflict on role-income upsert', async (writeError, status) => {
    useFake({
      products: { rows: [] },
      economy_role_income: { rows: [], writeError },
    });
    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 100, interval_minutes: 60 },
    }) as never);
    expect(res.status).toBe(status);
  });
});
