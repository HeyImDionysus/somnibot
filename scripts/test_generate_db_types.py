#!/usr/bin/env python3
"""Regression tests for migration-derived database type generation."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location(
    "generate_db_types", _HERE / "generate-db-types.py"
)
generator = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(generator)


class TestAlterColumnNullability(unittest.TestCase):
    def setUp(self):
        generator.tables.clear()

    def process(self, sql):
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".sql",
            dir=_HERE,
            encoding="utf-8",
            delete=False,
        ) as fixture:
            fixture.write(sql)
            migration = Path(fixture.name)
        try:
            generator.process_migration(migration)
        finally:
            migration.unlink(missing_ok=True)

    def column(self, table, column):
        return generator.tables[table].columns[column]

    def test_staged_set_not_null_overrides_nullable_add(self):
        self.process(
            """
            CREATE TABLE public.fraud_signals (id UUID PRIMARY KEY);
            ALTER TABLE public.fraud_signals
              ADD COLUMN last_observed_at TIMESTAMPTZ;
            ALTER TABLE public.fraud_signals
              ALTER COLUMN last_observed_at SET DEFAULT pg_catalog.now(),
              ALTER COLUMN last_observed_at SET NOT NULL;
            """
        )

        column = self.column("fraud_signals", "last_observed_at")
        self.assertFalse(column.nullable)
        self.assertEqual(column.to_ts_type(), "string")

    def test_drop_not_null_restores_nullable_type(self):
        self.process(
            """
            CREATE TABLE public.sessions (
              id UUID PRIMARY KEY,
              token_hash TEXT NOT NULL
            );
            ALTER TABLE public.sessions
              ALTER COLUMN token_hash DROP NOT NULL;
            """
        )

        column = self.column("sessions", "token_hash")
        self.assertTrue(column.nullable)
        self.assertEqual(column.to_ts_type(), "string | null")

    def test_last_nullability_action_wins_inside_one_alter(self):
        self.process(
            """
            CREATE TABLE public.events (observed_at TIMESTAMPTZ);
            ALTER TABLE public.events
              ALTER COLUMN observed_at SET NOT NULL,
              ALTER COLUMN observed_at DROP NOT NULL;
            """
        )

        self.assertTrue(self.column("events", "observed_at").nullable)

    def test_set_not_null_inside_do_block_is_processed(self):
        self.process(
            """
            CREATE TABLE "public"."portal_sessions" ("token_hash" TEXT);
            DO $$
            BEGIN
              IF true THEN
                ALTER TABLE IF EXISTS "public"."portal_sessions"
                  ALTER COLUMN "token_hash" SET NOT NULL;
              END IF;
            END
            $$;
            """
        )

        self.assertFalse(self.column("portal_sessions", "token_hash").nullable)

    def test_if_false_do_block_does_not_apply_alter(self):
        self.process(
            """
            CREATE TABLE public.portal_sessions (token_hash TEXT);
            DO $$
            BEGIN
              IF false THEN
                ALTER TABLE public.portal_sessions
                  ALTER COLUMN token_hash SET NOT NULL;
              END IF;
            END
            $$;
            """
        )

        self.assertTrue(self.column("portal_sessions", "token_hash").nullable)

    def test_data_dependent_do_block_does_not_apply_alter(self):
        self.process(
            """
            CREATE TABLE public.portal_sessions (token_hash TEXT);
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1
                  FROM public.portal_sessions
                 WHERE token_hash IS NULL
              ) THEN
                ALTER TABLE public.portal_sessions
                  ALTER COLUMN token_hash SET NOT NULL;
              END IF;
            END
            $$;
            """
        )

        self.assertTrue(self.column("portal_sessions", "token_hash").nullable)

    def test_exact_schema_guard_has_a_guaranteed_add_outcome(self):
        self.process(
            """
            CREATE TABLE public.audit_logs (id UUID PRIMARY KEY);
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1
                  FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'audit_logs'
                   AND column_name = 'category'
              ) THEN
                ALTER TABLE public.audit_logs
                  ADD COLUMN category TEXT DEFAULT 'system';
              END IF;
            END
            $$;
            """
        )

        self.assertFalse(self.column("audit_logs", "category").nullable)

    def test_schema_guard_without_schema_is_not_guaranteed(self):
        self.process(
            """
            CREATE TABLE public.audit_logs (id UUID PRIMARY KEY);
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1
                  FROM information_schema.columns
                 WHERE table_name = 'audit_logs'
                   AND column_name = 'category'
              ) THEN
                ALTER TABLE public.audit_logs
                  ADD COLUMN category TEXT DEFAULT 'system';
              END IF;
            END
            $$;
            """
        )

        self.assertNotIn("category", generator.tables["audit_logs"].columns)

    def test_unqualified_schema_guard_preserves_clean_chain_add(self):
        self.process(
            """
            CREATE TABLE public.audit_logs (id UUID PRIMARY KEY);
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1
                  FROM information_schema.columns
                 WHERE table_name = 'audit_logs'
                   AND column_name = 'category'
              ) THEN
                ALTER TABLE audit_logs
                  ADD COLUMN category TEXT DEFAULT 'system';
              END IF;
            END
            $$;
            """
        )

        self.assertFalse(self.column("audit_logs", "category").nullable)

    def test_schema_guard_for_other_schema_is_not_guaranteed(self):
        self.process(
            """
            CREATE TABLE public.audit_logs (id UUID PRIMARY KEY);
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1
                  FROM information_schema.columns
                 WHERE table_schema = 'archive'
                   AND table_name = 'audit_logs'
                   AND column_name = 'category'
              ) THEN
                ALTER TABLE public.audit_logs
                  ADD COLUMN category TEXT DEFAULT 'system';
              END IF;
            END
            $$;
            """
        )

        self.assertNotIn("category", generator.tables["audit_logs"].columns)

    def test_exception_swallowed_do_block_does_not_apply_alter(self):
        self.process(
            """
            CREATE TABLE public.portal_sessions (token_hash TEXT);
            DO $$
            BEGIN
              BEGIN
                ALTER TABLE public.portal_sessions
                  ALTER COLUMN token_hash SET NOT NULL;
              EXCEPTION WHEN others THEN
                NULL;
              END;
            END
            $$;
            """
        )

        self.assertTrue(self.column("portal_sessions", "token_hash").nullable)

    def test_drop_then_readd_column_follows_source_order(self):
        self.process(
            """
            CREATE TABLE public.events (payload TEXT NOT NULL);
            ALTER TABLE public.events
              DROP COLUMN payload,
              ADD COLUMN payload UUID;
            """
        )

        column = self.column("events", "payload")
        self.assertEqual(column.sql_type, "UUID")
        self.assertTrue(column.nullable)

    def test_add_drop_readd_and_nullability_follow_source_order(self):
        self.process(
            """
            CREATE TABLE public.events (id UUID PRIMARY KEY);
            ALTER TABLE public.events
              ADD COLUMN payload TEXT,
              DROP COLUMN payload,
              ADD COLUMN payload UUID,
              ALTER COLUMN payload SET NOT NULL;
            """
        )

        column = self.column("events", "payload")
        self.assertEqual(column.sql_type, "UUID")
        self.assertFalse(column.nullable)

    def test_quoted_identifiers_preserve_spaces_and_mixed_case(self):
        self.process(
            """
            CREATE TABLE "App Schema"."Order Events" (
              "Event ID" UUID PRIMARY KEY,
              "Display Name" TEXT
            );
            ALTER TABLE "App Schema"."Order Events"
              ALTER COLUMN "Display Name" SET NOT NULL;
            """
        )

        table = generator.tables["Order Events"]
        self.assertEqual(table.pk_columns, ["Event ID"])
        self.assertFalse(table.columns["Display Name"].nullable)
        rendered = generator.generate_row_interface(table, "DbOrderEvent")
        self.assertIn('  "Display Name": string;', rendered)

    def test_quoted_identifiers_unescape_doubled_quotes(self):
        self.process(
            '''
            CREATE TABLE "public"."Quote ""Registry""" (
              "Value ""Label""" TEXT
            );
            ALTER TABLE "public"."Quote ""Registry"""
              ALTER COLUMN "Value ""Label""" SET NOT NULL;
            '''
        )

        table = generator.tables['Quote "Registry"']
        self.assertFalse(table.columns['Value "Label"'].nullable)
        rendered = generator.generate_row_interface(table, "DbQuoteRegistry")
        self.assertIn('  "Value \\"Label\\"": string;', rendered)

    def test_unknown_table_and_column_are_no_ops(self):
        self.process(
            """
            CREATE TABLE public.known_table (known_column TEXT);
            ALTER TABLE public.known_table
              ALTER COLUMN missing_column SET NOT NULL;
            ALTER TABLE public.missing_table
              ALTER COLUMN phantom_column SET NOT NULL;
            """
        )

        self.assertEqual(list(generator.tables), ["known_table"])
        self.assertEqual(
            list(generator.tables["known_table"].columns),
            ["known_column"],
        )
        self.assertTrue(self.column("known_table", "known_column").nullable)


if __name__ == "__main__":
    unittest.main(verbosity=2)
