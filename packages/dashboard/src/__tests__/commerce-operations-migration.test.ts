import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('../../../supabase/migrations/20260823170000_commerce_operations_control.sql', import.meta.url),
  'utf8',
);

describe('commerce operations migration', () => {
  it('creates guild-scoped launch, exception, event and risk records with service-role-only access', () => {
    for (const table of [
      'commerce_product_launch_runs',
      'commerce_revenue_exceptions',
      'commerce_revenue_exception_events',
      'commerce_risk_cases',
      'commerce_risk_effect_actions',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated, service_role`);
    }
  });

  it('uses database constraints for lifecycle and dedupe invariants', () => {
    expect(sql).toContain('UNIQUE (guild_id, product_id)');
    expect(sql).toContain('UNIQUE (guild_id, source_kind, source_id)');
    expect(sql).toContain('commerce_revenue_exception_version_positive');
    expect(sql).toContain('commerce_risk_case_kind_check');
    expect(sql).toContain("type IN ('refund', 'service', 'identity_relink', 'download_help')");
    expect(sql).toContain('commerce_alert_exception_trigger');
    expect(sql).toContain('commerce_fraud_exception_trigger');
    expect(sql).toContain('commerce_fulfillment_exception_trigger');
    expect(sql).toContain('commerce_transition_revenue_exception');
    expect(sql).toContain('commerce_transition_risk_case');
    expect(sql).toContain('commerce_activate_product_launch');
    expect(sql).toContain('commerce_create_tutorial_launch');
    expect(sql).toContain("'fulfillment'");
    expect(sql).toContain("'entitlement'");
    expect(sql).toContain("'notification'");
    expect(sql).toContain('provider_fee_cents');
    expect(sql).toContain('provider_net_cents');
  });
});
