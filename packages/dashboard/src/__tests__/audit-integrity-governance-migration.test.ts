import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20260823130000_security_governance.sql'),
  'utf8',
);

describe('audit integrity governance migration', () => {
  it('assigns every audit row an operation identity and append-only integrity event', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS operation_id TEXT');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.audit_log_integrity_events');
    expect(migration).toContain('AFTER INSERT OR UPDATE ON public.audit_logs');
    expect(migration).toContain("COALESCE(NULLIF(NEW.correlation_id, ''), NULLIF(NEW.occurrence_key, ''), NEW.id::text)");
    expect(migration).toContain('extensions.digest');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.audit_log_content_hash');
    expect(migration).toContain("'integrity_version', 1");
  });

  it('permits only the established anonymization transition after insertion', () => {
    expect(migration).toContain("NEW.actor_id NOT IN (OLD.actor_id, 'anonymized', 'deleted_user')");
    expect(migration).toContain("RAISE EXCEPTION 'audit_logs are append-only except for the sanctioned anonymization transition'");
    expect(migration).toContain("change_kind := 'anonymized'");
    expect(migration).toContain("NEW.operation_id := 'audit:' || NEW.id::text");
  });

  it('keeps integrity evidence private and immutable', () => {
    expect(migration).toContain('ALTER TABLE public.audit_log_integrity_events ENABLE ROW LEVEL SECURITY');
    expect(migration).toMatch(/REVOKE ALL ON public\.audit_log_integrity_events[\s\S]+FROM PUBLIC, anon, authenticated, service_role/);
    expect(migration).toContain('GRANT SELECT ON public.audit_log_integrity_events TO service_role');
    expect(migration).toContain('CREATE TRIGGER trg_prevent_audit_integrity_mutation');
    expect(migration).not.toMatch(/audit_log_integrity_events \([\s\S]{0,200}guild_id TEXT/);
  });

  it('provides a service-only verifier for current-row and chain integrity', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.verify_audit_integrity');
    expect(migration).toContain('SET search_path =');
    expect(migration).toContain('e.event_hash IS DISTINCT FROM e.expected_event_hash');
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.verify_audit_integrity\(text\)[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.verify_audit_integrity\(text\)[\s\S]+TO service_role/);
  });
});
