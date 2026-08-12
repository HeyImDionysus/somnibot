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

    def test_plpgsql_keywords_and_distinct_from_operands_are_not_tables(self):
        # The advisory scanner must not mistake PL/pgSQL control-flow / row-lock
        # keywords, or the value operand of IS DISTINCT FROM, for relation names.
        v = self._one(
            "  IF p_value IS NOT DISTINCT FROM v_expected THEN\n"
            "    NULL;\n"
            "  END IF;\n"
            "  SELECT id INTO p_value FROM public.widgets FOR UPDATE NOWAIT;\n"
            "  FOR p_row IN SELECT id FROM public.widgets FOR UPDATE LOOP\n"
            "    NULL;\n"
            "  END LOOP;"
        )
        self.assertEqual(v, [])

    def test_materialized_cte_names_are_not_flagged(self):
        v = self._one(
            "  WITH first_cte AS MATERIALIZED ("
            "SELECT id FROM public.widgets), "
            "second_cte AS NOT MATERIALIZED (SELECT id FROM first_cte) "
            "SELECT id FROM second_cte;"
        )
        self.assertEqual(v, [])


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
            # The signature is canonicalized: INT -> integer (see finding #5).
            self.assertEqual(n_funcs, 2)
            self.assertEqual(len(violations), 1)
            self.assertEqual(violations[0].function.signature, ("integer",))

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


class TestDollarQuoteAndSearchPathForms(unittest.TestCase):
    """Regression guards: valid PG syntax variants must not silently slip past.

    A security gate whose whole purpose is catching what the compiler misses is
    only as good as its coverage of the syntax the compiler accepts. These forms
    are all valid Postgres, so a real lottery-class bug written this way must be
    flagged, not silently missed.
    """

    def _v(self, sql):
        violations, _, _, tmp = _audit_sql(("20260101000000_x.sql", sql))
        with tmp:
            return [x.symbol for x in violations if x.kind == "extension-function"]

    def test_tagged_dollar_quote_body_is_scanned(self):
        # $function$-delimited body (Supabase editor / pg_dump emit these).
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void LANGUAGE plpgsql\n"
            "SECURITY DEFINER SET search_path = ''\n"
            "AS $function$ BEGIN PERFORM gen_random_bytes(16); END; $function$;"
        )
        self.assertEqual(self._v(sql), ["gen_random_bytes"])

    def test_nested_differently_tagged_block_does_not_truncate_body(self):
        # An inner $q$...$q$ dynamic-SQL block must NOT terminate the outer $$
        # body early; the ext-fn call AFTER it must still be scanned.
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void LANGUAGE plpgsql\n"
            "SECURITY DEFINER SET search_path = ''\n"
            "AS $$\nBEGIN\n"
            "  EXECUTE $q$ SELECT 1 $q$;\n"
            "  PERFORM gen_random_bytes(16);\n"
            "END;\n$$;"
        )
        self.assertEqual(self._v(sql), ["gen_random_bytes"])

    def test_search_path_set_with_TO_is_recognized(self):
        # `SET search_path TO ''` is equivalent to `= ''` in Postgres.
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void LANGUAGE plpgsql\n"
            "SECURITY DEFINER SET search_path TO ''\n"
            "AS $$ BEGIN PERFORM gen_random_bytes(16); END; $$;"
        )
        self.assertEqual(self._v(sql), ["gen_random_bytes"])

    def test_quoted_search_path_identifier_is_recognized(self):
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void LANGUAGE plpgsql\n"
            'SECURITY DEFINER SET "search_path" = \'\'\n'
            "AS $$ BEGIN PERFORM gen_random_bytes(16); END; $$;"
        )
        self.assertEqual(self._v(sql), ["gen_random_bytes"])

    def test_nonempty_search_path_still_not_flagged_with_TO(self):
        # `TO public` is non-empty -> out of scope, must stay unflagged.
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void LANGUAGE plpgsql\n"
            "SECURITY DEFINER SET search_path TO public\n"
            "AS $$ BEGIN PERFORM gen_random_bytes(16); END; $$;"
        )
        self.assertEqual(self._v(sql), [])


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


