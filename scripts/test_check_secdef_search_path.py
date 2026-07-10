#!/usr/bin/env python3
"""Unit + regression tests for check-secdef-search-path.py.

Run:  python -m pytest scripts/test_check_secdef_search_path.py
   or python -m unittest scripts.test_check_secdef_search_path  (from repo root)
   or python scripts/test_check_secdef_search_path.py           (direct)

The two headline tests prove the checker's reason to exist:
  * test_would_have_caught_lottery_bug  — the v7 buggy definition IS flagged.
  * test_current_main_is_clean          — the real migrations tree is clean.
"""

import importlib.util
import tempfile
import unittest
from pathlib import Path

# Load the hyphenated script as a module.
_HERE = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location(
    "check_secdef_search_path", _HERE / "check-secdef-search-path.py"
)
checker = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(checker)

REPO_ROOT = _HERE.parent
REAL_MIGRATIONS = REPO_ROOT / "packages" / "supabase" / "migrations"


def _audit_sql(*files, include_tables=False):
    """Write the given (name, sql) pairs into a temp dir and audit it."""
    tmp = tempfile.TemporaryDirectory()
    d = Path(tmp.name)
    for name, sql in files:
        (d / name).write_text(sql, encoding="utf-8")
    violations, n_funcs, n_files = checker.audit(d, include_tables=include_tables)
    return violations, n_funcs, n_files, tmp  # keep tmp alive


# ---------------------------------------------------------------------------
# Reusable SQL fixtures modelled on the real lottery function.
# ---------------------------------------------------------------------------

BUGGY_V7 = """\
-- V7: cryptographic random for lottery tickets (gen_random_bytes)
CREATE OR REPLACE FUNCTION lottery_buy_tickets(
  p_drawing_id UUID, p_guild_id TEXT, p_user_id TEXT,
  p_count INT, p_max INT, p_cost BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.economy_lottery_tickets (drawing_id, ticket_number)
    SELECT p_drawing_id,
           (get_byte(gen_random_bytes(2), 0) * 256 + get_byte(gen_random_bytes(2), 1)) % 10000
      FROM generate_series(1, p_count);
  RETURN 0;
END;
$$;
"""

FIXED_LATER = """\
-- Fix: schema-qualify gen_random_bytes so it resolves under search_path=''
CREATE OR REPLACE FUNCTION lottery_buy_tickets(
  p_drawing_id UUID, p_guild_id TEXT, p_user_id TEXT,
  p_count INT, p_max INT, p_cost BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.economy_lottery_tickets (drawing_id, ticket_number)
    SELECT p_drawing_id,
           (get_byte(extensions.gen_random_bytes(2), 0) * 256
            + get_byte(extensions.gen_random_bytes(2), 1)) % 10000
      FROM generate_series(1, p_count);
  RETURN 0;
END;
$$;
"""


