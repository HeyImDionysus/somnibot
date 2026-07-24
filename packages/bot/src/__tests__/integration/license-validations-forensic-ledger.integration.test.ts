/**
 * Integration coverage for the license_validations forensic audit ledger
 * (migration 20260724110000_license_validations_forensic_ledger).
 *
 * license_validations is a PERMANENT ledger: rows are NEVER hard-deleted, only
 * anonymized past the retention boundary. These tests prove the four properties
 * the migration guarantees against the real local Supabase stack:
 *
 *   1. deleting a parent license_keys row DETACHES (SET NULL) the validation
 *      history instead of cascading it away;
 *   2. the generic cleaner refuses license_validations outright;
 *   3. scrub_expired_license_validations anonymizes PII past retention while
 *      retaining the forensic skeleton (result + created_at), and is idempotent;
 *   4. prune_expired_data no longer DELETEs license_validations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDbUrl, requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
let sql!: ReturnType<typeof postgres>;

const GUILD_ID = `license-ledger-${Date.now()}`;
const DISCORD_ID = '410000000000000001';
const keyHashes: string[] = [];
const validationIds: string[] = [];
let seededProductId: string;

/** Insert a license key with only its required columns; FKs stay NULL. */
async function seedKey(status = 'active'): Promise<string> {
  const keyHash = `ledger-hash-${randomUUID()}`;
  keyHashes.push(keyHash);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO public.license_keys
      (key_hash, key_prefix, key_suffix, bound_discord_id, status)
    VALUES (${keyHash}, 'LEDG', 'TAIL', ${DISCORD_ID}, ${status})
    RETURNING id
  `;
  return row!.id;
}

async function seedValidation(opts: {
  keyId?: string | null;
  productId?: string | null;
  createdAt?: string; // SQL interval expression relative to now(), e.g. '200 days'
  result?: string;
}): Promise<string> {
  const id = randomUUID();
  validationIds.push(id);
  await sql`
    INSERT INTO public.license_validations
      (id, license_key_id, product_id, device_fingerprint, result, ip_address, app_version, created_at)
    VALUES (
      ${id},
      ${opts.keyId ?? null},
      ${opts.productId ?? null},
      'fingerprint-plaintext',
      ${opts.result ?? 'valid'},
      '203.0.113.7',
      'app-1.2.3',
      pg_catalog.now() - ${opts.createdAt ?? '0 days'}::interval
    )
  `;
  return id;
}

beforeAll(async () => {
  supa = await requireSupabase();
  sql = postgres(getTestDbUrl(), { max: 1 });

  const { error: guildError } = await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'License Ledger Test Guild',
    owner_discord_id: '410000000000000009',
  });
  if (guildError) throw new Error(`Guild seed failed: ${guildError.message}`);

  const { data: product, error: productError } = await supa
    .from('products')
    .insert({
      guild_id: GUILD_ID,
      name: 'Ledger Test Product',
      type: 'one_time',
      delivery_type: 'file',
      price_cents: 1000,
    })
    .select('id')
    .single();
  if (productError) throw new Error(`Product seed failed: ${productError.message}`);
  seededProductId = product!.id;
});

afterAll(async () => {
  if (validationIds.length > 0) {
    await sql`DELETE FROM public.license_validations WHERE id = ANY(${validationIds})`;
  }
  if (keyHashes.length > 0) {
    await sql`DELETE FROM public.license_keys WHERE key_hash = ANY(${keyHashes})`;
  }
  await supa.from('products').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
  await sql.end({ timeout: 5 });
});

describe('license_validations forensic ledger', () => {
  it('the FK is ON DELETE SET NULL (confdeltype = n), not CASCADE', async () => {
    const [constraint] = await sql<{ confdeltype: string }[]>`
      SELECT confdeltype
        FROM pg_catalog.pg_constraint
       WHERE conname = 'license_validations_license_key_id_fkey'
    `;
    // 'n' = SET NULL, 'c' = CASCADE (the old, forensics-erasing behavior).
    expect(constraint?.confdeltype).toBe('n');
  });

  it('deleting a license key DETACHES its validation history instead of erasing it', async () => {
    const keyId = await seedKey();
    const validationId = await seedValidation({ keyId, productId: seededProductId });

    await sql`DELETE FROM public.license_keys WHERE id = ${keyId}`;

    const rows = await sql<{ id: string; license_key_id: string | null; result: string }[]>`
      SELECT id, license_key_id, result
        FROM public.license_validations
       WHERE id = ${validationId}
    `;
    // The row SURVIVES the key deletion, with its key linkage nulled out.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.license_key_id).toBeNull();
    expect(rows[0]!.result).toBe('valid');
  });

  it('cleanup_old_records refuses license_validations outright', async () => {
    await expect(
      sql`SELECT public.cleanup_old_records('license_validations', 90)`,
    ).rejects.toThrow(/never deleted/i);
  });

  it('cleanup_old_records still serves an allowlisted table (economy_transactions)', async () => {
    // 90 == the min retention, so nothing is actually deleted; the call simply
    // must not raise, proving only license_validations was carved out.
    const rows = await sql<{ cleanup_old_records: number }[]>`
      SELECT public.cleanup_old_records('economy_transactions', 90) AS cleanup_old_records
    `;
    expect(typeof rows[0]!.cleanup_old_records).toBe('number');
  });

  it('scrub anonymizes PII past retention but keeps the forensic skeleton', async () => {
    const keyId = await seedKey();
    const validationId = await seedValidation({
      keyId,
      productId: seededProductId,
      createdAt: '200 days',
      result: 'over_device_limit',
    });

    const before = await sql<{ created_at: string }[]>`
      SELECT created_at FROM public.license_validations WHERE id = ${validationId}
    `;

    await sql`SELECT public.scrub_expired_license_validations(60)`;

    const [row] = await sql<{
      ip_address: string | null;
      device_fingerprint: string | null;
      app_version: string | null;
      result: string;
      created_at: string;
    }[]>`
      SELECT ip_address, device_fingerprint, app_version, result, created_at
        FROM public.license_validations
       WHERE id = ${validationId}
    `;
    // PII gone…
    expect(row!.ip_address).toBeNull();
    expect(row!.device_fingerprint).toBe('anonymized');
    expect(row!.app_version).toBeNull();
    // …forensic skeleton retained.
    expect(row!.result).toBe('over_device_limit');
    expect(new Date(row!.created_at).getTime()).toBe(new Date(before[0]!.created_at).getTime());
  });

  it('scrub is idempotent — a re-run leaves the already-anonymized row untouched', async () => {
    const keyId = await seedKey();
    const validationId = await seedValidation({
      keyId,
      productId: seededProductId,
      createdAt: '200 days',
    });

    await sql`SELECT public.scrub_expired_license_validations(60)`;
    await sql`SELECT public.scrub_expired_license_validations(60)`;

    const [row] = await sql<{ device_fingerprint: string | null; result: string }[]>`
      SELECT device_fingerprint, result
        FROM public.license_validations
       WHERE id = ${validationId}
    `;
    expect(row!.device_fingerprint).toBe('anonymized');
    expect(row!.result).toBe('valid');
  });

  it('scrub refuses a retention window below the 60-day floor', async () => {
    await expect(
      sql`SELECT public.scrub_expired_license_validations(30)`,
    ).rejects.toThrow(/at least 60/i);
  });

  it('prune_expired_data no longer DELETEs license_validations', async () => {
    const keyId = await seedKey();
    // A 200-day-old, guild-linked validation — exactly what the OLD prune deleted.
    const validationId = await seedValidation({
      keyId,
      productId: seededProductId,
      createdAt: '200 days',
    });

    const { data, error } = await supa.rpc('prune_expired_data', { p_guild_id: GUILD_ID });
    expect(error).toBeNull();
    expect(data).toMatchObject({ old_license_validations: 0 });

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM public.license_validations WHERE id = ${validationId}
    `;
    // The old row SURVIVES the prune.
    expect(rows).toHaveLength(1);
  });
});
