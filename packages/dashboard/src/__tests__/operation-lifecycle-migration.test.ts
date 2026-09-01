import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20260823135000_shared_operation_lifecycle.sql'),
  'utf8',
);

describe('shared operation lifecycle migration', () => {
  it('persists one immutable identity across lifecycle events and external effects', () => {
    expect(migration).toContain('CREATE TABLE public.significant_operations');
    expect(migration).toContain('CREATE TABLE public.operation_events');
    expect(migration).toContain('CREATE TABLE public.configuration_releases');
    expect(migration).toContain('UNIQUE (guild_id, source_surface, idempotency_key)');
    expect(migration).toContain('operation_id UUID NOT NULL REFERENCES public.significant_operations(id)');
  });

  it('serializes idempotent preparation and optimistic lifecycle transitions', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.prepare_significant_operation');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.advance_significant_operation');
    expect(migration).toContain('p_expected_revision');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("MESSAGE = 'significant operation: stale revision'");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.record_significant_operation_failure');
  });

  it('records conflict, blast-radius, readback, audit, and recovery evidence', () => {
    expect(migration).toContain('conflicts JSONB NOT NULL');
    expect(migration).toContain('blast_radius JSONB NOT NULL');
    expect(migration).toContain('readback JSONB');
    expect(migration).toContain('audit_evidence JSONB');
    expect(migration).toContain('recovery_evidence JSONB');
    expect(migration).toContain("recovery_outcome IN ('rolled_back', 'compensated', 'forward_fixed')");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.prepare_configuration_release');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.activate_configuration_release');
    expect(migration).toContain('base_snapshot JSONB NOT NULL');
    expect(migration).toContain('target_snapshot JSONB NOT NULL');
    expect(migration).toContain('config_diff JSONB NOT NULL');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.record_configuration_release_readback');
  });

  it('restricts tables and lifecycle RPCs to the service role', () => {
    expect(migration).toMatch(/REVOKE ALL ON public\.significant_operations[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.prepare_significant_operation[\s\S]+TO service_role/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.advance_significant_operation[\s\S]+TO service_role/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.recover_significant_operation[\s\S]+TO service_role/);
  });
});
