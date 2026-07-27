/**
 * Finding 2 — unattributed (guild_id IS NULL) webhook events must be visible
 * and replayable, WITHOUT weakening guild scoping.
 *
 * `.eq('guild_id', guildId)` never matches NULL in SQL, so the rows that most
 * need an operator — a failed `CHECKOUT.ORDER.APPROVED` capture, and the case
 * the code itself calls catastrophic ("Customer was charged but no
 * order/entitlement was created") — were the exact rows the dashboard could
 * neither list nor replay (404).
 *
 * The authorization rule under test (see app/api/webhooks/scope.ts): an
 * unattributed row belongs to nobody, so it is exposed ONLY to a caller who is
 * the sole operator of the whole instance. Anything less certain fails closed.
 * An attributed row still belongs strictly to its own guild.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-webhook-scope';
  process.env.WEBHOOK_REPLAY_SECRET = 'test-webhook-scope-replay-secret';
});

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));

import { GET } from '@/app/api/webhooks/route';
import { POST as REPLAY } from '@/app/api/webhooks/[id]/replay/route';
import { isSoleInstanceOperator, mayAccessWebhookRow } from '@/app/api/webhooks/scope';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';

const OWNER_DISCORD_ID = '123456789012345678';
const OTHER_DISCORD_ID = '876543210987654321';
const GUILD_ID = '111111111111111111';
const OTHER_GUILD_ID = '999999999999999999';

// ── Recording Supabase double ───────────────────────────────────────────────

interface RecordedOp {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: Record<string, unknown>;
  filters: Array<{ method: string; args: unknown[] }>;
}

type Resolver = (op: RecordedOp) => { data: unknown; error: unknown; count?: number };

let ops: RecordedOp[] = [];
let resolvers: Record<string, Resolver> = {};

const CHAIN_METHODS = [
  'select', 'eq', 'is', 'in', 'neq', 'gt', 'lt', 'gte', 'lte',
  'or', 'not', 'order', 'limit', 'range', 'match', 'filter',
];

function makeSupabase() {
  const from = (table: string) => {
    const op: RecordedOp = { table, op: 'select', filters: [] };

    const resolve = () => {
      const resolver = resolvers[`${table}.${op.op}`] ?? resolvers[table];
      return resolver ? resolver(op) : { data: null, error: null };
    };

    const chain: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      chain[method] = (...args: unknown[]) => {
        if (method !== 'select') op.filters.push({ method, args });
        return chain;
      };
    }
    for (const method of ['insert', 'update', 'upsert'] as const) {
      chain[method] = (payload: Record<string, unknown>) => {
        op.op = method;
        op.payload = payload;
        return chain;
      };
    }
    chain.delete = () => { op.op = 'delete'; return chain; };

    const settle = () => { ops.push(op); return resolve(); };

    chain.maybeSingle = () => {
      const result = settle();
      const data = Array.isArray(result.data) ? result.data[0] ?? null : result.data;
      return Promise.resolve({ data, error: result.error });
    };
    chain.single = chain.maybeSingle;
    chain.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(settle()).then(onFulfilled ?? undefined, onRejected ?? undefined);

    return chain;
  };

  return { from: vi.fn(from), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

function opsFor(table: string, op?: RecordedOp['op']) {
  return ops.filter((o) => o.table === table && (op ? o.op === op : true));
}

function filterMethods(op: RecordedOp) {
  return op.filters.map((f) => `${f.method}(${JSON.stringify(f.args)})`);
}

/** Guild table contents => whether the caller is the sole instance operator. */
function withGuilds(owners: Array<string | null>) {
  resolvers['guild'] = () => ({
    data: owners.map((owner_discord_id) => ({ owner_discord_id })),
    error: null,
  });
}

const mockFetch = vi.fn();
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  ops = [];
  resolvers = {};
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabase());
  (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: OWNER_DISCORD_ID, guildId: GUILD_ID },
  });
  mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', mockFetch);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.unstubAllGlobals();
});

// ── The rule itself ─────────────────────────────────────────────────────────