# ---------------------------------------------------------------------------
# Codex finding #1 — skip string literals and /* */ block comments.
# This is the class that produced the real-tree false positives:
#   `the` from 'Buy something from the shop'
#   `own` from 'cannot buy from own listing'
# ---------------------------------------------------------------------------
class TestStringLiteralAndBlockCommentSkipping(unittest.TestCase):
    def _tables(self, body_sql):
        sql = f"""\
CREATE OR REPLACE FUNCTION s()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
{body_sql}
END;
$$;
"""
        violations, _, _, tmp = _audit_sql(
            ("20260101000000_s.sql", sql), include_tables=True
        )
        with tmp:
            return [x.symbol for x in violations if x.kind == "unqualified-table"]

    def _ext(self, body_sql):
        sql = f"""\
CREATE OR REPLACE FUNCTION s()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
{body_sql}
END;
$$;
"""
        violations, _, _, tmp = _audit_sql(("20260101000000_s.sql", sql))
        with tmp:
            return [x.symbol for x in violations if x.kind == "extension-function"]

    def test_from_inside_string_literal_not_flagged_as_table(self):
        # Exact real-tree false positive #1: 'Buy something from the shop'.
        v = self._tables(
            "  INSERT INTO public.quests (title) "
            "VALUES ('Buy something from the shop');"
        )
        self.assertEqual(v, [], msg=f"'the' from a string literal leaked: {v}")

    def test_from_own_inside_raise_exception_not_flagged(self):
        # Exact real-tree false positive #2: RAISE EXCEPTION 'cannot buy from
        # own listing' — `from own` is inside a diagnostic string.
        v = self._tables("  RAISE EXCEPTION 'cannot buy from own listing';")
        self.assertEqual(v, [], msg=f"'own' from a string literal leaked: {v}")

    def test_extension_fn_inside_string_literal_not_flagged(self):
        # RAISE NOTICE 'gen_random_bytes(16)' is data, not an executable call.
        v = self._ext("  RAISE NOTICE 'gen_random_bytes(16)';")
        self.assertEqual(v, [])

    def test_extension_fn_inside_block_comment_not_flagged(self):
        v = self._ext(
            "  /* gen_random_bytes(16) would fail here */\n"
            "  PERFORM extensions.gen_random_bytes(16);"
        )
        self.assertEqual(v, [])

    def test_table_inside_block_comment_not_flagged(self):
        v = self._tables("  /* DELETE FROM widgets */ PERFORM 1;")
        self.assertEqual(v, [])

    def test_doubled_quote_escape_does_not_unblank_following_code(self):
        # 'it''s' is one literal; a real ext call AFTER it must still be caught.
        v = self._ext(
            "  RAISE NOTICE 'it''s fine';\n"
            "  PERFORM gen_random_bytes(8);"
        )
        self.assertEqual(v, ["gen_random_bytes"])

    def test_real_call_after_string_literal_still_flagged(self):
        # A genuine unqualified call must survive string blanking of a sibling.
        v = self._ext(
            "  RAISE NOTICE 'buying from the shop';\n"
            "  PERFORM digest('x', 'sha256');"
        )
        self.assertEqual(v, ["digest"])


# ---------------------------------------------------------------------------
# Codex finding #2 — single-quoted function bodies (AS '...').
# ---------------------------------------------------------------------------
class TestSingleQuotedBody(unittest.TestCase):
    def _v(self, sql):
        violations, _, _, tmp = _audit_sql(("20260101000000_q.sql", sql))
        with tmp:
            return [x.symbol for x in violations if x.kind == "extension-function"]

    def test_single_quoted_body_is_scanned(self):
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void LANGUAGE plpgsql\n"
            "SECURITY DEFINER SET search_path = ''\n"
            "AS 'BEGIN PERFORM gen_random_bytes(16); END;';"
        )
        self.assertEqual(self._v(sql), ["gen_random_bytes"])

    def test_single_quoted_body_qualified_is_clean(self):
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void LANGUAGE plpgsql\n"
            "SECURITY DEFINER SET search_path = ''\n"
            "AS 'BEGIN PERFORM extensions.gen_random_bytes(16); END;';"
        )
        self.assertEqual(self._v(sql), [])

    def test_single_quoted_body_with_escaped_quote(self):
        # A '' escape inside the body must not terminate it early.
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void LANGUAGE plpgsql\n"
            "SECURITY DEFINER SET search_path = ''\n"
            "AS 'BEGIN RAISE NOTICE ''hi''; PERFORM gen_random_bytes(1); END;';"
        )
        self.assertEqual(self._v(sql), ["gen_random_bytes"])


