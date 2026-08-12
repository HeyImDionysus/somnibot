import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20260812010000_external_webhook_relays.sql'),
  'utf8',
);

describe('external webhook relay migration', () => {
  it('keeps receiver tokens hashed and both tables service-role-only', () => {
    expect(migration).toContain('token_hash TEXT NOT NULL UNIQUE');
    expect(migration).not.toContain('token_plaintext');
    expect(migration).toContain('ALTER TABLE public.external_webhook_relays ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE public.external_webhook_deliveries ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE public.external_webhook_relays FROM anon, authenticated');
    expect(migration).toContain('REVOKE ALL ON TABLE public.external_webhook_deliveries FROM anon, authenticated');
  });

  it('provides idempotency, retry state, bounded fields, and guild cleanup', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX external_webhook_deliveries_idempotency_idx');
    expect(migration).toContain('(relay_id, idempotency_key)');
    expect(migration).toContain('WHERE idempotency_key IS NOT NULL');
    expect(migration).toContain("status TEXT NOT NULL DEFAULT 'processing'");
    expect(migration).toContain("status IN ('processing', 'delivered', 'failed', 'duplicate', 'retryable')");
    expect(migration).toContain('attempt_count INTEGER NOT NULL DEFAULT 1');
    expect(migration).toContain('ON DELETE CASCADE');
    expect(migration).toContain('char_length(message_template) BETWEEN 1 AND 1900');
  });

  it('claims idempotency atomically without exposing the function publicly', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.claim_external_webhook_delivery');
    expect(migration).toContain('ON CONFLICT (relay_id, idempotency_key)');
    expect(migration).toContain("WHERE idempotency_key IS NOT NULL");
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.claim_external_webhook_delivery');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.claim_external_webhook_delivery');
  });
});
