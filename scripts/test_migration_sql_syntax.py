#!/usr/bin/env python3
"""Static guards for migration statement-boundary mistakes.

PostgreSQL reports a surprisingly opaque syntax error when a PL/pgSQL
``INSERT ... ON CONFLICT`` is followed by ``RETURN`` without terminating the
INSERT.  Keep this check intentionally small and conservative: it only flags
an ``ON CONFLICT`` clause whose first following ``RETURN`` is not preceded by
the statement terminator, while allowing ``RETURNING`` clauses.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = REPO_ROOT / "packages" / "supabase" / "migrations"
LICENSE_OWNER_MIGRATION = MIGRATIONS / "20260804138000_license_owner_controls.sql"
LEVEL_REWARD_MIGRATION = MIGRATIONS / "20260819201000_level_reward_orchestration.sql"
LEVEL_REWARD_CLEANUP_MIGRATION = MIGRATIONS / "20260819212000_level_reward_delivery_cleanup_fks.sql"

_UPSERT_RETURN = re.compile(
    r"(?ims)^\s*ON\s+CONFLICT\b(?P<body>.{0,2000}?)\bRETURN\b(?!ING)"
)

# A PL/pgSQL ``%ROWTYPE`` target is one composite value.  PostgreSQL does not
# permit mixing that target with scalar targets in one SELECT INTO list (for
# example ``SELECT o, f.request_id INTO v_order, v_request_id``); it reports a
# syntax error while compiling the function.  Keep this guard deliberately
# narrow: it only matches an unexpanded relation alias as the first SELECT
# expression and a rowtype variable as the first INTO target.
_ROWTYPE_DECL = re.compile(
    r"(?im)(?:\bDECLARE\s+|[;\n]\s*)(?P<name>(?!DECLARE\b|BEGIN\b)[a-z_]\w*)\s+"
    r"[^;\n]*?%ROWTYPE\b"
)
_ROWTYPE_MIXED_SELECT_INTO = re.compile(
    r"(?is)\bSELECT\s+(?P<expr>[a-z_]\w*)\s*,\s*[^;]*?\bINTO\s+"
    r"(?P<target>[a-z_]\w*)\s*,"
)


def find_unterminated_upserts(sql: str) -> bool:
    """Return whether an ON CONFLICT statement reaches RETURN without ``;``."""

    for match in _UPSERT_RETURN.finditer(sql):
        body = match.group("body").rstrip()
        if ";" not in body:
            return True
    return False


def find_mixed_rowtype_select_into(sql: str) -> list[tuple[str, str]]:
    """Return composite/scalar SELECT INTO targets that PostgreSQL rejects."""

    rowtype_names = {
        match.group("name").lower() for match in _ROWTYPE_DECL.finditer(sql)
    }
    return [
        (match.group("expr"), match.group("target"))
        for match in _ROWTYPE_MIXED_SELECT_INTO.finditer(sql)
        if match.group("target").lower() in rowtype_names
        # ``o.*`` is the valid expanded composite form and is not matched by
        # the first-expression pattern above, but retain this condition as a
        # guard if the regex is widened in the future.
        and match.group("expr") != "row"
    ]


class MigrationSqlSyntaxTests(unittest.TestCase):
    def test_fixture_detects_missing_upsert_terminator(self) -> None:
        malformed = """
        CREATE FUNCTION f() RETURNS jsonb LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO t(id) VALUES (1)
            ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
          RETURN jsonb_build_object('ok', true);
        END;
        $$;
        """
        self.assertTrue(find_unterminated_upserts(malformed))

    def test_migrations_have_terminated_upserts_before_return(self) -> None:
        offenders = [
            path.name
            for path in sorted(MIGRATIONS.glob("*.sql"))
            if find_unterminated_upserts(path.read_text(encoding="utf-8"))
        ]
        self.assertEqual(offenders, [])

    def test_fixture_detects_mixed_rowtype_select_into(self) -> None:
        malformed = """
        CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
        DECLARE
          v_order public.orders%ROWTYPE;
          v_request_id uuid;
        BEGIN
          SELECT o, f.request_id INTO v_order, v_request_id
            FROM public.orders o JOIN public.commerce_free_claims f ON f.order_id = o.id;
        END;
        $$;
        """
        self.assertEqual(find_mixed_rowtype_select_into(malformed), [("o", "v_order")])

    def test_migrations_do_not_mix_rowtype_and_scalar_select_targets(self) -> None:
        offenders = {
            path.name: find_mixed_rowtype_select_into(path.read_text(encoding="utf-8"))
            for path in sorted(MIGRATIONS.glob("*.sql"))
        }
        self.assertEqual({name: matches for name, matches in offenders.items() if matches}, {})

    def test_license_prefix_upgrade_repairs_legacy_rows_before_check(self) -> None:
        """Legacy invalid prefixes must be normalized before CHECK validation.

        This is the migration-order proof for an upgrade database containing a
        pre-existing invalid key_prefix.  The UPDATE's predicate is exhaustive
        for the final CHECK grammar, so every row reaches constraint validation
        in a valid state while fresh installs still use the SMNI default.
        """

        migration = LICENSE_OWNER_MIGRATION.read_text(encoding="utf-8")
        sanitize = migration.index(
            "UPDATE public.product_license_config\n"
            "SET key_prefix = 'SMNI'\n"
            "WHERE key_prefix IS NULL OR key_prefix !~ '^[A-Z]{2,8}$';"
        )
        constraint = migration.index(
            "ALTER TABLE public.product_license_config\n"
            "  DROP CONSTRAINT IF EXISTS product_license_config_key_prefix_check,\n"
            "  ADD CONSTRAINT product_license_config_key_prefix_check"
        )
        self.assertLess(sanitize, constraint)
        self.assertIn("CHECK (key_prefix ~ '^[A-Z]{2,8}$')", migration[constraint:])

        grammar = re.compile(r"^[A-Z]{2,8}$")
        for valid in ("AB", "SMNI", "ABCDEFGH"):
            self.assertRegex(valid, grammar)
        for invalid in ("aB", "A", "ABCDEFGHI", "AB-1", ""):
            self.assertNotRegex(invalid, grammar)

    def test_level_reward_cleanup_fk_change_is_forward_only(self) -> None:
        original = LEVEL_REWARD_MIGRATION.read_text(encoding="utf-8")
        upgrade = LEVEL_REWARD_CLEANUP_MIGRATION.read_text(encoding="utf-8")

        self.assertIn(
            "reward_id UUID NOT NULL REFERENCES public.level_rewards(id) ON DELETE RESTRICT",
            original,
        )
        self.assertIn(
            "action_id UUID REFERENCES public.bot_action_queue(id) ON DELETE RESTRICT",
            original,
        )
        self.assertIn(
            "DROP CONSTRAINT IF EXISTS level_reward_deliveries_reward_id_fkey",
            upgrade,
        )
        self.assertIn(
            "DROP CONSTRAINT IF EXISTS level_reward_deliveries_action_id_fkey",
            upgrade,
        )
        self.assertIn("ON DELETE CASCADE", upgrade)
        self.assertIn("ON DELETE SET NULL", upgrade)


if __name__ == "__main__":
    unittest.main()
