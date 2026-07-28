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

    def build(self, sql):
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".sql",
            dir=_HERE,
            encoding="utf-8",
            delete=False,
        ) as fixture:
            fixture.write(sql)
            migration = Path(fixture.name)
        original_migrations_dir = generator.MIGRATIONS_DIR
        generator.MIGRATIONS_DIR = migration.parent
        try:
            return generator.build_types()
        finally:
            generator.MIGRATIONS_DIR = original_migrations_dir
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

    def test_case_else_does_not_activate_outer_false_if(self):
        self.process(
            """
            CREATE TABLE public.t(c TEXT);
            DO $$
            BEGIN
              IF false THEN
                CASE 1
                  WHEN 1 THEN PERFORM 1;
                  ELSE PERFORM 2;
                END CASE;
                ALTER TABLE public.t ALTER COLUMN c SET NOT NULL;
              END IF;
            END;
            $$;
            """
        )

        self.assertTrue(self.column("t", "c").nullable)

    def test_tagged_do_block_keeps_alter_inside_false_if(self):
        self.process(
            """
            CREATE TABLE public.t(c TEXT);
            DO $body$
            BEGIN
              IF false THEN
                PERFORM 1;
                ALTER TABLE public.t ALTER COLUMN c SET NOT NULL;
              END IF;
            END;
            $body$;
            """
        )

        self.assertTrue(self.column("t", "c").nullable)

    def test_dollar_tag_text_inside_identifier_is_not_dollar_quote(self):
        self.process(
            """
            CREATE TABLE public.foo$tag$bar (id UUID);
            ALTER TABLE public.foo$tag$bar ADD COLUMN note TEXT;
            """
        )

        self.assertEqual(
            list(generator.tables["foo$tag$bar"].columns),
            ["id", "note"],
        )

    def test_literal_elsif_selects_only_the_matching_branch(self):
        self.process(
            """
            CREATE TABLE public.t(c TEXT);
            DO $$
            BEGIN
              IF false THEN
                PERFORM 1;
              ELSIF true THEN
                ALTER TABLE public.t ALTER COLUMN c SET NOT NULL;
              ELSE
                ALTER TABLE public.t ALTER COLUMN c DROP NOT NULL;
              END IF;
            END;
            $$;
            """
        )

        self.assertFalse(self.column("t", "c").nullable)

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

    def test_later_schema_guard_sees_earlier_do_block_alter(self):
        self.process(
            """
            CREATE TABLE public.t (id UUID);
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1
                  FROM information_schema.columns
                 WHERE table_name = 't'
                   AND column_name = 'c'
              ) THEN
                ALTER TABLE t ADD COLUMN c TEXT;
              END IF;
              IF NOT EXISTS (
                SELECT 1
                  FROM information_schema.columns
                 WHERE table_name = 't'
                   AND column_name = 'c'
              ) THEN
                ALTER TABLE t ALTER COLUMN c SET NOT NULL;
              END IF;
            END;
            $$;
            """
        )

        self.assertTrue(self.column("t", "c").nullable)

    def test_schema_guard_with_else_does_not_claim_clean_then_chain(self):
        self.process(
            """
            CREATE TABLE public.audit_logs(category TEXT);
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1
                  FROM information_schema.columns
                 WHERE table_name = 'audit_logs'
                   AND column_name = 'category'
              ) THEN
                ALTER TABLE audit_logs ADD COLUMN category TEXT;
              ELSE
                ALTER TABLE audit_logs DROP COLUMN category;
              END IF;
            END;
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

    def test_labeled_exception_block_does_not_apply_swallowed_alter(self):
        self.process(
            """
            CREATE TABLE public.t(c TEXT);
            INSERT INTO public.t VALUES(NULL);
            DO $$
            <<guarded>>
            BEGIN
              PERFORM 1;
              ALTER TABLE public.t ALTER COLUMN c SET NOT NULL;
            EXCEPTION WHEN others THEN
              NULL;
            END guarded;
            $$;
            """
        )

        self.assertTrue(self.column("t", "c").nullable)

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

    def test_semicolon_inside_quoted_identifier_does_not_split_create(self):
        self.process(
            """
            CREATE TABLE public.events ("Display;Name" TEXT);
            """
        )

        self.assertIn("Display;Name", generator.tables["events"].columns)

    def test_semicolon_inside_escape_string_does_not_split_statement(self):
        self.process(
            """
            CREATE TABLE public.escape_values (
              value TEXT DEFAULT E'it\\'s;still text'
            );
            ALTER TABLE public.escape_values ADD COLUMN note TEXT;
            """
        )

        self.assertEqual(
            list(generator.tables["escape_values"].columns),
            ["value", "note"],
        )

    def test_dollar_quoted_default_does_not_close_create_body(self):
        self.process(
            """
            CREATE TABLE public.t (
              a TEXT DEFAULT $q$) ignored$q$,
              b TEXT
            );
            """
        )

        self.assertEqual(
            list(generator.tables["t"].columns),
            ["a", "b"],
        )

    def test_comments_are_ignored_only_outside_quoted_content(self):
        self.process(
            """
            -- A statement-looking comment must not split parsing: DROP TABLE public.comments;
            CREATE TABLE public.comments (
              "--literal" TEXT DEFAULT '/* still text */',
              "/*literal*/" TEXT DEFAULT '-- still text'
            );
            /* ALTER TABLE public.comments DROP COLUMN "--literal"; */
            ALTER TABLE public.comments
              ALTER COLUMN "--literal" SET NOT NULL;
            """
        )

        table = generator.tables["comments"]
        self.assertEqual(list(table.columns), ["--literal", "/*literal*/"])
        self.assertFalse(table.columns["--literal"].nullable)

    def test_build_types_derives_valid_name_for_quoted_table(self):
        rendered = self.build(
            'CREATE TABLE "App Schema"."Order Events" ("Display Name" TEXT);'
        )

        self.assertIn("export interface DbOrderEvents {", rendered)
        self.assertNotIn("export interface DbOrder events {", rendered)

    def test_build_types_rejects_colliding_derived_interface_names(self):
        with self.assertRaisesRegex(
            ValueError,
            "interface name collision",
        ):
            self.build(
                """
                CREATE TABLE public.foo_bar (id UUID);
                CREATE TABLE public."foo bar" (id UUID);
                """
            )

    def test_build_types_resets_tables_between_migration_sets(self):
        alpha = self.build(
            "CREATE TABLE public.alpha (id UUID);"
        )
        beta = self.build(
            "CREATE TABLE public.beta (id UUID);"
        )

        self.assertIn("export interface DbAlpha {", alpha)
        self.assertNotIn("export interface DbBeta {", alpha)
        self.assertIn("export interface DbBeta {", beta)
        self.assertNotIn("export interface DbAlpha {", beta)

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
