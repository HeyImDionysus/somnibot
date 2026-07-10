#!/usr/bin/env python3
"""
Static linter: SECURITY DEFINER functions with SET search_path = '' that
reference an extension-provided function (or a table) UNQUALIFIED.

Why this exists
---------------
On Supabase, pgcrypto / uuid-ossp live in the `extensions` schema (never
pg_catalog). A SECURITY DEFINER function pinned to `SET search_path = ''`
resolves names with an EMPTY search path, so anything not in pg_catalog must
be schema-qualified. The lottery outage was exactly this: v7 switched ticket
generation to `gen_random_bytes()` (pgcrypto) but left the call unqualified
inside a `search_path = ''` SECURITY DEFINER function, so every purchase raised
`function gen_random_bytes(integer) does not exist` at runtime. The migration
applied fine and the compiler was silent, so only production caught it.

What this checks
----------------
GATING check (default; exit 1 on any hit) — the exact outage bug class:

  * Unqualified calls to KNOWN extension functions (pgcrypto, uuid-ossp)
    inside SECURITY DEFINER + search_path='' function bodies.
    `gen_random_uuid()` is deliberately NOT flagged: it is a pg_catalog builtin
    (Postgres 13+) that resolves fine under an empty search_path. This check is
    precise — an unqualified `gen_random_bytes(` either is or is not present;
    there are no false positives.

ADVISORY check (opt-in via --include-tables; only gates with --tables-fatal):

  * Unqualified base-table references in INSERT INTO / UPDATE / DELETE FROM /
    FROM / JOIN clauses. Under `search_path = ''` these must be schema-qualified
    (`public.foo`). This is best-effort: CTE names (WITH ... AS) are excluded,
    but a regex cannot fully distinguish every CTE / record variable / alias
    from a real table, so it is advisory-only by default and kept out of the
    pass/fail gate to avoid false positives blocking CI.

Semantics: EFFECTIVE schema. A function is defined by its LATEST
`CREATE OR REPLACE FUNCTION` across all migrations in timestamp order. Only the
latest definition of each (name + argument-type signature) is evaluated, so a
historical buggy definition that a later migration fixes produces no noise on a
clean main — but reverting the fix immediately re-flags the bug.

Exit code 0 = clean, 1 = gating violations found, 2 = usage/parse error.
"""

import argparse
import os
import re
import sys
from pathlib import Path

# Repo-relative default; overridable via --migrations-dir or MIGRATIONS_DIR env.
DEFAULT_MIGRATIONS_DIR = Path("packages/supabase/migrations")

# Functions shipped by common Postgres extensions that do NOT live in
# pg_catalog. Under SET search_path = '' these MUST be schema-qualified.
#   pgcrypto  -> extensions schema on Supabase
#   uuid-ossp -> extensions schema on Supabase
# gen_random_uuid is intentionally absent: it is a pg_catalog builtin (PG13+)
# and resolves under an empty search_path, so flagging it would be a false
# positive.
EXTENSION_FUNCTIONS = frozenset(
    {
        # pgcrypto
        "gen_random_bytes",
        "gen_salt",
        "crypt",
        "digest",
        "hmac",
        "encrypt",
        "decrypt",
        "encrypt_iv",
        "decrypt_iv",
        "pgp_sym_encrypt",
        "pgp_sym_decrypt",
        "pgp_pub_encrypt",
        "pgp_pub_decrypt",
        # uuid-ossp
        "uuid_generate_v1",
        "uuid_generate_v1mc",
        "uuid_generate_v3",
        "uuid_generate_v4",
        "uuid_generate_v5",
        "uuid_nil",
    }
)

# Tokens that can follow FROM/JOIN/INTO etc. but are never a base-table name.
_TABLE_REF_STOPWORDS = frozenset(
    {
        "select",
        "lateral",
        "only",
        "set",  # UPDATE <alias> SET ...
        "where",
        "values",
        "generate_series",
        "unnest",
        "jsonb_array_elements",
        "jsonb_array_elements_text",
        "json_array_elements",
        "json_array_elements_text",
        "jsonb_to_recordset",
        "jsonb_each",
        "jsonb_each_text",
        "json_each",
        "regexp_split_to_table",
        "string_to_table",
    }
)


class Function:
    """One CREATE [OR REPLACE] FUNCTION occurrence in a migration file."""

    __slots__ = (
        "name",
        "signature",
        "file",
        "line",
        "security_definer",
        "search_path_empty",
        "body",
        "body_line_offset",
    )

    def __init__(self, name, signature, file, line):
        self.name = name
        self.signature = signature
        self.file = file
        self.line = line
        self.security_definer = False
        self.search_path_empty = False
        self.body = ""
        self.body_line_offset = line

    @property
    def key(self):
        """Effective-schema identity: name + normalized arg-type signature."""
        return (self.name.lower(), self.signature)


