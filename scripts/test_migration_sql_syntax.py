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

_UPSERT_RETURN = re.compile(
    r"(?ims)^\s*ON\s+CONFLICT\b(?P<body>.{0,2000}?)\bRETURN\b(?!ING)"
)


def find_unterminated_upserts(sql: str) -> bool:
    """Return whether an ON CONFLICT statement reaches RETURN without ``;``."""

    for match in _UPSERT_RETURN.finditer(sql):
        body = match.group("body").rstrip()
        if ";" not in body:
            return True
    return False


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


if __name__ == "__main__":
    unittest.main()
