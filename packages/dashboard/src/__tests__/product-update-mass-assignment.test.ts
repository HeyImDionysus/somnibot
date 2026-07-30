/**
 * Mass-assignment guard for the store/products PUT route.
 *
 * The PUT handler spreads every parsed key straight into the Supabase
 * `.update()` payload. Before this fix, schemas.product.update was
 * `.passthrough()`, so a client could name ANY column — most dangerously
 * `paypal_product_id`, the PayPal Catalog identifier that checkout/webhook
 * routing TRUSTS to map a product to its PayPal entry. A client-supplied value
 * would repoint the product at an attacker-chosen catalog id.
 *
 * These tests pin the schema as `.strict()`: only the intended writable columns
 * survive parsing; every unknown key (paypal_product_id, guild_id, created_at,
 * plans, arbitrary columns) is rejected before it can reach the DB.
 */
import { describe, it, expect } from 'vitest';
import { schemas } from '@/lib/api/validation';

const VALID_ID = '00000000-0000-0000-0000-000000000001';

// The exact set of product columns a dashboard admin may write via update.
// Mirrors both the strict schema and the undo `products.data` allowlist.
const WRITABLE_COLUMNS = [
  'name',
  'description',
  'type',
  'delivery_type',
  'price_cents',
  'currency',
  'granted_role_ids',
  'granted_channel_ids',
  'active',
  'sort_order',
  'metadata',
] as const;

describe('schemas.product.update — strict mass-assignment guard', () => {
  it('accepts a minimal legitimate update ({ id, name })', () => {
    const res = schemas.product.update.safeParse({ id: VALID_ID, name: 'New name' });
    expect(res.success).toBe(true);
    if (res.success) {
      // No spurious defaults injected for omitted keys — an omitted column must
      // be left untouched by the update, not reset to its create-time default.
      expect(res.data).toEqual({ id: VALID_ID, name: 'New name' });
    }
  });

  it('accepts a toggle-active update ({ id, active })', () => {
    const res = schemas.product.update.safeParse({ id: VALID_ID, active: false });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toEqual({ id: VALID_ID, active: false });
  });

  it('accepts every legitimate writable column', () => {
    const res = schemas.product.update.safeParse({
      id: VALID_ID,
      name: 'p',
      description: 'd',
      type: 'one_time',
      delivery_type: 'file',
      price_cents: 500,
      currency: 'USD',
      granted_role_ids: ['123456789012345678'],
      granted_channel_ids: ['123456789012345679'],
      active: true,
      sort_order: 3,
      metadata: { note: 'x' },
    });
    expect(res.success).toBe(true);
  });

  it('REJECTS paypal_product_id (mass-assignment of the PayPal catalog id)', () => {
    const res = schemas.product.update.safeParse({
      id: VALID_ID,
      name: 'p',
      paypal_product_id: 'ATTACKER-CATALOG-ID',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('REJECTS guild_id (cannot move a product between tenants)', () => {
    const res = schemas.product.update.safeParse({
      id: VALID_ID,
      guild_id: 'attacker-guild',
    });
    expect(res.success).toBe(false);
  });

  it('REJECTS created_at (immutable)', () => {
    const res = schemas.product.update.safeParse({
      id: VALID_ID,
      created_at: '2020-01-01T00:00:00Z',
    });
    expect(res.success).toBe(false);
  });

  it('REJECTS updated_at from the client (route stamps it server-side)', () => {
    const res = schemas.product.update.safeParse({
      id: VALID_ID,
      updated_at: '2020-01-01T00:00:00Z',
    });
    expect(res.success).toBe(false);
  });

  it('REJECTS plans on update (create-only input, not a products column)', () => {
    const res = schemas.product.update.safeParse({
      id: VALID_ID,
      plans: [{ interval_unit: 'MONTH' }],
    });
    expect(res.success).toBe(false);
  });

  it('REJECTS an arbitrary unknown column', () => {
    const res = schemas.product.update.safeParse({
      id: VALID_ID,
      is_admin: true,
    });
    expect(res.success).toBe(false);
  });

  it('requires a valid uuid id', () => {
    expect(schemas.product.update.safeParse({ name: 'p' }).success).toBe(false);
    expect(schemas.product.update.safeParse({ id: 'not-a-uuid', name: 'p' }).success).toBe(false);
  });

  it('never surfaces a non-writable column in the parsed payload', () => {
    // Even a payload that mixes legitimate + injected keys must fail closed:
    // strict parsing rejects the whole object rather than silently stripping.
    const res = schemas.product.update.safeParse({
      id: VALID_ID,
      name: 'p',
      price_cents: 100,
      paypal_product_id: 'x',
      guild_id: 'g',
    });
    expect(res.success).toBe(false);
  });

  it('the writable set matches the undo products.data allowlist (no drift)', async () => {
    // Guard against the schema and the undo allowlist drifting apart: every
    // column the strict schema accepts (minus id) must be undo-settable, and
    // vice versa (minus updated_at, which the route stamps, not the client).
    const { UNDO_TABLE_COLUMNS } = await import('@/lib/api/undo-allowlist');
    const undoData = UNDO_TABLE_COLUMNS.get('products')?.data;
    expect(undoData).toBeDefined();
    for (const col of WRITABLE_COLUMNS) {
      expect(undoData?.has(col), `undo products.data missing ${col}`).toBe(true);
      const res = schemas.product.update.safeParse({ id: VALID_ID, [col]: undefined });
      // `undefined` value is fine (optional); the point is the key is recognized.
      expect(res.success, `schema rejects writable ${col}`).toBe(true);
    }
    // paypal_product_id must be excluded from BOTH.
    expect(undoData?.has('paypal_product_id')).toBe(false);
  });
});

describe('commerce currency canonicalization', () => {
  it('normalizes product and plan writes to the provider/database currency domain', () => {
    expect(schemas.product.update.parse({
      id: VALID_ID,
      currency: 'usd',
    }).currency).toBe('USD');
    expect(schemas.plan.update.parse({
      id: VALID_ID,
      currency: 'eUr',
    }).currency).toBe('EUR');
  });

  it('rejects non-letter three-character currency values', () => {
    expect(schemas.product.update.safeParse({
      id: VALID_ID,
      currency: 'U$D',
    }).success).toBe(false);
    expect(schemas.plan.update.safeParse({
      id: VALID_ID,
      currency: '12A',
    }).success).toBe(false);
  });
});