class Violation:
    # kind: "extension-function" (gating) | "unqualified-table" (advisory)
    GATING = frozenset({"extension-function"})

    def __init__(self, function, kind, symbol, line):
        self.function = function
        self.kind = kind
        self.symbol = symbol
        self.line = line

    @property
    def gating(self):
        return self.kind in self.GATING

    def format(self):
        f = self.function
        if self.kind == "extension-function":
            detail = (
                f"unqualified extension function `{self.symbol}(...)` "
                f"(schema-qualify it, e.g. `extensions.{self.symbol}(...)`)"
            )
        else:
            detail = (
                f"unqualified table reference `{self.symbol}` "
                f"(schema-qualify it, e.g. `public.{self.symbol}`)"
            )
        return (
            f"{f.file}:{self.line}: {f.name}(): {detail}\n"
            f"    -> SECURITY DEFINER + SET search_path = '' "
            f"resolves names with an empty search_path"
        )


def _strip_line_comments(sql):
    """Blank out -- line comments, preserving line/column positions.

    Prose describing the bug (e.g. a comment that literally says
    "gen_random_bytes without extensions. prefix would fail") must not trip the
    scanner. Newlines and character count are preserved so reported line numbers
    stay accurate.
    """
    out = []
    for line in sql.split("\n"):
        idx = line.find("--")
        if idx == -1:
            out.append(line)
        else:
            out.append(line[:idx] + " " * (len(line) - idx))
    return "\n".join(out)


# CREATE [OR REPLACE] FUNCTION [schema.]name ( args... ) up to the arg-list ).
_FUNC_HEADER_RE = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"
    r"(?:(?P<schema>[a-zA-Z_]\w*)\s*\.\s*)?"
    r"(?P<name>[a-zA-Z_]\w*)\s*"
    r"\((?P<args>[^)]*(?:\([^)]*\)[^)]*)*)\)",
    re.IGNORECASE,
)


def _normalize_signature(args_raw):
    """Reduce an argument list to a comparable ordered type signature.

    Drops parameter names, IN/OUT/VARIADIC markers and DEFAULTs; keeps the base
    type tokens. Enough to distinguish overloads.
    """
    args = args_raw.strip()
    if not args:
        return ()
    parts = []
    depth = 0
    current = []
    for ch in args:
        if ch == "(":
            depth += 1
            current.append(ch)
        elif ch == ")":
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    if current:
        parts.append("".join(current))

    sig = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        p = re.split(r"\bDEFAULT\b", p, flags=re.IGNORECASE)[0].strip()
        tokens = p.split()
        while tokens and tokens[0].upper() in ("IN", "OUT", "INOUT", "VARIADIC"):
            tokens.pop(0)
        if not tokens:
            continue
        type_tokens = tokens[1:] if len(tokens) >= 2 else tokens
        sig.append(" ".join(type_tokens).lower().rstrip(","))
    return tuple(sig)


def _find_body(sql, header_end):
    """Return (body, body_start_index) for the first $$...$$ after header_end.

    Returns (None, None) if the function has no dollar-quoted body (e.g. a SQL
    RETURN one-liner) — nothing to lint in that case.
    """
    open_idx = sql.find("$$", header_end)
    if open_idx == -1:
        return None, None
    body_start = open_idx + 2
    close_idx = sql.find("$$", body_start)
    if close_idx == -1:
        return None, None
    return sql[body_start:close_idx], body_start


def parse_functions(sql, filename):
    """Extract Function objects (with attributes + body) from one migration."""
    clean = _strip_line_comments(sql)
    functions = []
    for m in _FUNC_HEADER_RE.finditer(clean):
        name = m.group("name")
        signature = _normalize_signature(m.group("args"))
        line = clean.count("\n", 0, m.start()) + 1
        fn = Function(name, signature, filename, line)

        header_end = m.end()
        body, body_start = _find_body(clean, header_end)
        if body is None:
            continue

        # Attribute clauses live BETWEEN the arg list and the opening $$.
        preamble = clean[header_end:body_start]
        fn.security_definer = (
            re.search(r"\bSECURITY\s+DEFINER\b", preamble, re.IGNORECASE)
            is not None
        )
        # SET search_path = '' (truly empty: two adjacent single quotes).
        fn.search_path_empty = (
            re.search(r"\bSET\s+search_path\s*=\s*''(?!\S)", preamble, re.IGNORECASE)
            is not None
        )
        fn.body = body
        fn.body_line_offset = clean.count("\n", 0, body_start) + 1
        functions.append(fn)
    return functions


def _line_of_offset(body, offset, body_line_offset):
    return body_line_offset + body.count("\n", 0, offset)


def _cte_names(body):
    """Collect CTE names declared in the body (WITH x AS (...), y AS (...))."""
    names = set()
    # WITH [RECURSIVE] name AS  |  , name AS   (the "AS" precedes "(" or a query)
    for m in re.finditer(
        r"(?:\bWITH\b(?:\s+RECURSIVE)?|,)\s*(?P<cte>[a-zA-Z_]\w*)\s+AS\s*\(",
        body,
        re.IGNORECASE,
    ):
        names.add(m.group("cte").lower())
    return names


