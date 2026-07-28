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
        with tempfile.TemporaryDirectory() as temp_dir:
            migration = Path(temp_dir) / "20260727000000_fixture.sql"
            migration.write_text(sql, encoding="utf-8")
            generator.process_migration(migration)

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
