/**
 * Finding 6 — a `license_key` product must be able to deliver a key.
 *
 * The authoritative rail is the DB trigger in
 * `20260727010000_license_delivery_requires_config.sql`. These cover the
 * store-route's verification of that rail: the product either provably has a
 * `product_license_config` row, or it is taken off sale.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LICENSE_KEY_DELIVERY_TYPE,
  ensureLicenseDeliveryConfigOrDisable,
  requiresLicenseConfig,
} from '@/lib/api/license-delivery-rail';

const GUILD = 'guild-1';
const PRODUCT_ID = '00000000-0000-0000-0000-0000000000aa';

type DbError = { message: string; code?: string };

interface FakeOptions {
  /** Rows visible in product_license_config AFTER the upsert. */
  configExistsAfterUpsert: boolean;
  upsertError?: DbError;
  readError?: DbError;
  updateError?: DbError;
}

function makeSupabase(options: FakeOptions) {
  const calls = {
    upserts: [] as unknown[],
    productUpdates: [] as { payload: unknown; filters: Record<string, unknown> }[],
  };

  const from = vi.fn((table: string) => {
    if (table === 'product_license_config') {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        upsert: vi.fn(async (payload: unknown) => {
          calls.upserts.push(payload);
          return { error: options.upsertError ?? null };
        }),
        select: vi.fn(() => chain),
        eq: vi.fn((col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        }),
        maybeSingle: vi.fn(async () => {
          if (options.readError) return { data: null, error: options.readError };
          return {
            data: options.configExistsAfterUpsert ? { product_id: filters.product_id } : null,
            error: null,
          };
        }),
      };
      return chain;
    }
    if (table === 'products') {
      const filters: Record<string, unknown> = {};
      let payload: unknown = null;
      const chain: Record<string, unknown> = {
        update: vi.fn((next: unknown) => {
          payload = next;
          return chain;
        }),
        eq: vi.fn((col: string, val: unknown) => {
          filters[col] = val;
          if (Object.keys(filters).length === 2) {
            calls.productUpdates.push({ payload, filters: { ...filters } });
            return Promise.resolve({ error: options.updateError ?? null });
          }
          return chain;
        }),
      };
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { supabase: { from } as never, calls };
}

describe('requiresLicenseConfig', () => {
  it('matches only the licence-key delivery type', () => {
    expect(requiresLicenseConfig(LICENSE_KEY_DELIVERY_TYPE)).toBe(true);
    expect(requiresLicenseConfig('file')).toBe(false);
    expect(requiresLicenseConfig('link')).toBe(false);
    expect(requiresLicenseConfig('access_pass')).toBe(false);
    expect(requiresLicenseConfig('mixed')).toBe(false);
    expect(requiresLicenseConfig(undefined)).toBe(false);
    expect(requiresLicenseConfig(null)).toBe(false);
  });
});

describe('ensureLicenseDeliveryConfigOrDisable', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes and leaves the product on sale once the config row exists', async () => {
    const { supabase, calls } = makeSupabase({ configExistsAfterUpsert: true });

    const result = await ensureLicenseDeliveryConfigOrDisable(supabase, GUILD, PRODUCT_ID);

    expect(result).toEqual({ ok: true });
    expect(calls.upserts).toEqual([{ product_id: PRODUCT_ID }]);
    expect(calls.productUpdates).toHaveLength(0);
  });

  it('tolerates the duplicate the DB trigger causes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { supabase, calls } = makeSupabase({
      configExistsAfterUpsert: true,
      upsertError: { message: 'duplicate key', code: '23505' },
    });

    const result = await ensureLicenseDeliveryConfigOrDisable(supabase, GUILD, PRODUCT_ID);

    expect(result).toEqual({ ok: true });
    expect(console.warn).not.toHaveBeenCalled();
    expect(calls.productUpdates).toHaveLength(0);
  });

  it('deactivates the product when the config still is not there', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { supabase, calls } = makeSupabase({
      configExistsAfterUpsert: false,
      upsertError: { message: 'permission denied', code: '42501' },
    });

    const result = await ensureLicenseDeliveryConfigOrDisable(supabase, GUILD, PRODUCT_ID);

    expect(result.ok).toBe(false);
    expect(calls.productUpdates).toHaveLength(1);
    expect(calls.productUpdates[0].payload).toMatchObject({ active: false });
    // Guild-scoped so one guild can never deactivate another's product.
    expect(calls.productUpdates[0].filters).toEqual({ id: PRODUCT_ID, guild_id: GUILD });
  });

  it('deactivates the product when verification cannot be performed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase, calls } = makeSupabase({
      configExistsAfterUpsert: true,
      readError: { message: 'connection reset' },
    });

    const result = await ensureLicenseDeliveryConfigOrDisable(supabase, GUILD, PRODUCT_ID);

    // An unverifiable rail is treated as a failed rail: never sell on a guess.
    expect(result.ok).toBe(false);
    expect(calls.productUpdates).toHaveLength(1);
  });

  it('still reports failure when the deactivation itself fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSupabase({
      configExistsAfterUpsert: false,
      updateError: { message: 'connection reset' },
    });

    const result = await ensureLicenseDeliveryConfigOrDisable(supabase, GUILD, PRODUCT_ID);

    expect(result.ok).toBe(false);
  });
});
