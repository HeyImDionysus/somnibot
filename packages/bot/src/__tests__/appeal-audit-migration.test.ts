import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../supabase/migrations/20260802010000_appeal_audit_lifecycle.sql',
  ),
  'utf8',
);

describe('appeal lifecycle audit migration', () => {
  it('audits each lifecycle transition atomically with a deterministic occurrence key', () => {
    expect(migration).toContain("v_action := 'appeal.submitted'");
    expect(migration).toContain("NEW.status IN ('approved', 'denied', 'expired')");
    expect(migration).toContain('AFTER INSERT OR UPDATE OF status ON public.appeals');
    expect(migration).toContain('ON CONFLICT (guild_id, occurrence_key) DO NOTHING');
  });

  it('is search-path-safe, service-role-only, and refuses an unknown pre-existing object', () => {
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain('pg_catalog.md5(pg_catalog.pg_get_functiondef(v_function_oid))');
    expect(migration).toContain('5589be0edf72c6a6560aaa1b465d6c4a');
    expect(migration).toContain('RAISE EXCEPTION USING');
    expect(migration).toContain('pg_catalog.jsonb_build_object');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.audit_appeal_lifecycle() FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.audit_appeal_lifecycle() TO service_role');
  });
});
