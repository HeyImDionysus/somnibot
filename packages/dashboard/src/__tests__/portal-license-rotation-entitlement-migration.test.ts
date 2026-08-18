import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20260817215000_portal_license_rotation_entitlement_guard.sql'),
  'utf8',
);

describe('portal license rotation entitlement guard migration', () => {
  it('locks the exact usable entitlement before revoking or minting a key', () => {
    const entitlementLock = migration.indexOf('SELECT entitlement.* INTO v_entitlement');
    const predecessorRevocation = migration.indexOf("SET status = 'revoked'");

    expect(entitlementLock).toBeGreaterThan(-1);
    expect(predecessorRevocation).toBeGreaterThan(entitlementLock);
    expect(migration).toContain("entitlement.status = 'active'");
    expect(migration).toContain('entitlement.expires_at IS NULL');
    expect(migration).toContain('entitlement.expires_at > v_now');
    expect(migration).toContain("entitlement.status = 'grace_period'");
    expect(migration).toContain('entitlement.grace_period_ends_at > v_now');
    expect(migration).toContain('entitlement.license_key_id = v_old.id');
    expect(migration).toContain('entitlement.order_id = v_old.order_id');
    expect(migration).toContain('entitlement.customer_id = v_old.customer_id');
    expect(migration).toContain('entitlement.product_id = v_old.product_id');
    expect(migration).toContain('entitlement.guild_id = v_old.guild_id');
    expect(migration.slice(entitlementLock, predecessorRevocation)).toContain('FOR UPDATE');
  });

  it('fails closed and keeps the private helper unavailable to API roles', () => {
    expect(migration).toContain('license_rotate_key_without_receipt_stage: entitlement is not usable');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.license_rotate_key_without_receipt_stage');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
  });
});