class TestEndToEnd(unittest.TestCase):
    def test_would_have_caught_lottery_bug(self):
        """The v7 definition alone must be flagged (proves detection)."""
        violations, _, _, tmp = _audit_sql(
            ("20260613100000_v7_lottery_crypto_random.sql", BUGGY_V7)
        )
        with tmp:
            kinds = {(v.symbol, v.kind) for v in violations}
            self.assertIn(("gen_random_bytes", "extension-function"), kinds)
            # Two calls -> two hits.
            genrb = [v for v in violations if v.symbol == "gen_random_bytes"]
            self.assertEqual(len(genrb), 2)

    def test_fix_alone_is_clean(self):
        """The schema-qualified fix must NOT be flagged."""
        violations, _, _, tmp = _audit_sql(
            ("20260709160000_fix.sql", FIXED_LATER)
        )
        with tmp:
            self.assertEqual(
                violations,
                [],
                msg=[v.format() for v in violations],
            )

    def test_later_fix_overrides_earlier_bug(self):
        """Effective-schema semantics: latest CREATE OR REPLACE wins.

        With BOTH the buggy v7 and the later fix present, the effective
        definition is the fix, so the tree is clean — exactly why the real
        main (which still ships the historical v7 file) reports clean.
        """
        violations, n_funcs, _, tmp = _audit_sql(
            ("20260613100000_v7_lottery_crypto_random.sql", BUGGY_V7),
            ("20260709160000_fix.sql", FIXED_LATER),
        )
        with tmp:
            self.assertEqual(n_funcs, 1, "same signature -> one effective def")
            self.assertEqual(
                violations, [], msg=[v.format() for v in violations]
            )

    def test_reverting_fix_reflags_bug(self):
        """If the fix is removed, the bug comes back (guards against regress)."""
        # Only the buggy file present == fix reverted.
        violations, _, _, tmp = _audit_sql(
            ("20260613100000_v7_lottery_crypto_random.sql", BUGGY_V7)
        )
        with tmp:
            self.assertTrue(
                any(v.symbol == "gen_random_bytes" for v in violations)
            )

    def test_current_main_is_clean(self):
        """The real migrations tree must pass the GATING check (main is clean).

        The gating check is the extension-function bug class — the exact cause
        of the lottery outage. Table detection is advisory (opt-in) and NOT run
        here, matching how the CI gate is intended to behave.
        """
        self.assertTrue(
            REAL_MIGRATIONS.is_dir(),
            f"migrations dir missing: {REAL_MIGRATIONS}",
        )
        violations, n_funcs, n_files = checker.audit(REAL_MIGRATIONS)
        self.assertGreater(n_files, 0)
        self.assertGreater(n_funcs, 0)
        gating = [v for v in violations if v.gating]
        self.assertEqual(
            gating,
            [],
            msg="main should be clean on the gating check; found:\n"
            + "\n".join(v.format() for v in gating),
        )

    def test_main_has_no_unqualified_extension_calls_even_with_tables(self):
        """Belt-and-suspenders: even scanning tables, zero extension-fn hits."""
        violations, _, _ = checker.audit(REAL_MIGRATIONS, include_tables=True)
        ext = [v for v in violations if v.kind == "extension-function"]
        self.assertEqual(
            ext, [], msg="\n".join(v.format() for v in ext)
        )


class TestExtensionFunctionDetection(unittest.TestCase):
    def _one(self, body_sql, search_path="''", secdef=True):
        sd = "SECURITY DEFINER" if secdef else ""
        sql = f"""\
CREATE OR REPLACE FUNCTION f(p INT)
RETURNS void LANGUAGE plpgsql
{sd}
SET search_path = {search_path}
AS $$
BEGIN
{body_sql}
END;
$$;
"""
        violations, _, _, tmp = _audit_sql(("20260101000000_f.sql", sql))
        with tmp:
            return list(violations)

    def test_flags_unqualified_gen_random_bytes(self):
        v = self._one("  PERFORM gen_random_bytes(16);")
        self.assertEqual(len(v), 1)
        self.assertEqual(v[0].symbol, "gen_random_bytes")
        self.assertEqual(v[0].kind, "extension-function")

    def test_ignores_qualified_gen_random_bytes(self):
        v = self._one("  PERFORM extensions.gen_random_bytes(16);")
        self.assertEqual(v, [])

    def test_gen_random_uuid_is_pg_catalog_not_flagged(self):
        # gen_random_uuid lives in pg_catalog -> fine under empty search_path.
        v = self._one("  PERFORM gen_random_uuid();")
        self.assertEqual(v, [])

    def test_flags_unqualified_digest_and_crypt(self):
        v = self._one("  PERFORM digest('x', 'sha256'); PERFORM crypt('a','b');")
        syms = sorted(x.symbol for x in v if x.kind == "extension-function")
        self.assertEqual(syms, ["crypt", "digest"])

    def test_flags_unqualified_uuid_generate_v4(self):
        v = self._one("  PERFORM uuid_generate_v4();")
        self.assertEqual(len(v), 1)
        self.assertEqual(v[0].symbol, "uuid_generate_v4")

    def test_substring_false_positive_guard(self):
        # `my_gen_random_bytes` and `x.gen_random_bytes` must NOT match.
        v = self._one(
            "  PERFORM my_gen_random_bytes(1); PERFORM x.gen_random_bytes(2);"
        )
        self.assertEqual(v, [])

    def test_not_flagged_when_search_path_not_empty(self):
        # Out of scope: search_path = public is a different (also risky) case
        # this linter deliberately does not own.
        v = self._one("  PERFORM gen_random_bytes(16);", search_path="public")
        self.assertEqual(v, [])

    def test_not_flagged_when_not_security_definer(self):
        v = self._one("  PERFORM gen_random_bytes(16);", secdef=False)
        self.assertEqual(v, [])


