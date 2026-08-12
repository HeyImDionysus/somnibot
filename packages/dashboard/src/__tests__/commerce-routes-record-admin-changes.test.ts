/**
 * Wiring proof: the commerce, licensing and fraud routes record an admin change.
 *
 * `lib/admin-changes` has its own unit tests, but those prove the RECORDER
 * works — not that any route calls it. That gap matters more here than
 * anywhere else in the dashboard, because `recordAdminChange` deliberately
 * swallows every failure (the mutation it describes has already committed, so
 * bookkeeping must never fail a save). A route that forgot to call it, or
 * called it with the wrong guild, actor or before-state, would leave the Admin
 * Changes page silently blind to every store, refund, entitlement and license
 * action — and every existing route test would still pass.
 *
 * Each handler below is therefore driven end-to-end with its real code and
 * asserted on the recorder call: right guild, right actor, an honest sentence,
 * and — the part that matters most on this surface — honest UNDOABILITY.
 *
 * Two things are pinned deliberately and repeatedly:
 *   1. A failed mutation records NOTHING. A change history that lists writes
 *      which never landed is worse than an empty one.
 *   2. Nothing that moves real money is undoable. See
 *      `orders-refund-not-undoable.test.ts` for the end-to-end guard on that.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/commerce-audit', () => ({
  writeCommerceAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rbac')>()),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/api/commerce-income-wall', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/commerce-income-wall')>()),
  loadProductPlans: vi.fn(),
  loadProductTemporaryRoleIds: vi.fn(),
  evaluateEffectivePostWriteProduct: vi.fn(),
  assertProductRolesNotIncomeEarning: vi.fn(),
}));
// Only the three entry points are stubbed; `undoByRestoring`,
// `describeSettingChange` and `humanizeColumn` stay real, so the undo payloads
// asserted below are the ones the routes really build.
vi.mock('@/lib/admin-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin-changes')>()),
  recordAdminChange: vi.fn().mockResolvedValue(undefined),
  recordCrudChange: vi.fn().mockResolvedValue(undefined),
  readRowBefore: vi.fn().mockResolvedValue(undefined),
}));

import { requireGuildOwner } from '@/lib/api/require-owner';
import { requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { recordAdminChange, recordCrudChange, readRowBefore } from '@/lib/admin-changes';
import { validateUndoPayload } from '@/lib/api/undo-allowlist';
import {
  assertProductRolesNotIncomeEarning,
  evaluateEffectivePostWriteProduct,
  loadProductPlans,
  loadProductTemporaryRoleIds,
} from '@/lib/api/commerce-income-wall';

const GUILD = '111111111111111111';
const ACTOR = '222222222222222222';
// Version/variant nibbles matter: the refund and grant routes re-validate ids
// against a strict v1-v8 UUID pattern, so an all-zero placeholder is rejected
// before any handler logic runs.
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
const FILE_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const ENTITLEMENT_ID = '66666666-6666-4666-8666-666666666666';
const REQUEST_ID = '77777777-7777-4777-8777-777777777777';
const KEY_ID = '88888888-8888-4888-8888-888888888888';
const SIGNAL_ID = '99999999-9999-4999-8999-999999999999';

/* ------------------------------------------------------------------ */
/*  Supabase double                                                    */
/* ------------------------------------------------------------------ */

interface Chain {
  /** What `await chain` resolves to. Mutable so a test can force a write error. */
  result: { data: unknown; error: unknown };
  then(resolve: (value: unknown) => unknown): unknown;
  select: Mock;
  insert: Mock;
  update: Mock;
  upsert: Mock;
  delete: Mock;
  eq: Mock;
  neq: Mock;
  in: Mock;
  is: Mock;
  not: Mock;
  gte: Mock;
  lte: Mock;
  order: Mock;
  limit: Mock;
  range: Mock;
  match: Mock;
  single: Mock;
  maybeSingle: Mock;
}

/**
 * One self-returning, awaitable chain per table. Every builder method returns
 * the chain, so `select().eq().eq().maybeSingle()`, `insert().select().single()`
 * and a bare `await update().eq().eq()` all resolve.
 */
function makeChain(initial: { data?: unknown; error?: unknown } = {}): Chain {
  const chain = {
    result: { data: initial.data ?? null, error: initial.error ?? null },
  } as Chain;
  chain.then = (resolve) => resolve(chain.result);
  chain.single = vi.fn(async () => chain.result);
  chain.maybeSingle = vi.fn(async () => chain.result);
  const builders = [
    'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'is',
    'not', 'gte', 'lte', 'order', 'limit', 'range', 'match',
  ] as const;
  for (const method of builders) {
    (chain as unknown as Record<string, Mock>)[method] = vi.fn(() => chain);
  }
  return chain;
}

interface Client {
  chains: Record<string, Chain>;
  from: Mock;
  rpc: Mock;
  storage: {
    getBucket: Mock;
    createBucket: Mock;
    from: Mock;
  };
}

function mockClient(tables: string[]): Client {
  const chains: Record<string, Chain> = {};
  for (const table of tables) chains[table] = makeChain();
  const bucket = {
    upload: vi.fn(async () => ({ error: null })),
    remove: vi.fn(async () => ({ error: null })),
  };
  const client: Client = {
    chains,
    from: vi.fn((table: string) => (chains[table] ??= makeChain())),
    rpc: vi.fn(),
    storage: {
      getBucket: vi.fn(async () => ({ error: null })),
      createBucket: vi.fn(async () => ({ error: null })),
      from: vi.fn(() => bucket),
    },
  };
  vi.mocked(createAdminSupabase).mockReturnValue(client as never);
  return client;
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as never;
}