describe('isSoleInstanceOperator', () => {
  it('is true when every guild in the instance has the caller as owner', async () => {
    withGuilds([OWNER_DISCORD_ID, OWNER_DISCORD_ID]);
    await expect(isSoleInstanceOperator(makeSupabase() as never, OWNER_DISCORD_ID))
      .resolves.toBe(true);
  });

  it('is false as soon as another operator exists', async () => {
    withGuilds([OWNER_DISCORD_ID, OTHER_DISCORD_ID]);
    await expect(isSoleInstanceOperator(makeSupabase() as never, OWNER_DISCORD_ID))
      .resolves.toBe(false);
  });

  it('is false when a guild has no recorded owner (cannot prove sole ownership)', async () => {
    withGuilds([OWNER_DISCORD_ID, null]);
    await expect(isSoleInstanceOperator(makeSupabase() as never, OWNER_DISCORD_ID))
      .resolves.toBe(false);
  });

  it('fails closed on a query error', async () => {
    resolvers['guild'] = () => ({ data: null, error: { message: 'boom' } });
    await expect(isSoleInstanceOperator(makeSupabase() as never, OWNER_DISCORD_ID))
      .resolves.toBe(false);
  });

  it('fails closed when there are no guilds at all', async () => {
    withGuilds([]);
    await expect(isSoleInstanceOperator(makeSupabase() as never, OWNER_DISCORD_ID))
      .resolves.toBe(false);
  });

  it('fails closed when the guild set is too large to read in one page', async () => {
    withGuilds(Array.from({ length: 1001 }, () => OWNER_DISCORD_ID));
    await expect(isSoleInstanceOperator(makeSupabase() as never, OWNER_DISCORD_ID))
      .resolves.toBe(false);
  });
});

describe('mayAccessWebhookRow', () => {
  it('never lets one guild reach another guild row, sole operator or not', () => {
    expect(mayAccessWebhookRow(OTHER_GUILD_ID, GUILD_ID, true)).toBe(false);
    expect(mayAccessWebhookRow(OTHER_GUILD_ID, GUILD_ID, false)).toBe(false);
  });

  it('allows a row that belongs to the caller guild', () => {
    expect(mayAccessWebhookRow(GUILD_ID, GUILD_ID, false)).toBe(true);
  });

  it('gates unattributed rows on sole-operator status', () => {
    expect(mayAccessWebhookRow(null, GUILD_ID, true)).toBe(true);
    expect(mayAccessWebhookRow(null, GUILD_ID, false)).toBe(false);
  });
});

// ── GET /api/webhooks ───────────────────────────────────────────────────────

describe('GET /api/webhooks scoping', () => {
  function listRequest() {
    return new Request('http://localhost/api/webhooks') as never;
  }

  it('includes unattributed rows for the sole instance operator', async () => {
    withGuilds([OWNER_DISCORD_ID]);
    resolvers['webhook_events'] = () => ({ data: [], error: null, count: 0 });

    const res = await GET(listRequest());
    expect(res.status).toBe(200);

    const query = opsFor('webhook_events', 'select')[0]!;
    expect(filterMethods(query).join(' ')).toContain(
      `or(["guild_id.eq.${GUILD_ID},guild_id.is.null"])`,
    );
  });

  it('falls back to strict guild scoping when another operator exists', async () => {
    withGuilds([OWNER_DISCORD_ID, OTHER_DISCORD_ID]);
    resolvers['webhook_events'] = () => ({ data: [], error: null, count: 0 });

    await GET(listRequest());

    const query = opsFor('webhook_events', 'select')[0]!;
    const applied = filterMethods(query).join(' ');
    expect(applied).toContain(`eq(["guild_id","${GUILD_ID}"])`);
    expect(applied).not.toContain('guild_id.is.null');
  });

  it('never widens scope to another guild', async () => {
    withGuilds([OWNER_DISCORD_ID]);
    resolvers['webhook_events'] = () => ({ data: [], error: null, count: 0 });

    await GET(listRequest());

    const applied = filterMethods(opsFor('webhook_events', 'select')[0]!).join(' ');
    expect(applied).not.toContain(OTHER_GUILD_ID);
  });
});

// ── POST /api/webhooks/[id]/replay ──────────────────────────────────────────