class TestUnqualifiedTableDetection(unittest.TestCase):
    """Advisory table detection (opt-in, best-effort, CTE-aware)."""

    def _one(self, body_sql):
        sql = f"""\
CREATE OR REPLACE FUNCTION g()
RETURNS void LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
{body_sql}
END;
$$;
"""
        violations, _, _, tmp = _audit_sql(
            ("20260101000000_g.sql", sql), include_tables=True
        )
        with tmp:
            return [x for x in violations if x.kind == "unqualified-table"]

    def test_table_check_is_off_by_default(self):
        sql = """\
CREATE OR REPLACE FUNCTION g()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN DELETE FROM widgets WHERE id = 1; END; $$;
"""
        violations, _, _, tmp = _audit_sql(("20260101000000_g.sql", sql))
        with tmp:
            self.assertEqual(
                [x for x in violations if x.kind == "unqualified-table"], []
            )

    def test_flags_unqualified_delete_target(self):
        v = self._one("  DELETE FROM widgets WHERE id = 1;")
        self.assertEqual([x.symbol for x in v], ["widgets"])

    def test_ignores_qualified_delete_target(self):
        v = self._one("  DELETE FROM public.widgets WHERE id = 1;")
        self.assertEqual(v, [])

    def test_flags_unqualified_from_and_join(self):
        v = self._one(
            "  PERFORM 1 FROM orders o JOIN lines l ON l.oid = o.id;"
        )
        self.assertEqual(sorted(x.symbol for x in v), ["lines", "orders"])

    def test_ignores_qualified_from_and_join(self):
        v = self._one(
            "  PERFORM 1 FROM public.orders o JOIN public.lines l "
            "ON l.oid = o.id;"
        )
        self.assertEqual(v, [])

    def test_generate_series_from_is_not_a_table(self):
        v = self._one("  PERFORM 1 FROM generate_series(1, 5);")
        self.assertEqual(v, [])

    def test_update_alias_set_is_not_flagged_as_table(self):
        # `UPDATE public.a x SET ...` must not flag `SET` or the alias.
        v = self._one("  UPDATE public.a x SET col = 1 WHERE x.id = 2;")
        self.assertEqual(v, [])

    def test_update_target_unqualified_is_flagged(self):
        v = self._one("  UPDATE b SET y = 2 WHERE id = 1;")
        self.assertEqual([x.symbol for x in v], ["b"])

    def test_cte_name_is_not_flagged(self):
        # A CTE referenced in FROM must NOT be treated as a base table, while a
        # real unqualified base table in the same query still is.
        v = self._one(
            "  WITH claimed AS (\n"
            "    UPDATE public.progress SET done = true RETURNING id\n"
            "  )\n"
            "  INSERT INTO public.log (id) SELECT c.id FROM claimed c\n"
            "    JOIN raw_events e ON e.id = c.id;"
        )
        self.assertEqual([x.symbol for x in v], ["raw_events"])


class TestSignatureParsing(unittest.TestCase):
    def test_overloads_are_distinct_effective_defs(self):
        sql_a = """\
CREATE OR REPLACE FUNCTION f(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""
        sql_b = """\
CREATE OR REPLACE FUNCTION f(a TEXT, b INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM 1; END; $$;
"""
        violations, n_funcs, _, tmp = _audit_sql(
            ("20260101000000_a.sql", sql_a),
            ("20260102000000_b.sql", sql_b),
        )
        with tmp:
            # Two different signatures -> two effective defs; only f(int) flags.
            self.assertEqual(n_funcs, 2)
            self.assertEqual(len(violations), 1)
            self.assertEqual(violations[0].function.signature, ("int",))

    def test_same_signature_latest_wins(self):
        sql_old = """\
CREATE OR REPLACE FUNCTION f(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""
        sql_new = """\
CREATE OR REPLACE FUNCTION f(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM extensions.gen_random_bytes(1); END; $$;
"""
        violations, n_funcs, _, tmp = _audit_sql(
            ("20260101000000_old.sql", sql_old),
            ("20260102000000_new.sql", sql_new),
        )
        with tmp:
            self.assertEqual(n_funcs, 1)
            self.assertEqual(violations, [])


class TestCommentHandling(unittest.TestCase):
    def test_prose_mentioning_gen_random_bytes_not_flagged(self):
        sql = """\
-- This migration schema-qualifies gen_random_bytes() as a fix.
CREATE OR REPLACE FUNCTION h()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- gen_random_bytes without extensions. prefix would fail here
  PERFORM extensions.gen_random_bytes(4);
END;
$$;
"""
        violations, _, _, tmp = _audit_sql(("20260101000000_h.sql", sql))
        with tmp:
            self.assertEqual(
                violations, [], msg=[v.format() for v in violations]
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
