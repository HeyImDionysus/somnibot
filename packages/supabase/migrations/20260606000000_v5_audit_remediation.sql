-- V5 Audit Remediation — RLS, Index Fixes, RBAC Cleanup
-- Addresses findings from the V5 Full Repository Production Audit.

-- ═══════════════════════════════════════════════════════════════════
-- §4.4 — Enable RLS on economy core tables
-- Even though dashboard access goes through service_role (which bypasses
-- RLS), enabling RLS + a service-role-only policy provides defense-in-depth
-- if the anon key is ever exposed.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS economy_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS economy_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS economy_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS economy_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS economy_role_income ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS economy_streaks ENABLE ROW LEVEL SECURITY;

-- Default-deny: anon and authenticated roles get no access.
-- The service_role bypasses RLS entirely, so the bot and dashboard
-- continue working unchanged.

-- economy_wallets
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'economy_wallets_deny_all' AND tablename = 'economy_wallets') THEN
    CREATE POLICY economy_wallets_deny_all ON economy_wallets FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;

-- economy_transactions
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'economy_transactions_deny_all' AND tablename = 'economy_transactions') THEN
    CREATE POLICY economy_transactions_deny_all ON economy_transactions FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;

-- economy_inventory
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'economy_inventory_deny_all' AND tablename = 'economy_inventory') THEN
    CREATE POLICY economy_inventory_deny_all ON economy_inventory FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;

-- economy_items
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'economy_items_deny_all' AND tablename = 'economy_items') THEN
    CREATE POLICY economy_items_deny_all ON economy_items FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;

-- economy_role_income
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'economy_role_income_deny_all' AND tablename = 'economy_role_income') THEN
    CREATE POLICY economy_role_income_deny_all ON economy_role_income FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;

-- economy_streaks
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'economy_streaks_deny_all' AND tablename = 'economy_streaks') THEN
    CREATE POLICY economy_streaks_deny_all ON economy_streaks FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════
-- §5.6 — Add missing FK on license_validations.license_key_id
-- If the column exists but has no FK, add one. If the table doesn't
-- exist, this is a no-op.
-- ═══════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'license_validations' AND column_name = 'license_key_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_name = 'license_validations'
      AND kcu.column_name = 'license_key_id'
      AND tc.constraint_type = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE license_validations
      ADD CONSTRAINT fk_license_validations_key
      FOREIGN KEY (license_key_id) REFERENCES license_keys(id) ON DELETE SET NULL;
  END IF;
END $$;