describe('POST /api/webhooks/[id]/replay scoping', () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  function withEvent(row: Record<string, unknown> | null) {
    resolvers['webhook_events.select'] = () => ({ data: row, error: null });
    resolvers['webhook_events.update'] = () => ({ data: { event_id: row?.event_id }, error: null });
  }

  it('replays an unattributed event for the sole instance operator', async () => {
    withGuilds([OWNER_DISCORD_ID]);
    withEvent({
      event_id: 'EVT-ORPHAN',
      guild_id: null,
      result: 'error',
      event_type: 'CHECKOUT.ORDER.APPROVED',
      payload: { event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER-1' } },
      replay_count: 0,
    });

    const res = await REPLAY(new Request('http://localhost') as never, params('EVT-ORPHAN'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replayed: true });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/paypal/webhook'),
      expect.anything(),
    );
  });

  it('claims the unattributed row with IS NULL, not a never-matching equality', async () => {
    withGuilds([OWNER_DISCORD_ID]);
    withEvent({
      event_id: 'EVT-ORPHAN-2',
      guild_id: null,
      result: 'error',
      event_type: 'CHECKOUT.ORDER.APPROVED',
      payload: {},
      replay_count: 0,
    });

    await REPLAY(new Request('http://localhost') as never, params('EVT-ORPHAN-2'));

    const claim = opsFor('webhook_events', 'update')[0]!;
    expect(filterMethods(claim).join(' ')).toContain('is(["guild_id",null])');
  });

  it('404s an unattributed event when the instance has another operator', async () => {
    withGuilds([OWNER_DISCORD_ID, OTHER_DISCORD_ID]);
    withEvent({
      event_id: 'EVT-ORPHAN-3',
      guild_id: null,
      result: 'error',
      event_type: 'CHECKOUT.ORDER.APPROVED',
      payload: {},
      replay_count: 0,
    });

    const res = await REPLAY(new Request('http://localhost') as never, params('EVT-ORPHAN-3'));

    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(opsFor('webhook_events', 'update')).toHaveLength(0);
  });

  it('404s another guild event even for the sole instance operator', async () => {
    withGuilds([OWNER_DISCORD_ID]);
    withEvent({
      event_id: 'EVT-OTHER-GUILD',
      guild_id: OTHER_GUILD_ID,
      result: 'error',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      payload: {},
      replay_count: 0,
    });

    const res = await REPLAY(new Request('http://localhost') as never, params('EVT-OTHER-GUILD'));

    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still replays a normally-attributed event for its own guild', async () => {
    withGuilds([OWNER_DISCORD_ID, OTHER_DISCORD_ID]);
    withEvent({
      event_id: 'EVT-MINE',
      guild_id: GUILD_ID,
      result: 'error',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      payload: {},
      replay_count: 0,
    });

    const res = await REPLAY(new Request('http://localhost') as never, params('EVT-MINE'));

    expect(res.status).toBe(200);
    const claim = opsFor('webhook_events', 'update')[0]!;
    expect(filterMethods(claim).join(' ')).toContain(`eq(["guild_id","${GUILD_ID}"])`);
  });

  it('404s a genuinely missing event without probing guild scope', async () => {
    withGuilds([OWNER_DISCORD_ID]);
    withEvent(null);

    const res = await REPLAY(new Request('http://localhost') as never, params('EVT-NOPE'));

    expect(res.status).toBe(404);
    expect(opsFor('guild')).toHaveLength(0);
  });

  it('raises an operator alert when the replay itself fails', async () => {
    withGuilds([OWNER_DISCORD_ID]);
    withEvent({
      event_id: 'EVT-REPLAY-FAIL',
      guild_id: GUILD_ID,
      result: 'error',
      event_type: 'CHECKOUT.ORDER.APPROVED',
      payload: {},
      replay_count: 0,
    });
    resolvers['alerts.update'] = () => ({ data: [], error: null });
    mockFetch.mockResolvedValue(new Response('{}', { status: 500 }));

    await REPLAY(new Request('http://localhost') as never, params('EVT-REPLAY-FAIL'));

    const alertInsert = opsFor('alerts', 'insert')[0];
    expect(alertInsert).toBeDefined();
    expect(alertInsert!.payload).toMatchObject({
      guild_id: GUILD_ID,
      alert_type: 'paypal_webhook_processing_error',
    });
  });
});
