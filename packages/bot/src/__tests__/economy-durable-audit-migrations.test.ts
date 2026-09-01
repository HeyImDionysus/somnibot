import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const petAuditMigration = readFileSync(fileURLToPath(new URL(
  '../../../supabase/migrations/20260823120400_economy_pet_durable_audits.sql',
  import.meta.url,
)), 'utf8');

const farmingMigration = readFileSync(fileURLToPath(new URL(
  '../../../supabase/migrations/20260818100000_farming_operation_idempotency.sql',
  import.meta.url,
)), 'utf8');

describe('durable game-economy audit migrations', () => {
  it('commits pet acquire and care audits from the operation ledger trigger', () => {
    // Given: acquire and care mutations already append economy_pet_operations rows.
    // When: the migration installs its transaction-local audit trigger.
    // Then: every applied operation maps to a stable audit action and occurrence key.
    expect(petAuditMigration).toMatch(/AFTER INSERT ON public\.economy_pet_operations/);
    expect(petAuditMigration).toContain("WHEN 'buy' THEN 'pet.acquired'");
    expect(petAuditMigration).toContain("WHEN 'feed' THEN 'pets.fed'");
    expect(petAuditMigration).toContain("WHEN 'train' THEN 'pets.trained'");
    expect(petAuditMigration).toContain("WHEN 'play' THEN 'pets.played'");
    expect(petAuditMigration).toContain("v_action || ':' || NEW.request_id");
  });

  it('commits battle state, keyed payout ledger, and audit in one RPC', () => {
    // Given: a pet battle carries one Discord operation id.
    // When: economy_pet_battle_atomic resolves it.
    // Then: replay is fenced and payout plus audit share the same transaction.
    expect(petAuditMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.economy_pet_battle_atomic\(/);
    expect(petAuditMigration).toContain("'pet:battle:' || p_operation_id || ':payout'");
    expect(petAuditMigration).toContain("'pet.battle_resolved:' || p_operation_id");
    expect(petAuditMigration).toMatch(/'status', 'resolved', 'replayed', true/);
  });

  it('fences pet and member prestige audit occurrences durably', () => {
    // Given: prestige commands can be redelivered after a successful commit.
    // When: either prestige path applies its state transition.
    // Then: the interaction id fences both the mutation and immutable audit row.
    expect(petAuditMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.economy_pet_atomic_prestige_audited\(/);
    expect(petAuditMigration).toContain("operation = 'prestige'");
    expect(petAuditMigration).toContain("'pet.prestiged:' || p_request_id");
    expect(petAuditMigration).toMatch(/AFTER INSERT OR UPDATE OF last_request_id ON public\.economy_prestige/);
    expect(petAuditMigration).toContain("'prestige.performed:' || NEW.last_request_id");
  });

  it('retains the existing atomic farming-operation audit contract', () => {
    // Given: farming plant, water, and fertilize already use one operation RPC.
    // When: the RPC records its idempotency result.
    // Then: it also writes the audit row before the transaction returns.
    expect(farmingMigration).toContain('INSERT INTO public.economy_farming_operations');
    expect(farmingMigration).toContain('INSERT INTO public.audit_logs');
    expect(farmingMigration).toContain("v_action || ':' || p_operation_id");
  });
});
