import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../supabase/migrations/20260831081000_sandbox_launch_persistence.sql'), 'utf8');

function functionBody(name: string): string {
  const match = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`, 'i'));
  return match?.[1] ?? '';
}

describe('Sandbox launch persistence migration policy', () => {
  it('adds upgrade columns before functions depend on them', () => {
    // Given an installation that has already applied the older commerce migration.
    const requiredColumns = [
      ['commerce_product_launch_runs', 'verification_started_at'],
      ['commerce_checkout_intents', 'launch_run_id'],
      ['commerce_free_claims', 'launch_run_id'],
    ];

    // When only the append-only release migration is applied.
    const firstFunction = sql.indexOf('CREATE OR REPLACE FUNCTION');

    // Then each missing column is added before any function references its row type.
    for (const [table, column] of requiredColumns) {
      const position = sql.search(new RegExp(`ALTER TABLE public\\.${table}\\s+ADD COLUMN IF NOT EXISTS ${column}`));
      expect(position).toBeGreaterThan(-1);
      expect(position).toBeLessThan(firstFunction);
    }
  });

  it('ships activation repairs without changing a previously published migration', () => {
    // Given the canonical content of the previously committed migration.
    const legacy = readFileSync(resolve(process.cwd(), '../supabase/migrations/20260823170000_commerce_operations_control.sql'), 'utf8');
    const canonical = `${legacy.replace(/\r\n/g, '\n').trimEnd()}\n`;

    // When locating the effective activation guard in the new migration.
    const activation = functionBody('commerce_activate_product_launch');

    // Then upgrades receive the repair and the older migration keeps its checksum.
    expect(activation).toContain('IF NOT FOUND THEN RETURN NEW; END IF;');
    expect(activation).toContain("launch_receipt->>'product_revision'");
    expect(activation).toContain("launch_receipt->>'policy_revision'");
    expect(createHash('sha256').update(canonical).digest('hex')).toBe('bae5a615826d5d69c23e7724937ecd872b8e22407ef2b845abfb71e959c4ef16');
  });

  it('binds free proof before freezing and completing its order', () => {
    // Given the append-only launch RPC definition.
    const body = functionBody('commerce_claim_free_product_for_launch');

    // When locating the durable proof and freeze operations.
    const proof = body.indexOf('INSERT INTO public.commerce_free_claims');
    const freeze = body.indexOf('SET granted_role_ids_snapshot');

    // Then proof is part of the same transaction, before fulfillment can exist.
    expect(body).not.toBe('');
    expect(proof).toBeGreaterThan(-1);
    expect(freeze).toBeGreaterThan(proof);
    expect(body).toMatch(/INSERT INTO public\.commerce_free_claims\s*\([^)]*launch_run_id/s);
    expect(body).toContain('pg_catalog.pg_advisory_xact_lock');
  });

  it('binds paid provider identity before creating and freezing a launch order', () => {
    // Given the dedicated launch checkout RPC definition.
    const body = functionBody('commerce_create_and_bind_launch_paid_checkout');

    // When locating provider and order persistence.
    const binding = body.indexOf('SET provider_id = p_provider_id');
    const order = body.indexOf('INSERT INTO public.orders');

    // Then the grant guard can validate a durable owner-scoped Sandbox intent.
    expect(body).not.toBe('');
    expect(binding).toBeGreaterThan(-1);
    expect(order).toBeGreaterThan(binding);
    expect(body).toContain('commerce_require_launch_checkout_intent');
    expect(body).toContain('pg_catalog.pg_advisory_xact_lock');
    expect(body).toContain('FOR UPDATE');
  });

  it('keeps ordinary checkout RPCs and their active-only contracts unchanged', () => {
    // Given the existing public purchase entrypoints.
    const ordinary = [
      'commerce_claim_free_product', 'commerce_create_active_paid_checkout',
      'commerce_create_and_bind_active_paid_checkout', 'commerce_reserve_checkout_pricing',
      'commerce_select_checkout_plan',
    ];

    // When examining definitions introduced by this migration.
    const rewritten = ordinary.filter((name) => functionBody(name) !== '');

    // Then the Sandbox flow cannot silently replace an ordinary purchase RPC.
    expect(rewritten).toEqual([]);
  });

  it('allows launch removal to detach proof only after its parent run is gone', () => {
    // Given proof rows whose foreign keys preserve orders when a launch is removed.
    const guards = ['commerce_preserve_checkout_launch_identity', 'commerce_preserve_free_launch_identity'];

    // When checking the narrow exception before each immutable-proof guard.
    for (const name of guards) {
      const body = functionBody(name);
      const removal = body.indexOf('NEW.launch_run_id IS NULL');

      // Then only the run reference changes, and an existing run cannot be detached.
      expect(removal).toBeGreaterThan(-1);
      expect(body).toContain("pg_catalog.to_jsonb(NEW) - 'launch_run_id'");
      expect(body).toContain("pg_catalog.to_jsonb(OLD) - 'launch_run_id'");
      expect(body).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM public\.commerce_product_launch_runs WHERE id = OLD\.launch_run_id\s*\)/);
      expect(removal).toBeLessThan(body.indexOf('RAISE EXCEPTION'));
    }
  });

  it('restricts launch admission to the current owner and verification attempt', () => {
    // Given the shared database authorization boundary.
    const body = functionBody('commerce_require_sandbox_product_launch');

    // When checking its machine-enforced identity conditions.
    const predicates = [
      'launch.guild_id = p_guild_id', 'launch.product_id = p_product_id',
      "launch.environment = 'sandbox'", 'launch.created_by = v_customer.discord_id',
      'owner_guild.owner_discord_id = v_customer.discord_id',
      'launch.verification_started_at = p_verification_started_at',
      'v_product.active IS DISTINCT FROM false',
    ];

    // Then every identity dimension is enforced under row locks.
    for (const predicate of predicates) expect(body).toContain(predicate);
    expect(body).toContain('FOR SHARE');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.commerce_require_sandbox_product_launch\([^;]*FROM PUBLIC, anon, authenticated, service_role;/s);
  });
});