# ---------------------------------------------------------------------------
# Codex finding #3 — options that appear AFTER the body.
# ---------------------------------------------------------------------------
class TestTrailingOptions(unittest.TestCase):
    def _v(self, sql):
        violations, _, _, tmp = _audit_sql(("20260101000000_t.sql", sql))
        with tmp:
            return [x.symbol for x in violations if x.kind == "extension-function"]

    def test_trailing_secdef_and_search_path_are_scanned(self):
        # `AS $$ ... $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''`
        # — the repo's automation_helpers.sql uses exactly this order.
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void\n"
            "AS $$ BEGIN PERFORM gen_random_bytes(16); END; $$\n"
            "LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';"
        )
        self.assertEqual(self._v(sql), ["gen_random_bytes"])

    def test_trailing_options_qualified_call_is_clean(self):
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void\n"
            "AS $$ BEGIN PERFORM extensions.gen_random_bytes(16); END; $$\n"
            "LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';"
        )
        self.assertEqual(self._v(sql), [])

    def test_trailing_options_not_empty_search_path_out_of_scope(self):
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void\n"
            "AS $$ BEGIN PERFORM gen_random_bytes(16); END; $$\n"
            "LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;"
        )
        self.assertEqual(self._v(sql), [])


# ---------------------------------------------------------------------------
# Codex finding #4 — schema is part of the effective key.
# ---------------------------------------------------------------------------
class TestSchemaQualifiedKey(unittest.TestCase):
    def test_same_name_different_schema_are_distinct(self):
        # public.f is buggy; private.f (same args) is clean. Keying on name
        # alone would collapse them and could hide the buggy one.
        sql_pub = """\
CREATE OR REPLACE FUNCTION public.f(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""
        sql_priv = """\