/** The single recorded change, or a readable failure if there wasn't exactly one. */
function onlyChange() {
  expect(recordAdminChange).toHaveBeenCalledTimes(1);
  return vi.mocked(recordAdminChange).mock.calls[0][0];
}

beforeEach(() => {
    vi.resetAllMocks();
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: ACTOR, guildId: GUILD },
  } as never);
  vi.mocked(requirePermission).mockResolvedValue({
    guildId: GUILD,
    discordId: ACTOR,
    permissions: ['dashboard.full_access'],
  } as never);
  vi.mocked(readRowBefore).mockResolvedValue(undefined);
  vi.mocked(loadProductPlans).mockResolvedValue([]);
  vi.mocked(loadProductTemporaryRoleIds).mockResolvedValue([]);
  vi.mocked(evaluateEffectivePostWriteProduct).mockReturnValue({
    buyable: false,
    grantedRoleIds: [],
    selectedPlan: null,
  } as never);
  vi.mocked(assertProductRolesNotIncomeEarning).mockResolvedValue({ ok: true } as never);
});

/* ------------------------------------------------------------------ */
/*  /api/store/products                                                */
/* ------------------------------------------------------------------ */

describe('/api/store/products', () => {
  it('POST records the created product and says what it costs in real money', async () => {
    const client = mockClient(['products']);
    client.chains.products.single.mockResolvedValue({
      data: { id: PRODUCT_ID, name: 'Pro License', price_cents: 1999 },
      error: null,
    });
    const { POST } = await import('@/app/api/store/products/route');

    const res = await POST(jsonRequest('http://x/api/store/products', 'POST', {
      name: 'Pro License',
      type: 'free',
      delivery_type: 'file',
      price_cents: 1999,
      currency: 'USD',
    }));
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'store.product_created',
      targetType: 'store product',
      targetId: PRODUCT_ID,
      blastRadius: 'medium',
    });
    expect(change.description).toContain('Pro License');
    // The two economies must never blur: this is the PayPal store, not coins.
    expect(change.description).toContain('19.99 USD');
    expect(change.description).toContain('real money');
    // A create cannot be undone by a row update.
    expect(change.undo).toBeUndefined();
    expect(change.undoReason).toBeTruthy();
  });

  it('POST records nothing when the insert fails', async () => {
    const client = mockClient(['products']);
    client.chains.products.single.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    const { POST } = await import('@/app/api/store/products/route');

    const res = await POST(jsonRequest('http://x/api/store/products', 'POST', {
      name: 'Pro License',
      type: 'free',
      delivery_type: 'file',
      price_cents: 0,
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('PUT records the update with the PRIOR values, so the undo is real', async () => {
    vi.mocked(readRowBefore).mockResolvedValue({
      id: PRODUCT_ID,
      name: 'Pro License',
      price_cents: 1000,
      active: true,
    });
    const client = mockClient(['products']);
    client.chains.products.maybeSingle.mockResolvedValue({
      data: { type: 'one_time', granted_role_ids: [], active: true, price_cents: 1000 },
      error: null,
    });
    client.chains.products.single.mockResolvedValue({
      data: { id: PRODUCT_ID, name: 'Pro License' },
      error: null,
    });
    const { PUT } = await import('@/app/api/store/products/route');

    const res = await PUT(jsonRequest('http://x/api/store/products', 'PUT', {
      id: PRODUCT_ID,
      price_cents: 2500,
    }));
    expect(res.status).toBe(200);

    expect(recordCrudChange).toHaveBeenCalledTimes(1);
    const [change] = vi.mocked(recordCrudChange).mock.calls[0];
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      operation: 'updated',
      action: 'store.product_updated',
      table: 'products',
      targetType: 'store product',
      targetId: PRODUCT_ID,
      label: 'Pro License',
      match: { id: PRODUCT_ID, guild_id: GUILD },
      // A price edit changes what real customers are charged.
      blastRadius: 'high',
    });
    expect(change.before).toMatchObject({ price_cents: 1000 });
  });

  it('PUT of a non-money field is only a medium-blast change', async () => {
    vi.mocked(readRowBefore).mockResolvedValue({ id: PRODUCT_ID, name: 'Old' });
    const client = mockClient(['products']);
    client.chains.products.single.mockResolvedValue({ data: { id: PRODUCT_ID }, error: null });
    const { PUT } = await import('@/app/api/store/products/route');

    await PUT(jsonRequest('http://x/api/store/products', 'PUT', {
      id: PRODUCT_ID,
      description: 'nicer words',
    }));

    expect(vi.mocked(recordCrudChange).mock.calls[0][0].blastRadius).toBe('medium');
  });

  it('PUT records nothing when the update fails', async () => {
    vi.mocked(readRowBefore).mockResolvedValue({ id: PRODUCT_ID, name: 'Pro License' });
    const client = mockClient(['products']);
    client.chains.products.single.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    const { PUT } = await import('@/app/api/store/products/route');

    const res = await PUT(jsonRequest('http://x/api/store/products', 'PUT', {
      id: PRODUCT_ID,
      description: 'x',
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordCrudChange).not.toHaveBeenCalled();
  });

  it('DELETE is a DEACTIVATION, so it offers a genuine restore of the prior flag', async () => {
    const client = mockClient(['products']);
    client.chains.products.maybeSingle.mockResolvedValue({
      data: {
      id: PRODUCT_ID,
      name: 'Pro License',
      active: true,
      },
      error: null,
    });
    const { DELETE } = await import('@/app/api/store/products/route');

    const res = await DELETE(
      jsonRequest(`http://x/api/store/products?id=${PRODUCT_ID}`, 'DELETE'),
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      action: 'store.product_deactivated',
      targetType: 'store product',
      targetId: PRODUCT_ID,
      blastRadius: 'high',
      before: { active: true },
      after: { active: false },
    });
    expect(change.description).toContain('Pro License');
    // The row survives with active=false, so restoring the flag is honest —
    // and the payload must be one the undo route will actually accept.
    expect(change.undo).toEqual({
      kind: 'db',
      table: 'products',
      data: { active: true },
      match: { id: PRODUCT_ID, guild_id: GUILD },
    });
    expect(validateUndoPayload(change.undo, { guildId: GUILD }).ok).toBe(true);
  });

  it('DELETE records nothing for a product this guild does not have', async () => {
    mockClient(['products']);
    const { DELETE } = await import('@/app/api/store/products/route');

    const res = await DELETE(jsonRequest(`http://x/api/store/products?id=${PRODUCT_ID}`, 'DELETE'));

    expect(res.status).toBe(404);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('DELETE reports a redacted server failure when the product lookup fails', async () => {
    const client = mockClient(['products']);
    client.chains.products.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'permission denied for products', code: '42501' },
    });
    const { DELETE } = await import('@/app/api/store/products/route');

    const res = await DELETE(jsonRequest(`http://x/api/store/products?id=${PRODUCT_ID}`, 'DELETE'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).not.toContain('permission denied');
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  /api/store/products/[id]/files                                     */
/* ------------------------------------------------------------------ */

describe('/api/store/products/[id]/files', () => {
  const params = Promise.resolve({ id: PRODUCT_ID });

  it('POST names the product whose buyers gained a download', async () => {
    const client = mockClient(['products', 'product_files']);
    client.chains.products.maybeSingle.mockResolvedValue({
      data: { id: PRODUCT_ID, name: 'Pro License', delivery_type: 'license_key' },
      error: null,
    });
    client.chains.product_files.single.mockResolvedValue({
      data: { id: FILE_ID, name: 'manual.pdf' },
      error: null,
    });
    const { POST } = await import('@/app/api/store/products/[id]/files/route');

    const res = await POST(
      jsonRequest(`http://x/api/store/products/${PRODUCT_ID}/files`, 'POST', {
        name: 'manual.pdf',
      }),
      { params },
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      action: 'store.product_file_added',
      targetType: 'product download',
      targetId: FILE_ID,
      blastRadius: 'medium',
    });
    expect(change.description).toContain('manual.pdf');
    expect(change.description).toContain('Pro License');
    expect(change.undo).toBeUndefined();
  });

  it('POST records nothing when the insert fails', async () => {
    const client = mockClient(['products', 'product_files']);
    client.chains.products.maybeSingle.mockResolvedValue({
      data: { id: PRODUCT_ID, name: 'Pro License', delivery_type: 'license_key' },
      error: null,
    });
    client.chains.product_files.single.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    const { POST } = await import('@/app/api/store/products/[id]/files/route');

    const res = await POST(
      jsonRequest(`http://x/api/store/products/${PRODUCT_ID}/files`, 'POST', {
        name: 'manual.pdf',
      }),
      { params },
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('POST refuses a manual static file row that could bypass buyer derivation', async () => {
    const client = mockClient(['products', 'product_files']);
    client.chains.products.maybeSingle.mockResolvedValue({
      data: { id: PRODUCT_ID, name: 'Static Handbook', delivery_type: 'file' },
      error: null,
    });
    const { POST } = await import('@/app/api/store/products/[id]/files/route');

    const res = await POST(
      jsonRequest(`http://x/api/store/products/${PRODUCT_ID}/files`, 'POST', {
        name: 'manual.pdf',
        external_url: 'https://files.example.test/manual.pdf',
      }),
      { params },
    );

    expect(res.status).toBe(409);
    expect(client.chains.product_files.insert).not.toHaveBeenCalled();
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('DELETE keeps the whole vanished row and does not pretend it can come back', async () => {
    const client = mockClient(['product_files']);
    const row = { id: FILE_ID, display_name: 'manual.pdf', storage_path: 'g/p/f/manual.pdf' };
    client.chains.product_files.single.mockResolvedValue({ data: row, error: null });
    const { DELETE } = await import('@/app/api/store/products/[id]/files/route');

    const res = await DELETE(
      jsonRequest(
        `http://x/api/store/products/${PRODUCT_ID}/files?fileId=${FILE_ID}`,
        'DELETE',
      ),
      { params },
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      action: 'store.product_file_removed',
      targetType: 'product download',
      targetId: FILE_ID,
      // A paid download disappearing is a customer-facing loss.
      blastRadius: 'high',
      before: row,
    });
    expect(change.description).toContain('manual.pdf');
    expect(change.undo).toBeUndefined();
    expect(change.undoReason).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/*  /api/store/files                                                   */
/* ------------------------------------------------------------------ */

describe('/api/store/files', () => {
  function uploadRequest(fileName = 'build.zip', mimeType = 'application/zip') {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], fileName, {
      type: mimeType,
    }));
    form.set('product_id', PRODUCT_ID);
    form.set('display_name', 'Build 1.2.0');
    form.set('version', '1.2.0');
    return new Request('http://x/api/store/files', { method: 'POST', body: form }) as never;
  }

  it('POST records the upload against the product that now delivers it', async () => {
    const client = mockClient(['products', 'product_files']);
    client.chains.products.single.mockResolvedValue({
      data: { id: PRODUCT_ID, name: 'Pro License', delivery_type: 'license_key' },
      error: null,
    });
    client.chains.product_files.single.mockResolvedValue({
      data: { id: FILE_ID, display_name: 'Build 1.2.0' },
      error: null,
    });
    const { POST } = await import('@/app/api/store/files/route');

    const res = await POST(uploadRequest());
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      action: 'store.product_file_uploaded',
      targetType: 'product download',
      targetId: FILE_ID,
      blastRadius: 'medium',
    });
    expect(change.description).toContain('Build 1.2.0');
    expect(change.description).toContain('Pro License');
    expect(change.undo).toBeUndefined();
  });

  it('POST records nothing when the row insert fails after upload', async () => {
    const client = mockClient(['products', 'product_files']);
    client.chains.products.single.mockResolvedValue({
      data: { id: PRODUCT_ID, name: 'Pro License', delivery_type: 'license_key' },
      error: null,
    });
    client.chains.product_files.single.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    const { POST } = await import('@/app/api/store/files/route');

    const res = await POST(uploadRequest());

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('POST accepts a supported static master for buyer-specific delivery', async () => {
    const client = mockClient(['products', 'product_files']);
    client.chains.products.single.mockResolvedValue({
      data: { id: PRODUCT_ID, name: 'Licensed Handbook', delivery_type: 'file' },
      error: null,
    });
    client.chains.product_files.single.mockResolvedValue({
      data: { id: FILE_ID, display_name: 'Build 1.2.0' },
      error: null,
    });
    const { POST } = await import('@/app/api/store/files/route');

    const res = await POST(uploadRequest('handbook.html', 'text/html'));

    expect(res.status).toBe(200);
    expect(client.storage.from).toHaveBeenCalledWith('product-files');
    expect(client.chains.product_files.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        file_name: 'handbook.html',
        mime_type: 'text/html',
      }),
    );
    expect(onlyChange().description).toContain('Licensed Handbook');
  });

  it('POST rejects an unsupported static master before storage mutation', async () => {
    const client = mockClient(['products', 'product_files']);
    client.chains.products.single.mockResolvedValue({
      data: { id: PRODUCT_ID, name: 'Static Archive', delivery_type: 'file' },
      error: null,
    });
    const { POST } = await import('@/app/api/store/files/route');

    const res = await POST(uploadRequest());

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false });
    expect(client.storage.from).not.toHaveBeenCalled();
    expect(client.chains.product_files.insert).not.toHaveBeenCalled();
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('DELETE says the stored file itself is gone, not just the catalogue row', async () => {
    const client = mockClient(['product_files']);
    client.chains.product_files.single.mockResolvedValue({
      data: { id: FILE_ID, display_name: 'Build 1.2.0', storage_path: 'g/p/f/build.zip' },
      error: null,
    });
    const { DELETE } = await import('@/app/api/store/files/route');

    const res = await DELETE(jsonRequest(`http://x/api/store/files?id=${FILE_ID}`, 'DELETE'));
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      action: 'store.product_file_deleted',
      targetType: 'product download',
      targetId: FILE_ID,
      blastRadius: 'high',
    });
    expect(change.description).toContain('Build 1.2.0');
    expect(change.undo).toBeUndefined();
    expect(change.undoReason).toContain('upload the file again');
  });
});

/* ------------------------------------------------------------------ */
/*  /api/store/plans                                                   */
/* ------------------------------------------------------------------ */

describe('/api/store/plans', () => {
  const productRow = {
    id: PRODUCT_ID,
    type: 'subscription',
    active: true,
    price_cents: 0,
    granted_role_ids: [],
  };

  it('POST records the plan and the real-money amount subscribers are charged', async () => {
    const client = mockClient(['products', 'plans']);
    client.chains.products.maybeSingle.mockResolvedValue({ data: productRow, error: null });
    client.chains.plans.single.mockResolvedValue({ data: { id: PLAN_ID }, error: null });
    const { POST } = await import('@/app/api/store/plans/route');

    const res = await POST(jsonRequest('http://x/api/store/plans', 'POST', {
      product_id: PRODUCT_ID,
      name: 'Monthly',
      interval_unit: 'MONTH',
      price_cents: 500,
    }));
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'store.plan_created',
      targetType: 'subscription plan',
      blastRadius: 'medium',
    });
    expect(change.description).toContain('Monthly');
    expect(change.description).toContain('5.00 USD');
    expect(change.description).toContain('real money');
    expect(change.undo).toBeUndefined();
  });

  it('POST records nothing when the insert fails', async () => {
    const client = mockClient(['products', 'plans']);
    client.chains.products.maybeSingle.mockResolvedValue({ data: productRow, error: null });
    client.chains.plans.single.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { POST } = await import('@/app/api/store/plans/route');

    const res = await POST(jsonRequest('http://x/api/store/plans', 'POST', {
      product_id: PRODUCT_ID,
      name: 'Monthly',
      interval_unit: 'MONTH',
      price_cents: 500,
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('PUT reads the prior plan first and offers no undo button it cannot honour', async () => {
    vi.mocked(readRowBefore).mockResolvedValue({
      id: PLAN_ID,
      name: 'Monthly',
      price_cents: 500,
    });
    vi.mocked(loadProductPlans).mockResolvedValue([
      { id: PLAN_ID, active: true, price_cents: 500, paypal_plan_id: 'P-1' },
    ] as never);
    const client = mockClient(['products', 'plans']);
    client.chains.products.maybeSingle.mockResolvedValue({ data: productRow, error: null });
    client.chains.plans.maybeSingle.mockResolvedValue({
      data: {
        id: PLAN_ID,
        product_id: PRODUCT_ID,
        active: true,
        price_cents: 500,
        paypal_plan_id: 'P-1',
      },
      error: null,
    });
    client.chains.plans.single.mockResolvedValue({ data: { id: PLAN_ID }, error: null });
    const { PUT } = await import('@/app/api/store/plans/route');

    const res = await PUT(jsonRequest('http://x/api/store/plans', 'PUT', {
      id: PLAN_ID,
      price_cents: 900,
    }));
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      action: 'store.plan_updated',
      targetId: PLAN_ID,
      blastRadius: 'high',
      before: { id: PLAN_ID, name: 'Monthly', price_cents: 500 },
      after: { price_cents: 900 },
    });
    // `plans` is not in UNDO_TABLE_COLUMNS — a button here would fail on click.
    expect(change.undo).toBeUndefined();
    expect(change.undoReason).toBeTruthy();
  });

  it('DELETE keeps the deleted plan in the record and admits it cannot be restored', async () => {
    vi.mocked(readRowBefore).mockResolvedValue({ id: PLAN_ID, name: 'Monthly' });
    vi.mocked(loadProductPlans).mockResolvedValue([
      { id: PLAN_ID, active: true, price_cents: 500, paypal_plan_id: 'P-1' },
    ] as never);
    const client = mockClient(['products', 'plans']);
    client.chains.products.maybeSingle.mockResolvedValue({ data: productRow, error: null });
    client.chains.plans.maybeSingle.mockResolvedValue({
      data: {
        id: PLAN_ID,
        product_id: PRODUCT_ID,
        active: true,
        price_cents: 500,
        paypal_plan_id: 'P-1',
      },
      error: null,
    });
    const { DELETE } = await import('@/app/api/store/plans/route');

    const res = await DELETE(jsonRequest(`http://x/api/store/plans?id=${PLAN_ID}`, 'DELETE'));
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      action: 'store.plan_deleted',
      targetId: PLAN_ID,
      blastRadius: 'high',
      before: { id: PLAN_ID, name: 'Monthly' },
    });
    expect(change.description).toContain('Monthly');
    expect(change.undo).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  /api/customers/[id]/entitlements                                   */
/* ------------------------------------------------------------------ */

describe('/api/customers/[id]/entitlements', () => {
  const params = Promise.resolve({ id: CUSTOMER_ID });

  function grantClient() {
    const client = mockClient(['customers', 'products']);
    client.chains.customers.maybeSingle.mockResolvedValue({
      data: { id: CUSTOMER_ID, discord_username: 'alice' },
      error: null,
    });
    client.chains.products.maybeSingle.mockResolvedValue({
      data: {
        id: PRODUCT_ID,
        name: 'Pro License',
        granted_role_ids: [],
        granted_channel_ids: [],
      },
      error: null,
    });
    return client;
  }

  it('POST records a manual grant and states plainly that no money changed hands', async () => {
    const client = grantClient();
    client.rpc.mockResolvedValue({
      data: [{
        entitlement_id: ENTITLEMENT_ID,
        order_id: REQUEST_ID,
        request_id: REQUEST_ID,
      }],
      error: null,
    });
    const { POST } = await import('@/app/api/customers/[id]/entitlements/route');

    const res = await POST(
      jsonRequest(`http://x/api/customers/${CUSTOMER_ID}/entitlements`, 'POST', {
        request_id: REQUEST_ID,
        product_id: PRODUCT_ID,
        type: 'one_time',
        source: 'manual',
      }),
      { params },
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'commerce.entitlement_granted',
      targetType: 'customer entitlement',
      targetId: ENTITLEMENT_ID,
      blastRadius: 'high',
    });
    // Both sides of the sentence must be unambiguous: who, and what.
    expect(change.description).toContain('alice');
    expect(change.description).toContain('Pro License');
    // The grant manufactures a zero-value ORDER row. Nothing on the page may
    // let an owner read that as a purchase.
    expect(change.description).toContain('no money changed hands');
    expect(change.undo).toBeUndefined();
  });

  it('POST records nothing when the grant RPC rejects', async () => {
    const client = grantClient();
    client.rpc.mockResolvedValue({ data: null, error: { message: 'nope', code: '23514' } });
    const { POST } = await import('@/app/api/customers/[id]/entitlements/route');

    const res = await POST(
      jsonRequest(`http://x/api/customers/${CUSTOMER_ID}/entitlements`, 'POST', {
        request_id: REQUEST_ID,
        product_id: PRODUCT_ID,
        type: 'one_time',
        source: 'manual',
      }),
      { params },
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('PUT names the customer and the product when access is revoked', async () => {
    // The stored status follows the RPC, so a read taken AFTER the transition
    // returns 'expired'. That is what makes the `before` assertion below a real
    // ordering guard instead of an echo of a fixed stub.
    let storedStatus = 'active';
    vi.mocked(readRowBefore).mockImplementation(async () => ({
      id: ENTITLEMENT_ID,
      status: storedStatus,
      product_id: PRODUCT_ID,
      customer_id: CUSTOMER_ID,
      products: { name: 'Pro License' },
      customers: { discord_username: 'alice' },
    }));
    const client = mockClient(['alerts']);
    client.rpc.mockImplementation(async () => {
      storedStatus = 'expired';
      return {
        data: [{
          entitlement_id: ENTITLEMENT_ID,
          customer_id: CUSTOMER_ID,
          status: 'expired',
          product_id: PRODUCT_ID,
        }],
        error: null,
      };
    });
    const { PUT } = await import('@/app/api/customers/[id]/entitlements/route');

    const res = await PUT(
      jsonRequest(`http://x/api/customers/${CUSTOMER_ID}/entitlements`, 'PUT', {
        entitlement_id: ENTITLEMENT_ID,
        status: 'revoked',
      }),
      { params },
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      action: 'commerce.entitlement_revoked',
      targetType: 'customer entitlement',
      targetId: ENTITLEMENT_ID,
      // Taking away paid access is never a low-stakes edit.
      blastRadius: 'high',
      // Read BEFORE the transition — otherwise this would say 'expired'.
      before: { status: 'active' },
      after: { status: 'expired' },
    });
    expect(change.description).toContain('alice');
    expect(change.description).toContain('Pro License');
    expect(change.undo).toBeUndefined();
    expect(change.undoReason).toBeTruthy();
  });

  it('PUT records nothing when the lifecycle RPC refuses the transition', async () => {
    const client = mockClient(['alerts']);
    client.rpc.mockResolvedValue({ data: null, error: { message: 'no', code: '23514' } });
    const { PUT } = await import('@/app/api/customers/[id]/entitlements/route');

    const res = await PUT(
      jsonRequest(`http://x/api/customers/${CUSTOMER_ID}/entitlements`, 'PUT', {
        entitlement_id: ENTITLEMENT_ID,
        status: 'revoked',
      }),
      { params },
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  /api/license-keys/[key]                                            */
/* ------------------------------------------------------------------ */

describe('/api/license-keys/[key]', () => {
  const params = Promise.resolve({ key: KEY_ID });

  function keyClient(status = 'active') {
    const client = mockClient(['license_keys', 'license_sessions']);
    client.chains.license_keys.maybeSingle.mockResolvedValue({
      data: {
        id: KEY_ID,
        status,
        key_prefix: 'SOMNI',
        key_suffix: 'X9F2',
        products: { name: 'Pro License' },
        customers: { discord_username: 'alice' },
      },
      error: null,
    });
    client.chains.license_keys.single.mockResolvedValue({
      data: { id: KEY_ID, status: 'revoked' },
      error: null,
    });
    client.chains.license_sessions.result = {
      data: [{ id: 's-1' }, { id: 's-2' }],
      error: null,
    };
    return client;
  }

  it('PUT revocation says whose install breaks and how many devices were signed out', async () => {
    keyClient();
    const { PUT } = await import('@/app/api/license-keys/[key]/route');

    const res = await PUT(
      jsonRequest(`http://x/api/license-keys/${KEY_ID}`, 'PUT', {
        status: 'revoked',
        revocation_reason: 'Chargeback',
      }),
      { params },
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'license.key_revoked',
      targetType: 'license key',
      targetId: KEY_ID,
      blastRadius: 'high',
      before: { status: 'active' },
    });
    expect(change.description).toContain('SOMNI…X9F2');
    expect(change.description).toContain('Pro License');
    expect(change.description).toContain('2 active devices');
    // The deactivated sessions are not restored by a license_keys row update,
    // so no button may claim otherwise.
    expect(change.undo).toBeUndefined();
    expect(change.undoReason).toContain('set its status back to active by hand');
  });

  it('PUT reactivation is a lower-blast change with its own verb', async () => {
    const client = keyClient('revoked');
    client.chains.license_keys.single.mockResolvedValue({
      data: { id: KEY_ID, status: 'active' },
      error: null,
    });
    const { PUT } = await import('@/app/api/license-keys/[key]/route');

    await PUT(
      jsonRequest(`http://x/api/license-keys/${KEY_ID}`, 'PUT', { status: 'active' }),
      { params },
    );

    const change = onlyChange();
    expect(change.action).toBe('license.key_status_changed');
    expect(change.blastRadius).toBe('medium');
    expect(change.description).toContain('from revoked to active');
  });

  it('PUT records nothing when the status update fails', async () => {
    const client = keyClient();
    client.chains.license_keys.single.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    const { PUT } = await import('@/app/api/license-keys/[key]/route');

    const res = await PUT(
      jsonRequest(`http://x/api/license-keys/${KEY_ID}`, 'PUT', { status: 'revoked' }),
      { params },
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  /api/license/config/[productId]                                    */
/* ------------------------------------------------------------------ */

describe('/api/license/config/[productId]', () => {
  const params = Promise.resolve({ productId: PRODUCT_ID });
  /** What the request sends. `tier` is omitted — the schema has no null tier. */
  const configBody = {
    license_mode: 'portal_only',
    max_devices: 3,
    heartbeat_interval_seconds: 300,
    offline_grace_period_seconds: 86400,
    feature_flags: {},
    watermark_config: null,
    require_discord_guild_membership: true,
  };
  /** What the row already held — the same values the route will write back. */
  const priorConfig = { product_id: PRODUCT_ID, tier: null, ...configBody };

  function configClient() {
    const client = mockClient(['products', 'product_license_config']);
    client.chains.products.maybeSingle.mockResolvedValue({
      data: { id: PRODUCT_ID, name: 'Pro License' },
      error: null,
    });
    client.chains.product_license_config.single.mockResolvedValue({
      data: { product_id: PRODUCT_ID },
      error: null,
    });
    return client;
  }

  it('PUT restores only the settings that actually changed', async () => {
    vi.mocked(readRowBefore).mockResolvedValue(priorConfig);
    configClient();
    const { PUT } = await import('@/app/api/license/config/[productId]/route');

    const res = await PUT(
      jsonRequest(`http://x/api/license/config/${PRODUCT_ID}`, 'PUT', {
        ...configBody,
        max_devices: 10,
      }),
      { params },
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'license.config_updated',
      targetType: 'product license settings',
      targetId: PRODUCT_ID,
      blastRadius: 'high',
      before: { max_devices: 3 },
      after: { max_devices: 10 },
    });
    expect(change.description).toContain('Pro License');
    expect(change.description).toContain('max devices');
    expect(change.undo).toEqual({
      kind: 'db',
      table: 'product_license_config',
      data: { max_devices: 3 },
      match: { product_id: PRODUCT_ID },
    });
    // `product_license_config` has no guild column: the undo route resolves the
    // owning guild through products before writing.
    const validation = validateUndoPayload(change.undo, { guildId: GUILD });
    expect(validation.ok).toBe(true);
    expect(validation.ok && validation.tenancyCheck).toMatchObject({
      foreignTable: 'products',
      foreignGuildColumn: 'guild_id',
    });
  });

  it('PUT offers no undo for the FIRST save — there is nothing to restore to', async () => {
    vi.mocked(readRowBefore).mockResolvedValue(undefined);
    configClient();
    const { PUT } = await import('@/app/api/license/config/[productId]/route');

    await PUT(
      jsonRequest(`http://x/api/license/config/${PRODUCT_ID}`, 'PUT', { max_devices: 10 }),
      { params },
    );

    const change = onlyChange();
    expect(change.undo).toBeUndefined();
    expect(change.undoReason).toContain('no saved license settings');
  });

  it('PUT records nothing when nothing actually changed', async () => {
    vi.mocked(readRowBefore).mockResolvedValue(priorConfig);
    configClient();
    const { PUT } = await import('@/app/api/license/config/[productId]/route');

    const res = await PUT(
      jsonRequest(`http://x/api/license/config/${PRODUCT_ID}`, 'PUT', configBody),
      { params },
    );

    expect(res.status).toBe(200);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('PUT records nothing when the upsert fails', async () => {
    vi.mocked(readRowBefore).mockResolvedValue(priorConfig);
    const client = configClient();
    client.chains.product_license_config.single.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    const { PUT } = await import('@/app/api/license/config/[productId]/route');

    const res = await PUT(
      jsonRequest(`http://x/api/license/config/${PRODUCT_ID}`, 'PUT', { max_devices: 10 }),
      { params },
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  /api/reconciliation                                                */
/* ------------------------------------------------------------------ */

describe('/api/reconciliation', () => {
  it('POST records the queued sweep as something that REVOKES access', async () => {
    mockClient(['reconciliation_runs', 'bot_action_queue']);
    const { POST } = await import('@/app/api/reconciliation/route');

    const res = await POST(jsonRequest('http://x/api/reconciliation', 'POST'));
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'commerce.reconciliation_queued',
      targetType: 'reconciliation run',
      // The sweep expires entitlements and deactivates sessions — it is not a
      // read-only report, and the record must not imply that it is.
      blastRadius: 'high',
      after: { trigger: 'manual' },
    });
    expect(change.description).toContain('revoke access');
    expect(change.undo).toBeUndefined();
  });

  it('POST records nothing when the action could not be queued', async () => {
    const client = mockClient(['reconciliation_runs', 'bot_action_queue']);
    client.chains.bot_action_queue.result = { data: null, error: { message: 'boom' } };
    const { POST } = await import('@/app/api/reconciliation/route');

    const res = await POST(jsonRequest('http://x/api/reconciliation', 'POST'));

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  /api/fraud/signals                                                 */
/* ------------------------------------------------------------------ */

describe('/api/fraud/signals', () => {
  it('PATCH records the decision and says it enforces nothing by itself', async () => {
    vi.mocked(readRowBefore).mockResolvedValue({
      id: SIGNAL_ID,
      status: 'open',
      signal_type: 'velocity_limit',
      severity: 'critical',
      resolution_note: null,
    });
    const client = mockClient(['fraud_signals']);
    client.chains.fraud_signals.single.mockResolvedValue({
      data: { id: SIGNAL_ID, status: 'dismissed' },
      error: null,
    });
    const { PATCH } = await import('@/app/api/fraud/signals/route');

    const res = await PATCH(jsonRequest('http://x/api/fraud/signals', 'PATCH', {
      id: SIGNAL_ID,
      status: 'dismissed',
      resolution_note: 'Known customer',
    }));
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'fraud.signal_dismissed',
      targetType: 'fraud signal',
      targetId: SIGNAL_ID,
      blastRadius: 'medium',
      before: { status: 'open', resolution_note: null },
    });
    expect(change.description).toContain('critical');
    expect(change.description).toContain('velocity_limit');
    // Nothing reads this decision to block a customer or void an order, and an
    // owner must not assume it did.
    expect(change.description).toContain('does not block the customer');
    expect(change.undo).toBeUndefined();
  });

  it('PATCH records nothing when the update fails', async () => {
    const client = mockClient(['fraud_signals']);
    client.chains.fraud_signals.single.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    const { PATCH } = await import('@/app/api/fraud/signals/route');

    const res = await PATCH(jsonRequest('http://x/api/fraud/signals', 'PATCH', {
      id: SIGNAL_ID,
      status: 'dismissed',
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  /api/orders/[id]/refund — wiring only; see the dedicated file      */
/* ------------------------------------------------------------------ */

describe('/api/orders/[id]/refund', () => {
  const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const params = Promise.resolve({ id: ORDER_ID });

  function attempt(overrides: Record<string, unknown> = {}) {
    return {
      order_id: ORDER_ID,
      attempt_id: ATTEMPT_ID,
      request_id: ATTEMPT_ID,
      status: 'provider_completed',
      provider_action: 'finalize',
      resource_type: 'capture',
      paypal_payment_id: 'CAPTURE-123',
      paypal_refund_id: 'REFUND-123',
      refund_amount_cents: 1999,
      currency: 'USD',
      reason: 'Admin refund',
      actor_id: ACTOR,
      ...overrides,
    };
  }

  function finalized(overrides: Record<string, unknown> = {}) {
    return {
      order_id: ORDER_ID,
      attempt_id: ATTEMPT_ID,
      status: 'completed',
      order_status: 'refunded',
      already_refunded: false,
      entitlements_changed: 1,
      licenses_changed: 1,
      sessions_changed: 1,
      paypal_refund_id: 'REFUND-123',
      ...overrides,
    };
  }

  function refundClient(opts: {
    prepared?: Record<string, unknown>;
    finalization?: Record<string, unknown> | null;
  } = {}) {
    const client = mockClient(['orders', 'admin_changes']);
    client.rpc.mockImplementation(async (name: string) => {
      if (name === 'commerce_prepare_admin_refund') {
        return { data: opts.prepared ?? attempt(), error: null };
      }
      if (name === 'commerce_finalize_admin_refund') {
        return opts.finalization === null
          ? { data: null, error: { message: 'boom' } }
          : { data: opts.finalization ?? finalized(), error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    return client;
  }

  it('POST records a completed PayPal refund as CRITICAL and NEVER undoable', async () => {
    vi.mocked(readRowBefore).mockResolvedValue({
      id: ORDER_ID,
      order_number: 'SB-1042',
      status: 'completed',
      amount_cents: 1999,
      currency: 'USD',
    });
    refundClient();
    const { POST } = await import('@/app/api/orders/[id]/refund/route');

    const res = await POST(
      jsonRequest(`http://x/api/orders/${ORDER_ID}/refund`, 'POST', {}),
      { params },
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'commerce.order_refunded',
      targetType: 'real-money order',
      targetId: ORDER_ID,
      blastRadius: 'critical',
      // The pre-write read, not the post-write state.
      before: { status: 'completed', order_number: 'SB-1042' },
    });
    expect(change.description).toContain('19.99 USD');
    expect(change.description).toContain('SB-1042');
    expect(change.description).toContain('real money has left your PayPal account');
    // THE guard: PayPal has no un-refund, so a db-undo flipping order.status
    // back would tell the owner money returned when it did not.
    expect(change.undo).toBeUndefined();
    expect(change.undoReason).toContain('PayPal has no way to reverse a refund');
  });

  it('POST does NOT claim money moved for a zero-amount local refund', async () => {
    vi.mocked(readRowBefore).mockResolvedValue({
      id: ORDER_ID,
      order_number: 'SB-1043',
      status: 'completed',
    });
    refundClient({
      prepared: attempt({
        resource_type: null,
        paypal_payment_id: null,
        paypal_refund_id: null,
        refund_amount_cents: 0,
        status: 'prepared',
        provider_action: 'finalize',
      }),
      finalization: finalized({ paypal_refund_id: null }),
    });
    const { POST } = await import('@/app/api/orders/[id]/refund/route');

    const res = await POST(
      jsonRequest(`http://x/api/orders/${ORDER_ID}/refund`, 'POST', {}),
      { params },
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change.description).toContain('no real money moved');
    expect(change.description).not.toContain('left your PayPal account');
    expect(change.undo).toBeUndefined();
  });

  it('POST records nothing when local finalization fails', async () => {
    refundClient({ finalization: null });
    const { POST } = await import('@/app/api/orders/[id]/refund/route');

    const res = await POST(
      jsonRequest(`http://x/api/orders/${ORDER_ID}/refund`, 'POST', {}),
      { params },
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('POST records nothing on a replay whose refund was already applied', async () => {
    // A concurrent or retried attempt that found the work done. Recording it
    // would show the owner a second "Refunded 19.99 USD" for money that left
    // once.
    refundClient({
      finalization: finalized({
        already_refunded: true,
        entitlements_changed: 0,
        licenses_changed: 0,
        sessions_changed: 0,
      }),
    });
    const { POST } = await import('@/app/api/orders/[id]/refund/route');

    const res = await POST(
      jsonRequest(`http://x/api/orders/${ORDER_ID}/refund`, 'POST', {}),
      { params },
    );

    expect(res.status).toBe(200);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});
