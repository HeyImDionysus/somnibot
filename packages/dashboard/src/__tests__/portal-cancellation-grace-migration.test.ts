import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20260817225500_portal_cancellation_grace_fulfillment_guard.sql'),
  'utf8',
);

describe('portal cancellation grace fulfillment guard migration', () => {
  it('preserves the later local grace boundary on cancellation queue writes', () => {
    expect(migration).toContain('commerce_preserve_cancellation_grace_boundary');
    expect(migration).toContain("NEW.action = 'fulfill_cancellation'");
    expect(migration).toContain("entitlement.status = 'grace_period'");
    expect(migration).toContain("entitlement.portal_cancellation_timing = 'end-of-term'");
    expect(migration).toContain('entitlement.grace_period_ends_at > pg_catalog.clock_timestamp()');
    expect(migration).toContain('NEW.next_retry_at < v_grace_until');
    expect(migration).toContain('NEW.next_retry_at := v_grace_until');
  });

  it('persists the portal policy marker without classifying provider cancellations', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS portal_cancellation_timing TEXT');
    expect(migration).toContain("portal_cancellation_timing IN ('immediate', 'end-of-term')");
    expect(migration).toContain(
      'NULL for provider, seller, and lifecycle cancellations.',
    );
  });

  it('backfills unprocessed cancellation carriers and keeps the helper private', () => {
    expect(migration).toContain("queue.status IN ('staged', 'pending', 'failed')");
    expect(migration).toContain('SET next_retry_at = boundary.grace_until');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.commerce_preserve_cancellation_grace_boundary()',
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
  });
});