CREATE OR REPLACE FUNCTION private.f(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM extensions.gen_random_bytes(1); END; $$;
"""
        violations, n_funcs, _, tmp = _audit_sql(
            ("20260101000000_pub.sql", sql_pub),
            ("20260102000000_priv.sql", sql_priv),
        )
        with tmp:
            self.assertEqual(n_funcs, 2, "distinct schemas -> two effective defs")
            ext = [v for v in violations if v.kind == "extension-function"]
            self.assertEqual([v.symbol for v in ext], ["gen_random_bytes"])
            self.assertEqual(ext[0].function.schema, "public")

    def test_unqualified_create_resolves_to_public(self):
        # `CREATE FUNCTION f` (no schema) keys under public, so a later
        # `public.f` definition overrides it (same effective identity).
        sql_old = """\
CREATE OR REPLACE FUNCTION f(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""
        sql_new = """\
CREATE OR REPLACE FUNCTION public.f(a INT)
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


# ---------------------------------------------------------------------------
# Codex finding #5 — DROP FUNCTION removes from effective state.
# ---------------------------------------------------------------------------
class TestDropFunction(unittest.TestCase):
    def test_drop_removes_buggy_function_from_gate(self):
        # A buggy SECDEF function created then dropped later must NOT flag.
        buggy = """\
CREATE OR REPLACE FUNCTION dead_fn(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""
        drop = "DROP FUNCTION IF EXISTS dead_fn(INT);\n"
        violations, n_funcs, _, tmp = _audit_sql(
            ("20260101000000_create.sql", buggy),
            ("20260102000000_drop.sql", drop),
        )
        with tmp:
            self.assertEqual(n_funcs, 0, "dropped fn should not remain effective")
            self.assertEqual(violations, [])

    def test_drop_without_args_removes_overload(self):
        buggy = """\
CREATE OR REPLACE FUNCTION dead_fn()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""
        drop = "DROP FUNCTION IF EXISTS dead_fn;\n"
        violations, n_funcs, _, tmp = _audit_sql(
            ("20260101000000_create.sql", buggy),
            ("20260102000000_drop.sql", drop),
        )
        with tmp:
            self.assertEqual(n_funcs, 0)
            self.assertEqual(violations, [])

    def test_schema_qualified_drop_matches_unqualified_create(self):
        # `CREATE FUNCTION f` (public) dropped by `DROP FUNCTION public.f(...)`.
        buggy = """\
CREATE OR REPLACE FUNCTION purge(a TEXT, b TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""
        drop = "DROP FUNCTION IF EXISTS public.purge(text, text);\n"
        violations, n_funcs, _, tmp = _audit_sql(
            ("20260101000000_create.sql", buggy),
            ("20260102000000_drop.sql", drop),
        )
        with tmp:
            self.assertEqual(n_funcs, 0)
            self.assertEqual(violations, [])

    def test_drop_then_recreate_keeps_final_definition(self):
        buggy = """\
CREATE OR REPLACE FUNCTION f(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""
        drop_recreate = """\
DROP FUNCTION IF EXISTS f(INT);
CREATE OR REPLACE FUNCTION f(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM extensions.gen_random_bytes(1); END; $$;
"""
        violations, n_funcs, _, tmp = _audit_sql(
            ("20260101000000_a.sql", buggy),
            ("20260102000000_b.sql", drop_recreate),
        )
        with tmp:
            self.assertEqual(n_funcs, 1, "recreated fn is effective")
            self.assertEqual(violations, [])


# ---------------------------------------------------------------------------
# Codex finding #6 — ALTER FUNCTION option changes update effective state.
# ---------------------------------------------------------------------------
class TestAlterFunction(unittest.TestCase):
    def test_alter_adds_empty_search_path_and_body_gets_scanned(self):
        # A SECDEF function without search_path (out of scope) hardened by a
        # later `ALTER FUNCTION ... SET search_path = ''` must then be scanned,
        # and an unqualified ext call inside it flagged.
        created = """\
CREATE OR REPLACE FUNCTION f(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""
        alter = "ALTER FUNCTION f(INT) SET search_path = '';\n"
        violations, _, _, tmp = _audit_sql(
            ("20260101000000_c.sql", created),
            ("20260102000000_alter.sql", alter),
        )
        with tmp:
            ext = [v.symbol for v in violations if v.kind == "extension-function"]
            self.assertEqual(ext, ["gen_random_bytes"])

    def test_alter_adds_security_definer(self):
        # A search_path='' function not yet SECDEF, then ALTER ... SECURITY
        # DEFINER makes it in-scope.
        created = """\
CREATE OR REPLACE FUNCTION f(a INT)
RETURNS void LANGUAGE plpgsql SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""
        alter = "ALTER FUNCTION f(INT) SECURITY DEFINER;\n"
        violations, _, _, tmp = _audit_sql(
            ("20260101000000_c.sql", created),
            ("20260102000000_alter.sql", alter),
        )
        with tmp:
            ext = [v.symbol for v in violations if v.kind == "extension-function"]
            self.assertEqual(ext, ["gen_random_bytes"])

    def test_alter_without_args_matches_by_name(self):
        created = """\
CREATE OR REPLACE FUNCTION public.f(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""
        alter = "ALTER FUNCTION public.f(INT) SET search_path = '';\n"
        violations, _, _, tmp = _audit_sql(
            ("20260101000000_c.sql", created),
            ("20260102000000_alter.sql", alter),
        )
        with tmp:
            ext = [v.symbol for v in violations if v.kind == "extension-function"]
            self.assertEqual(ext, ["gen_random_bytes"])


# ---------------------------------------------------------------------------
# Codex finding #7 — the added extension functions are audited.
# ---------------------------------------------------------------------------
class TestAddedExtensionFunctions(unittest.TestCase):
    def _one(self, call):
        sql = f"""\
CREATE OR REPLACE FUNCTION f()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM {call}; END; $$;
"""
        violations, _, _, tmp = _audit_sql(("20260101000000_e.sql", sql))
        with tmp:
            return [x.symbol for x in violations if x.kind == "extension-function"]

    def test_newly_added_functions_are_flagged(self):
        for fn in (
            "armor('x')",
            "dearmor('x')",
            "pgp_key_id('x')",
            "pgp_sym_encrypt_bytea('x', 'k')",
            "pgp_pub_decrypt_bytea('x', 'k')",
            "uuid_ns_url()",
            "uuid_ns_dns()",
            "uuid_ns_oid()",
            "uuid_ns_x500()",
        ):
            name = fn.split("(")[0]
            with self.subTest(fn=name):
                self.assertEqual(self._one(fn), [name])

    def test_added_functions_qualified_are_clean(self):
        self.assertEqual(self._one("extensions.armor('x')"), [])
        self.assertEqual(self._one("extensions.uuid_ns_url()"), [])


# ---------------------------------------------------------------------------
# Real-tree regressions: the exact false positives must be gone, and the two
# historical bugs must still be catchable.
# ---------------------------------------------------------------------------
class TestRealTreeRegressions(unittest.TestCase):
    def test_no_the_or_own_false_positives_on_real_tree(self):
        violations, _, _ = checker.audit(REAL_MIGRATIONS, include_tables=True)
        symbols = {v.symbol.lower() for v in violations}
        self.assertNotIn("the", symbols, "'the' string-literal false positive returned")
        self.assertNotIn("own", symbols, "'own' string-literal false positive returned")

    def test_real_tree_fully_clean_including_tables(self):
        # After finding #1 the advisory table scan is also clean on real main.
        violations, _, _ = checker.audit(REAL_MIGRATIONS, include_tables=True)
        self.assertEqual(
            violations, [], msg="\n".join(v.format() for v in violations)
        )

    def test_purge_user_data_dropped_not_effective(self):
        # It is created in v53_dead_table_cleanup and dropped in
        # v53_production_readiness; DROP handling means it is not audited.
        eff = checker.collect_effective_functions(
            sorted(str(p) for p in REAL_MIGRATIONS.glob("*.sql"))
        )
        self.assertFalse(
            any(k[1] == "purge_user_data" for k in eff),
            "purge_user_data should be removed by its later DROP",
        )

    def test_would_still_catch_lottery_gen_random_bytes_bug(self):
        # The original outage: unqualified gen_random_bytes in a SECDEF+''
        # function. Prove detection survives the parser rewrite.
        violations, _, _, tmp = _audit_sql(
            ("20260613100000_v7.sql", BUGGY_V7)
        )
        with tmp:
            genrb = [v for v in violations if v.symbol == "gen_random_bytes"]
            self.assertEqual(len(genrb), 2)

    def test_would_have_caught_purge_user_data_bug_before_drop(self):
        # Before it was dropped, purge_user_data had unqualified table refs
        # under search_path=''. With tables enabled and only the CREATE present,
        # the linter flags them (advisory) — proving it would have caught it.
        purge_create = """\
CREATE OR REPLACE FUNCTION purge_user_data(p_guild_id TEXT, p_user TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  DELETE FROM economy_wallets WHERE guild_id = p_guild_id;
  DELETE FROM economy_transactions WHERE guild_id = p_guild_id;
END;
$$;
"""
        violations, _, _, tmp = _audit_sql(
            ("20260601000004_purge.sql", purge_create), include_tables=True
        )
        with tmp:
            tables = sorted(
                x.symbol for x in violations if x.kind == "unqualified-table"
            )
            self.assertEqual(
                tables, ["economy_transactions", "economy_wallets"]
            )


# ===========================================================================
# Second codex round — parser-correctness robustness (findings 1-5).
# ===========================================================================


def _ext_body(body_sql, search_path="''", secdef=True):
    """Audit a single SECDEF+empty function with the given body; return the
    ext-function symbols flagged."""
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
        return [x.symbol for x in violations if x.kind == "extension-function"]


# ---------------------------------------------------------------------------
# Finding #1 (:232) — the -- line-comment stripper must respect string literals.
# A `--` inside a single-quoted literal is DATA, not a comment start; treating
# it as one truncates the literal and can blank the closing quote / dollar
# delimiter, skipping a function or blanking a live ext call after it.
# ---------------------------------------------------------------------------
class TestLineCommentRespectsStringLiterals(unittest.TestCase):
    def test_dashes_in_string_do_not_truncate_following_call(self):
        # 'a -- b' is a string; the real gen_random_bytes AFTER it must survive.
        v = _ext_body(
            "  RAISE NOTICE 'a -- b';\n"
            "  PERFORM gen_random_bytes(16);"
        )
        self.assertEqual(v, ["gen_random_bytes"])

    def test_dashes_in_string_do_not_blank_closing_delimiter(self):
        # The whole body on one line: a naive find('--') would blank from the
        # dashes to EOL, eating the closing '; $$;' and dropping the function.
        sql = (
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void LANGUAGE plpgsql\n"
            "SECURITY DEFINER SET search_path = ''\n"
            "AS $$ BEGIN RAISE NOTICE 'x -- y'; PERFORM gen_random_bytes(1); END; $$;"
        )
        violations, _, _, tmp = _audit_sql(("20260101000000_f.sql", sql))
        with tmp:
            syms = [v.symbol for v in violations if v.kind == "extension-function"]
        self.assertEqual(syms, ["gen_random_bytes"])

    def test_real_line_comment_still_stripped_inside_body(self):
        # A genuine `--` comment inside the dollar body is still a comment: prose
        # mentioning the function must not be flagged.
        v = _ext_body(
            "  -- gen_random_bytes() here would fail; we qualify below\n"
            "  PERFORM extensions.gen_random_bytes(4);"
        )
        self.assertEqual(v, [])

    def test_apostrophe_in_comment_does_not_swallow_rest_of_file(self):
        # An apostrophe inside a -- comment must not flip string state and
        # suppress later stripping / scanning.
        sql = (
            "-- author's note about gen_random_bytes\n"
            "CREATE OR REPLACE FUNCTION f(p INT) RETURNS void LANGUAGE plpgsql\n"
            "SECURITY DEFINER SET search_path = ''\n"
            "AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;"
        )
        violations, _, _, tmp = _audit_sql(("20260101000000_f.sql", sql))
        with tmp:
            syms = [v.symbol for v in violations if v.kind == "extension-function"]
        self.assertEqual(syms, ["gen_random_bytes"])


# ---------------------------------------------------------------------------
# Finding #2 (:580) — block-commented function DDL must NOT be replayed.
# A commented-out CREATE/DROP/ALTER FUNCTION could otherwise overwrite or
# remove a real (buggy) definition and make the gate pass wrongly.
# ---------------------------------------------------------------------------
class TestBlockCommentedDDLNotReplayed(unittest.TestCase):
    def test_block_commented_clean_create_does_not_overwrite_bug(self):
        sql = """\
CREATE OR REPLACE FUNCTION g(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
/*
CREATE OR REPLACE FUNCTION g(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM extensions.gen_random_bytes(1); END; $$;
*/
"""
        violations, n_funcs, _, tmp = _audit_sql(("20260101000000_g.sql", sql))
        with tmp:
            syms = [v.symbol for v in violations if v.kind == "extension-function"]
            self.assertEqual(n_funcs, 1)
            self.assertEqual(syms, ["gen_random_bytes"])

    def test_block_commented_drop_does_not_remove_bug(self):
        sql = """\
CREATE OR REPLACE FUNCTION g(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
/* DROP FUNCTION g(int); */
"""
        violations, n_funcs, _, tmp = _audit_sql(("20260101000000_g.sql", sql))
        with tmp:
            syms = [v.symbol for v in violations if v.kind == "extension-function"]
            self.assertEqual(n_funcs, 1)
            self.assertEqual(syms, ["gen_random_bytes"])

    def test_real_drop_after_block_comment_still_applies(self):
        # A real (uncommented) DROP still works when a block comment precedes it.
        sql = """\
CREATE OR REPLACE FUNCTION g(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
/* note: dropping the helper below */
DROP FUNCTION g(int);
"""
        violations, n_funcs, _, tmp = _audit_sql(("20260101000000_g.sql", sql))
        with tmp:
            self.assertEqual(n_funcs, 0)
            self.assertEqual(violations, [])

    def test_create_inside_string_literal_not_replayed(self):
        # DDL text sitting inside a string literal is data, not an event.
        sql = """\
CREATE OR REPLACE FUNCTION g(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
INSERT INTO public.audit_log (note)
VALUES ('DROP FUNCTION g(int); -- historical');
"""
        violations, n_funcs, _, tmp = _audit_sql(("20260101000000_g.sql", sql))
        with tmp:
            syms = [v.symbol for v in violations if v.kind == "extension-function"]
            self.assertEqual(n_funcs, 1)
            self.assertEqual(syms, ["gen_random_bytes"])


# ---------------------------------------------------------------------------
# Finding #3 (:463) — dynamic SQL (EXECUTE '...') is SCANNED, not blanked.
# An unqualified ext call in dynamic SQL fails at runtime the same way.
# ---------------------------------------------------------------------------
class TestDynamicSQLScanning(unittest.TestCase):
    def test_execute_literal_dynamic_sql_is_scanned(self):
        v = _ext_body("  EXECUTE 'SELECT gen_random_bytes(1)';")
        self.assertEqual(v, ["gen_random_bytes"])

    def test_execute_qualified_dynamic_sql_is_clean(self):
        v = _ext_body("  EXECUTE 'SELECT extensions.gen_random_bytes(1)';")
        self.assertEqual(v, [])

    def test_execute_format_dynamic_sql_is_scanned(self):
        v = _ext_body("  EXECUTE format('SELECT gen_random_bytes(%s)', 1);")
        self.assertEqual(v, ["gen_random_bytes"])

    def test_non_execute_string_still_not_flagged(self):
        # A diagnostic that merely mentions the name is not dynamic SQL.
        v = _ext_body("  RAISE NOTICE 'gen_random_bytes(1)';")
        self.assertEqual(v, [])

    def test_nested_quoted_data_inside_dynamic_sql_not_flagged(self):
        # The ext-fn name here is nested-quoted DATA inside the dynamic SQL, not
        # an executable call, so it must NOT be flagged.
        v = _ext_body("  EXECUTE 'RAISE NOTICE ''gen_random_bytes(1)''';")
        self.assertEqual(v, [])

    def test_execute_then_real_inline_call_both_paths(self):
        # A dynamic-SQL call AND a following inline call are both caught. Inside
        # the dynamic SQL, `digest(...)` is a real unqualified call (its ''x''
        # args are nested-quoted data), so it is flagged too.
        v = _ext_body(
            "  EXECUTE 'SELECT digest(''x'', ''sha256'')';\n"
            "  PERFORM gen_random_bytes(1);"
        )
        self.assertEqual(sorted(v), ["digest", "gen_random_bytes"])


# ---------------------------------------------------------------------------
# Finding #4 (:553) — ALTER that RELAXES options must CLEAR tracked flags.
# RESET search_path / SET search_path = <nonempty> / SECURITY INVOKER move a
# function out of scope; a stale True flag would wrongly keep flagging it.
# ---------------------------------------------------------------------------
class TestAlterRelaxesClearsFlags(unittest.TestCase):
    BUGGY = """\
CREATE OR REPLACE FUNCTION f(a INT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;
"""

    def _after_alter(self, alter_sql):
        violations, n_funcs, _, tmp = _audit_sql(
            ("20260101000000_c.sql", self.BUGGY),
            ("20260102000000_alter.sql", alter_sql),
        )
        with tmp:
            return [v.symbol for v in violations if v.kind == "extension-function"]

    def test_reset_search_path_clears_empty(self):
        self.assertEqual(
            self._after_alter("ALTER FUNCTION f(INT) RESET search_path;\n"), []
        )

    def test_reset_all_clears_empty(self):
        self.assertEqual(
            self._after_alter("ALTER FUNCTION f(INT) RESET ALL;\n"), []
        )

    def test_set_search_path_nonempty_clears_empty(self):
        self.assertEqual(
            self._after_alter("ALTER FUNCTION f(INT) SET search_path = public;\n"),
            [],
        )

    def test_security_invoker_clears_secdef(self):
        self.assertEqual(
            self._after_alter("ALTER FUNCTION f(INT) SECURITY INVOKER;\n"), []
        )

    def test_unrelated_alter_leaves_flag_set(self):
        # An ALTER that touches nothing this gate tracks must NOT clear the bug.
        self.assertEqual(
            self._after_alter("ALTER FUNCTION f(INT) OWNER TO postgres;\n"),
            ["gen_random_bytes"],
        )

    def test_relax_then_reharden_reflags(self):
        # Relaxed by one migration, re-pinned to '' by a later one -> flagged.
        violations, _, _, tmp = _audit_sql(
            ("20260101000000_c.sql", self.BUGGY),
            ("20260102000000_relax.sql", "ALTER FUNCTION f(INT) RESET search_path;\n"),
            ("20260103000000_reharden.sql", "ALTER FUNCTION f(INT) SET search_path = '';\n"),
        )
        with tmp:
            syms = [v.symbol for v in violations if v.kind == "extension-function"]
        self.assertEqual(syms, ["gen_random_bytes"])


# ---------------------------------------------------------------------------
# Finding #5 (:362) — canonicalize argument types before keying functions so
# the SAME Postgres identity is not tracked as two different functions.
# ---------------------------------------------------------------------------
class TestArgTypeCanonicalization(unittest.TestCase):
    def _canon(self, args):
        return checker._normalize_signature(args)

    def test_int_aliases_canonicalize_to_integer(self):
        self.assertEqual(self._canon("a int"), ("integer",))
        self.assertEqual(self._canon("a int4"), ("integer",))
        self.assertEqual(self._canon("integer"), ("integer",))
        self.assertEqual(self._canon("int"), ("integer",))

    def test_bigint_smallint_aliases(self):
        self.assertEqual(self._canon("a int8"), ("bigint",))
        self.assertEqual(self._canon("a int2"), ("smallint",))

    def test_varchar_canonicalizes_and_typmod_dropped(self):
        self.assertEqual(self._canon("a varchar(255)"), ("character varying",))
        self.assertEqual(self._canon("character varying"), ("character varying",))

    def test_numeric_typmod_dropped(self):
        self.assertEqual(self._canon("a numeric(10, 2)"), ("numeric",))
        self.assertEqual(self._canon("decimal"), ("numeric",))

    def test_double_precision_with_and_without_name_match(self):
        # The crux: a two-word type must not have its first word mistaken for a
        # parameter name.
        self.assertEqual(self._canon("double precision"), ("double precision",))
        self.assertEqual(self._canon("a double precision"), ("double precision",))
        self.assertEqual(self._canon("float8"), ("double precision",))

    def test_timestamp_with_time_zone_variants(self):
        self.assertEqual(
            self._canon("timestamp with time zone"), ("timestamp with time zone",)
        )
        self.assertEqual(
            self._canon("ts timestamp with time zone"),
            ("timestamp with time zone",),
        )
        self.assertEqual(self._canon("timestamptz"), ("timestamp with time zone",))

    def test_array_types_canonicalize(self):
        self.assertEqual(self._canon("a int[]"), ("integer[]",))
        self.assertEqual(self._canon("a text array"), ("text[]",))

    def test_same_identity_int_vs_integer_latest_wins(self):
        # int and integer name the same function; the later (fixed) def wins.
        sql_bug = (
            "CREATE OR REPLACE FUNCTION f(a int) RETURNS void LANGUAGE plpgsql\n"
            "SECURITY DEFINER SET search_path = ''\n"
            "AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;"
        )
        sql_fix = (
            "CREATE OR REPLACE FUNCTION f(a integer) RETURNS void LANGUAGE plpgsql\n"
            "SECURITY DEFINER SET search_path = ''\n"
            "AS $$ BEGIN PERFORM extensions.gen_random_bytes(1); END; $$;"
        )
        violations, n_funcs, _, tmp = _audit_sql(
            ("20260101000000_a.sql", sql_bug),
            ("20260102000000_b.sql", sql_fix),
        )
        with tmp:
            self.assertEqual(n_funcs, 1, "int/integer are one effective identity")
            self.assertEqual(violations, [])

    def test_drop_with_canonical_type_matches_alias_create(self):
        # CREATE f(double precision) dropped by DROP f(float8) — same identity.
        create = (
            "CREATE OR REPLACE FUNCTION f(a double precision) RETURNS void\n"
            "LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''\n"
            "AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;"
        )
        drop = "DROP FUNCTION f(float8);\n"
        violations, n_funcs, _, tmp = _audit_sql(
            ("20260101000000_a.sql", create),
            ("20260102000000_b.sql", drop),
        )
        with tmp:
            self.assertEqual(n_funcs, 0, "float8 == double precision -> dropped")
            self.assertEqual(violations, [])

    def test_alter_with_alias_type_matches_create(self):
        # ALTER f(varchar) hardening a CREATE f(character varying).
        create = (
            "CREATE OR REPLACE FUNCTION f(a character varying) RETURNS void\n"
            "LANGUAGE plpgsql SECURITY DEFINER\n"
            "AS $$ BEGIN PERFORM gen_random_bytes(1); END; $$;"
        )
        alter = "ALTER FUNCTION f(varchar) SET search_path = '';\n"
        violations, _, _, tmp = _audit_sql(
            ("20260101000000_a.sql", create),
            ("20260102000000_b.sql", alter),
        )
        with tmp:
            syms = [v.symbol for v in violations if v.kind == "extension-function"]
        self.assertEqual(syms, ["gen_random_bytes"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
