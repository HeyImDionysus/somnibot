import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20260823142000_dashboard_adoption_map.sql'),
  'utf8',
);

describe('dashboard adoption-map migration', () => {
  it('keeps desired state guild-scoped, versioned, and separate from verification evidence', () => {
    expect(migration).toContain('guild_id TEXT PRIMARY KEY REFERENCES public.guild(id) ON DELETE CASCADE');
    expect(migration).toContain("CHECK (mode IN ('guided', 'expert'))");
    expect(migration).toContain('track_states JSONB');
    expect(migration).toContain('revision BIGINT NOT NULL DEFAULT 0');
    expect(migration).toContain('CREATE TABLE public.dashboard_adoption_verifications');
    expect(migration).not.toContain('verified_track_ids TEXT[]');
  });

  it('keeps browser roles off the table and allows only the authenticated service boundary', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.dashboard_adoption_maps, public.dashboard_adoption_verifications FROM PUBLIC, anon, authenticated');
  });

  it('publishes through lifecycle, release, readback, audit, and rollback in one service-only transaction', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.publish_dashboard_adoption_map');
    expect(migration).toContain('public.prepare_significant_operation');
    expect(migration).toContain('public.prepare_configuration_release');
    expect(migration).toContain('public.record_configuration_release_readback');
    expect(migration).toContain("'dashboard.adoption_map.published'");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.rollback_dashboard_adoption_release');
    expect(migration).toContain("status = 'rolled_back', recovered_readback = v_readback");
    expect(migration).toContain("operation.idempotency_key = p_idempotency_key");
    expect(migration).toContain("MESSAGE = 'adoption map: idempotency intent mismatch'");
  });
});
