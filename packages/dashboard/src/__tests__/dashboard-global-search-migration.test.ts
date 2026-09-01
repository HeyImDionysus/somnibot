import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20260823143000_dashboard_global_search.sql'),
  'utf8',
);

describe('dashboard global search migration', () => {
  it('searches every dynamic provider through a guild predicate and caller allowlist', () => {
    for (const table of ['products', 'customers', 'members', 'incidents', 'audit_logs']) {
      expect(migration).toContain(`FROM public.${table}`);
    }
    expect(migration.match(/guild_id = p_guild_id/g)?.length).toBe(5);
    expect(migration).toContain("p_kinds <@ ARRAY['products', 'customers', 'members', 'incidents', 'audits']::TEXT[]");
  });

  it('keeps the RPC behind the service boundary', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.search_dashboard_control_center[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.search_dashboard_control_center[\s\S]+TO service_role/);
  });
});
