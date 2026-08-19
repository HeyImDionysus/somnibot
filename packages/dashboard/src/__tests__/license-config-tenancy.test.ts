/**
 * license-config-tenancy — cross-tenant isolation for /api/license/config/[productId].
 *
 * `product_license_config` is keyed by `product_id` alone and carries no
 * `guild_id`, and both handlers query it through the service-role client, which
 * row-level security does not apply to. Both handlers took `guildId` off the
 * auth context and then never used it, so naming another guild's product UUID
 * read — and overwrote — that guild's licence configuration.
 *
 * That is worth spelling out in customer terms, because it is not an abstract
 * tenancy nit: `max_devices` decides how many machines a paying customer may
 * install on, and `offline_grace_period_seconds` decides how long their copy
 * keeps working without reaching the licence server. A stranger could set
 * either one on products they do not own.
 *
 * Being authenticated as SOME guild's owner was the only bar, and every
 * operator of a white-label instance clears it.
 *
 * These tests assert the gate from the outside: a foreign product id must not
 * read, and must not write. The write case is the one that matters most, so it
 * asserts the absence of the upsert directly rather than trusting the status
 * code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const OWN_GUILD = '111111111111111111';
const OWNER_DISCORD = '222222222222222222';
/** A product belonging to a DIFFERENT guild. */
const FOREIGN_PRODUCT = '00000000-0000-4000-8000-0000000000ff';
const OWN_PRODUCT = '00000000-0000-4000-8000-000000000001';

/** Every table operation the route performed, in order. */
let ops: Array<{ table: string; kind: string; filters: Record<string, unknown> }> = [];

/**
 * Minimal Supabase double.
 *
 * `products` answers only when BOTH the id and the guild match, which is
 * exactly the real behaviour of `.eq('id', …).eq('guild_id', …)` and is what
 * makes a foreign id resolve to null. `product_license_config` would happily
 * answer for any id — that permissiveness is the vulnerability, so the double
 * keeps it rather than papering over it.
 */
function createSupabaseDouble() {
  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    let kind = 'select';
    const chain: Record<string, unknown> = {
      select() { return chain; },
      eq(column: string, value: unknown) { filters[column] = value; return chain; },
      upsert(payload: unknown) {
        kind = 'upsert';
        ops.push({ table, kind, filters: { ...filters, payload } });
        return chain;
      },
      update(payload: unknown) {
        kind = 'update';
        ops.push({ table, kind, filters: { ...filters, payload } });
        return chain;
      },
      insert(payload: unknown) {
        kind = 'insert';
        ops.push({ table, kind, filters: { ...filters, payload } });
        return chain;
      },
      maybeSingle() {
        ops.push({ table, kind, filters: { ...filters } });
        if (table === 'products') {
          const owned = filters.id === OWN_PRODUCT && filters.guild_id === OWN_GUILD;
          return Promise.resolve({
            data: owned ? {
              id: OWN_PRODUCT,
              name: 'Pro bundle',
              metadata: {
                completed_project_licensing: {
                  plansAndFeatures: 'Annual Pro',
                  outputFormats: '',
                  policyPending: true,
                  desiredPolicy: {
                    keyPrefix: 'SMNI',
                    maxDevices: 99,
                    heartbeatIntervalMs: 300000,
                    sdkCacheTtlMs: 60000,
                    offlineGracePeriodSeconds: 86400,
                    featureFlags: [],
                    requireDiscordGuildMembership: true,
                    rotationPolicy: 'rotate-and-invalidate',
                    selfServiceDeviceRemoval: true,
                  },
                },
              },
            } : null,
            error: null,
          });
        }
        if (table === 'product_license_config') {
          return Promise.resolve({
            data: { product_id: filters.product_id, max_devices: 3 },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        return Promise.resolve({ data: { product_id: filters.product_id }, error: null });
      },
      then(resolve: (value: { data: null; error: null }) => void) {
        resolve({ data: null, error: null });
      },
    };
    return chain;
  };
  return { from: (table: string) => builder(table) };
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => createSupabaseDouble(),
}));

vi.mock('@/lib/api/require-owner', () => ({
  requireGuildOwner: async () => ({
    ok: true,
    ctx: { guildId: OWN_GUILD, discordId: OWNER_DISCORD },
  }),
}));

vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: async () => null,
}));

vi.mock('@/lib/admin-changes', () => ({
  recordAdminChange: vi.fn(async () => {}),
  readRowBefore: vi.fn(async () => ({ max_devices: 3 })),
  describeSettingChange: () => 'Changed settings',
  undoByRestoring: (table: string, match: unknown, data: unknown) =>
    ({ kind: 'db', table, match, data }),
}));

import { recordAdminChange } from '@/lib/admin-changes';

function put(productId: string, maxDevices = 99) {
  return new Request(`http://localhost/api/license/config/${productId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max_devices: maxDevices, license_mode: 'portal_only' }),
  }) as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  ops = [];
  vi.mocked(recordAdminChange).mockClear();
});

describe('GET /api/license/config/[productId] — tenancy', () => {
  it('refuses a product belonging to another guild', async () => {
    const { GET } = await import('../app/api/license/config/[productId]/route');
    const res = await GET(
      new Request('http://localhost') as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ productId: FOREIGN_PRODUCT }) },
    );

    expect(res.status).toBe(404);
    // Never reached the config table at all.
    expect(ops.some((o) => o.table === 'product_license_config')).toBe(false);
  });

  it('still serves a product the caller owns', async () => {
    const { GET } = await import('../app/api/license/config/[productId]/route');
    const res = await GET(
      new Request('http://localhost') as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ productId: OWN_PRODUCT }) },
    );

    expect(res.status).toBe(200);
    expect(ops.some((o) => o.table === 'product_license_config')).toBe(true);
  });
});

describe('PUT /api/license/config/[productId] — tenancy', () => {
  it('does NOT write another guild\'s licence config', async () => {
    const { PUT } = await import('../app/api/license/config/[productId]/route');
    const res = await PUT(put(FOREIGN_PRODUCT), {
      params: Promise.resolve({ productId: FOREIGN_PRODUCT }),
    });

    expect(res.status).toBe(404);

    // The assertion that actually matters: no upsert was issued. A 404 with a
    // write already committed would be worse than no check at all, because it
    // would read as safe.
    const writes = ops.filter((o) => o.kind === 'upsert' || o.kind === 'insert');
    expect(writes, 'a foreign product must produce no write').toEqual([]);
  });

  it('does not reveal whether a foreign product exists', async () => {
    const { PUT } = await import('../app/api/license/config/[productId]/route');
    const res = await PUT(put(FOREIGN_PRODUCT), {
      params: Promise.resolve({ productId: FOREIGN_PRODUCT }),
    });
    const body = (await res.json()) as { error?: string };

    // Same 404 and same wording a genuinely absent product gets, so catalogue
    // membership cannot be probed by comparing responses.
    expect(res.status).toBe(404);
    expect(body.error).toBe('Product not found');
  });

  it('still writes a product the caller owns', async () => {
    const { PUT } = await import('../app/api/license/config/[productId]/route');
    const res = await PUT(put(OWN_PRODUCT), {
      params: Promise.resolve({ productId: OWN_PRODUCT }),
    });

    expect(res.status).toBe(200);
    const writes = ops.filter((o) => o.kind === 'upsert');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.table).toBe('product_license_config');
    const recoveryWrites = ops.filter((o) => o.kind === 'update' && o.table === 'products');
    expect(recoveryWrites).toHaveLength(1);
    expect(recoveryWrites[0]!.filters.payload).toMatchObject({
      metadata: {
        completed_project_licensing: { policyPending: false },
      },
    });
    const recordedChange = vi.mocked(recordAdminChange).mock.calls[0]?.[0];
    expect(recordedChange).not.toHaveProperty('undo');
    expect(recordedChange?.undoReason).toContain('activation-locked policy transition');
  });

  it('keeps activation blocked when the saved policy does not match the requested policy', async () => {
    const { PUT } = await import('../app/api/license/config/[productId]/route');
    const res = await PUT(put(OWN_PRODUCT, 98), {
      params: Promise.resolve({ productId: OWN_PRODUCT }),
    });

    expect(res.status).toBe(200);
    expect(ops.filter((o) => o.kind === 'update' && o.table === 'products')).toHaveLength(0);
  });
});
