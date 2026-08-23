import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20260823122000_license_plan_capability_lookup.sql'),
  'utf8',
);

describe('license plan capability lookup migration', () => {
  it('returns the authoritative entitlement plan and completed-project policy', () => {
    expect(migration).toContain("'entitlement_plan_id', v_entitlement.plan_id");
    expect(migration).toContain("metadata -> 'completed_project_licensing' AS licensing_metadata");
    expect(migration).toContain("'product_licensing_metadata', v_product.licensing_metadata");
  });

  it('keeps the composite lookup restricted to the service role', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path =');
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.license_validate_lookup\(text, uuid\)[\s\S]+FROM public, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.license_validate_lookup\(text, uuid\)[\s\S]+TO service_role/);
  });
});