def scan_body(fn, include_tables=False):
    """Return list[Violation] for one (already SECDEF+empty) function body."""
    violations = []
    body = fn.body

    # --- Gating: unqualified extension function calls. ---
    for func_name in EXTENSION_FUNCTIONS:
        for m in re.finditer(
            r"(?<![\w.])" + re.escape(func_name) + r"\s*\(",
            body,
            re.IGNORECASE,
        ):
            line = _line_of_offset(body, m.start(), fn.body_line_offset)
            violations.append(Violation(fn, "extension-function", func_name, line))

    if not include_tables:
        return violations

    # --- Advisory: unqualified base-table references. ---
    ctes = _cte_names(body)
    table_ctx_re = re.compile(
        r"\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|FROM|JOIN)\s+"
        r"(?P<ref>[a-zA-Z_]\w*)",
        re.IGNORECASE,
    )
    for m in table_ctx_re.finditer(body):
        ref = m.group("ref")
        low = ref.lower()
        after = body[m.end():m.end() + 1]
        if after == ".":
            continue  # schema-qualified (FROM public.foo captured "public")
        if low in _TABLE_REF_STOPWORDS or low in ctes:
            continue
        # A set-returning function call (name followed by "(") is not a table.
        if body[m.end():].lstrip().startswith("("):
            continue
        line = _line_of_offset(body, m.start(), fn.body_line_offset)
        violations.append(Violation(fn, "unqualified-table", ref, line))

    return violations


def collect_effective_functions(migration_files):
    """Parse all migrations in timestamp order; keep the LAST def per key."""
    effective = {}
    for path in sorted(migration_files, key=lambda p: Path(p).name):
        sql = Path(path).read_text(encoding="utf-8")
        for fn in parse_functions(sql, os.fspath(path)):
            effective[fn.key] = fn  # later timestamp overwrites earlier
    return effective


def audit(migrations_dir, include_tables=False):
    """Return (violations, n_effective_functions, n_files)."""
    migrations_dir = Path(migrations_dir)
    files = sorted(migrations_dir.glob("*.sql"))
    effective = collect_effective_functions(files)
    violations = []
    for fn in effective.values():
        if fn.security_definer and fn.search_path_empty:
            violations.extend(scan_body(fn, include_tables=include_tables))
    violations.sort(key=lambda v: (v.function.file, v.line, v.symbol))
    return violations, len(effective), len(files)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Flag SECURITY DEFINER functions with SET search_path = '' that "
            "reference extension functions (or tables) unqualified."
        )
    )
    parser.add_argument(
        "--migrations-dir",
        default=os.environ.get("MIGRATIONS_DIR", str(DEFAULT_MIGRATIONS_DIR)),
        help="Directory containing *.sql migrations "
        "(default: packages/supabase/migrations or $MIGRATIONS_DIR).",
    )
    parser.add_argument(
        "--include-tables",
        action="store_true",
        help="Also report unqualified base-table references (advisory; "
        "best-effort — see module docstring).",
    )
    parser.add_argument(
        "--tables-fatal",
        action="store_true",
        help="Make unqualified-table findings fail the build too (implies "
        "--include-tables). Off by default because table detection is "
        "best-effort.",
    )
    args = parser.parse_args(argv)

    include_tables = args.include_tables or args.tables_fatal
    migrations_dir = Path(args.migrations_dir)
    if not migrations_dir.is_dir():
        print(f"error: migrations dir not found: {migrations_dir}", file=sys.stderr)
        return 2

    violations, n_funcs, n_files = audit(migrations_dir, include_tables=include_tables)

    print("=== SECURITY DEFINER search_path='' unqualified-reference audit ===")
    print(
        f"Scanned {n_files} migration file(s), "
        f"{n_funcs} effective function definition(s)."
    )

    gating = [v for v in violations if v.gating]
    advisory = [v for v in violations if not v.gating]

    if not gating and not advisory:
        print(
            "OK: no unqualified extension/table references in "
            "SECURITY DEFINER + search_path='' functions."
        )
        return 0

    if gating:
        print(f"\nFOUND {len(gating)} gating violation(s):\n")
        for v in gating:
            print(v.format())

    if advisory:
        label = "gating" if args.tables_fatal else "advisory"
        print(f"\n{len(advisory)} unqualified-table finding(s) ({label}):\n")
        for v in advisory:
            print(v.format())

    print(
        "\nEach flagged reference fails at RUNTIME (not at migration apply "
        "time)\nbecause an empty search_path cannot resolve non-pg_catalog "
        "names.\nSchema-qualify them (extensions.<fn> / public.<table>)."
    )

    if gating or (advisory and args.tables_fatal):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
