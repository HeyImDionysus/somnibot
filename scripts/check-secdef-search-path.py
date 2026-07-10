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
    precise — an unqualified `gen_random_bytes(` in executable code either is or
    is not present; string literals and comments are blanked first so mentions
    in data or prose do not produce false positives.

ADVISORY check (opt-in via --include-tables; only gates with --tables-fatal):

  * Unqualified base-table references in INSERT INTO / UPDATE / DELETE FROM /
    FROM / JOIN clauses. Under `search_path = ''` these must be schema-qualified
    (`public.foo`). This is best-effort: CTE names (WITH ... AS) are excluded,
    but a regex cannot fully distinguish every CTE / record variable / alias
    from a real table, so it is advisory-only by default and kept out of the
    pass/fail gate to avoid false positives blocking CI.

Semantics: EFFECTIVE schema. A function's state is built by replaying all
migrations in timestamp order:
  * CREATE [OR REPLACE] FUNCTION      — the latest definition wins;
  * DROP FUNCTION                     — removes it from the audited set;
  * ALTER FUNCTION ... SET/SECURITY   — updates its tracked options.
Identity is the full Postgres key (schema, name, argument-type signature); an
unqualified name resolves to `public`. Only the final effective definition of
each function is evaluated, so a historical buggy definition that a later
migration fixes, drops, or hardens produces no noise on a clean main — but
reverting that fix immediately re-flags the bug.

Non-code regions are ignored before matching: -- line comments, /* */ block
comments, and single-quoted string literals are blanked (positions preserved),
so a name that appears only in data (`'Buy something from the shop'`) or a
diagnostic (`RAISE NOTICE 'gen_random_bytes(16)'`) is never mistaken for a live
reference. Both dollar-quoted (`$$`/`$tag$`) and single-quoted (`AS '...'`)
function bodies are parsed, and option clauses are read whether they precede or
trail the body.

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
        # pgcrypto — digest / hmac / crypt / gen_salt / encrypt family
        "gen_random_bytes",
        "gen_salt",
        "crypt",
        "digest",
        "hmac",
        "encrypt",
        "decrypt",
        "encrypt_iv",
        "decrypt_iv",
        # pgcrypto — PGP symmetric / public-key
        "pgp_sym_encrypt",
        "pgp_sym_encrypt_bytea",
        "pgp_sym_decrypt",
        "pgp_sym_decrypt_bytea",
        "pgp_pub_encrypt",
        "pgp_pub_encrypt_bytea",
        "pgp_pub_decrypt",
        "pgp_pub_decrypt_bytea",
        "pgp_key_id",
        # pgcrypto — ASCII armor helpers
        "armor",
        "dearmor",
        # uuid-ossp — generators
        "uuid_generate_v1",
        "uuid_generate_v1mc",
        "uuid_generate_v3",
        "uuid_generate_v4",
        "uuid_generate_v5",
        "uuid_nil",
        # uuid-ossp — well-known namespace constants
        "uuid_ns_dns",
        "uuid_ns_url",
        "uuid_ns_oid",
        "uuid_ns_x500",
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


# Absent CREATE FUNCTION schema resolves to the first entry of the creating
# role's search_path; in this repo that is always `public`. Normalizing an
# unqualified name to `public` lets a `DROP FUNCTION public.f(...)` /
# `ALTER FUNCTION public.f(...)` match an unqualified `CREATE FUNCTION f(...)`.
DEFAULT_SCHEMA = "public"


def _normalize_schema(schema):
    return (schema or DEFAULT_SCHEMA).lower()


class Function:
    """One CREATE [OR REPLACE] FUNCTION occurrence in a migration file."""

    __slots__ = (
        "schema",
        "name",
        "signature",
        "file",
        "line",
        "security_definer",
        "search_path_empty",
        "body",
        "body_line_offset",
    )

    def __init__(self, schema, name, signature, file, line):
        self.schema = _normalize_schema(schema)
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
        """Effective identity: (schema, name, normalized arg-type signature).

        Postgres function identity is schema-qualified, so `public.f(int)` and
        `private.f(int)` are distinct definitions and must not collapse onto one
        effective entry.
        """
        return (self.schema, self.name.lower(), self.signature)


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


def _blank_strings_and_block_comments(text):
    """Replace single-quoted string literals and /* */ block comments with
    spaces, preserving length and newlines so line/column positions are exact.

    Names mentioned inside data (`'Buy something from the shop'`) or diagnostics
    (`RAISE NOTICE 'gen_random_bytes(16)'`) or block comments
    (`/* gen_random_bytes(16) */`) are NOT executable references and must not be
    matched by the table / extension-function scanners. Blanking them before
    scanning eliminates that entire false-positive class.

    Postgres string-literal rules honored:
      * a doubled quote ('') inside a literal is an escaped quote, not a
        terminator;
      * dollar-quoted regions are NOT treated as strings here — this runs on a
        function body that has already been extracted between its dollar tags,
        and any *inner* dollar-quoted block is left intact (dollar-quoted text
        rarely holds a false ref, and treating it as a string could hide a real
        `EXECUTE $q$ ... gen_random_bytes( ... $q$` call).
    """
    out = list(text)
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "'":
            j = i + 1
            while j < n:
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'":
                        j += 2  # escaped '' — stay inside the literal
                        continue
                    break
                j += 1
            # Blank the literal contents (keep the quote chars themselves so a
            # bare '' empty-search_path marker elsewhere is unaffected).
            for k in range(i + 1, min(j, n)):
                if out[k] != "\n":
                    out[k] = " "
            i = j + 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            j = i + 2
            while j < n and not (text[j] == "*" and j + 1 < n and text[j + 1] == "/"):
                j += 1
            end = min(j + 2, n)
            for k in range(i, end):
                if out[k] != "\n":
                    out[k] = " "
            i = end
            continue
        i += 1
    return "".join(out)


# CREATE [OR REPLACE] FUNCTION [schema.]name ( args... ) up to the arg-list ).
_FUNC_HEADER_RE = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"
    r"(?:(?P<schema>[a-zA-Z_]\w*)\s*\.\s*)?"
    r"(?P<name>[a-zA-Z_]\w*)\s*"
    r"\((?P<args>[^)]*(?:\([^)]*\)[^)]*)*)\)",
    re.IGNORECASE,
)

# DROP FUNCTION [IF EXISTS] [schema.]name ( args... )  — args optional.
_DROP_FUNC_RE = re.compile(
    r"DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?"
    r"(?:(?P<schema>[a-zA-Z_]\w*)\s*\.\s*)?"
    r"(?P<name>[a-zA-Z_]\w*)\s*"
    r"(?:\((?P<args>[^)]*(?:\([^)]*\)[^)]*)*)\))?",
    re.IGNORECASE,
)

# ALTER FUNCTION [schema.]name ( args... ) <options...> ;  — capture the option
# tail so `SET search_path = ''` / `SECURITY DEFINER` added later take effect.
_ALTER_FUNC_RE = re.compile(
    r"ALTER\s+FUNCTION\s+"
    r"(?:(?P<schema>[a-zA-Z_]\w*)\s*\.\s*)?"
    r"(?P<name>[a-zA-Z_]\w*)\s*"
    r"(?:\((?P<args>[^)]*(?:\([^)]*\)[^)]*)*)\))?"
    r"(?P<opts>[^;]*)",
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


# A dollar-quote delimiter: $$ or a tagged $name$ (name is an identifier).
_DOLLAR_TAG_RE = re.compile(r"\$(?:[a-zA-Z_]\w*)?\$")
# The function body is introduced by `AS`, then either a dollar tag or a
# single-quoted literal. Anchoring on `AS` is essential: an option clause such
# as `SET search_path = ''` contains single quotes that are NOT a body start,
# so a bare "first quote" search would truncate the preamble mid-option.
_AS_BODY_START_RE = re.compile(
    r"\bAS\s+(?P<delim>\$(?:[a-zA-Z_]\w*)?\$|')", re.IGNORECASE
)


def _find_body(sql, header_end):
    """Return (body, body_start_index, body_end_index) for the function body
    after header_end. body_end_index points just past the closing delimiter.

    The body is the delimiter that follows the `AS` keyword. Two valid Postgres
    body forms are handled:

      * Dollar-quoted: bare `$$` or TAGGED (`$function$`, `$body$`, ...). The
        OPENING tag is matched to its identical CLOSING tag, so a nested block
        with a *different* tag (`EXECUTE $q$ ... $q$` inside `$$ ... $$`) is
        part of the body, and an inner `$$` never truncates a `$function$` body.

      * Single-quoted string literal: `AS 'BEGIN ... END;'`. A doubled quote
        ('') inside is an escaped quote, not the terminator. Some migrations use
        this form; dropping it would let a real unqualified extension call slip
        through unscanned.

    Returns (None, None, None) if there is no recognizable body (e.g. a SQL
    `RETURN` one-liner, or `AS 'module', 'symbol'` C-language bindings) —
    nothing to lint in that case.
    """
    open_m = _AS_BODY_START_RE.search(sql, header_end)
    if open_m is None:
        return None, None, None
    delim = open_m.group("delim")
    body_start = open_m.end()
    if delim == "'":
        # Single-quoted body: find the terminating quote, honoring '' escapes.
        j = body_start
        n = len(sql)
        while j < n:
            if sql[j] == "'":
                if j + 1 < n and sql[j + 1] == "'":
                    j += 2
                    continue
                return sql[body_start:j], body_start, j + 1
            j += 1
        return None, None, None
    close_idx = sql.find(delim, body_start)
    if close_idx == -1:
        return None, None, None
    return sql[body_start:close_idx], body_start, close_idx + len(delim)


_SECDEF_RE = re.compile(r"\bSECURITY\s+DEFINER\b", re.IGNORECASE)
# SET search_path = '' (truly empty: two adjacent single quotes). Postgres
# accepts both `= ''` and `TO ''`, and the parameter name may be a quoted
# identifier ("search_path"); match all of these.
_SEARCH_PATH_EMPTY_RE = re.compile(
    r"\bSET\s+\"?search_path\"?\s*(?:=|\bTO\b)\s*''(?!\S)", re.IGNORECASE
)


def parse_functions(sql, filename):
    """Extract Function objects (with attributes + body) from one migration."""
    clean = _strip_line_comments(sql)
    functions = []
    for m in _FUNC_HEADER_RE.finditer(clean):
        schema = m.group("schema")
        name = m.group("name")
        signature = _normalize_signature(m.group("args"))
        line = clean.count("\n", 0, m.start()) + 1
        fn = Function(schema, name, signature, filename, line)

        header_end = m.end()
        body, body_start, body_end = _find_body(clean, header_end)
        if body is None:
            continue

        # Option clauses (LANGUAGE / SECURITY DEFINER / SET search_path) may
        # appear BEFORE the body (between the arg list and the opening $$) or
        # AFTER it (a valid Postgres form this repo uses:
        # `AS $$ ... $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''`).
        # Scan both regions so trailing options are never missed.
        preamble = clean[header_end:body_start]
        trailer_end = clean.find(";", body_end)
        if trailer_end == -1:
            trailer_end = len(clean)
        trailer = clean[body_end:trailer_end]
        options = preamble + "\n" + trailer

        fn.security_definer = _SECDEF_RE.search(options) is not None
        fn.search_path_empty = _SEARCH_PATH_EMPTY_RE.search(options) is not None
        # Blank string literals / block comments in the body so data and
        # diagnostics that merely mention a name are not matched as references.
        fn.body = _blank_strings_and_block_comments(body)
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


def _apply_drop(effective, schema, name, args):
    """Remove matching function(s) from effective state for a DROP FUNCTION.

    If the DROP names an explicit argument list, only the exact (schema, name,
    signature) entry is removed. If args are omitted (`DROP FUNCTION f`), every
    overload of (schema, name) is removed — that matches Postgres, which
    requires a unique match but in practice these migrations only have one.
    """
    schema = _normalize_schema(schema)
    name = name.lower()
    if args is not None:
        sig = _normalize_signature(args)
        effective.pop((schema, name, sig), None)
        return
    for k in [k for k in effective if k[0] == schema and k[1] == name]:
        del effective[k]


def _apply_alter(effective, schema, name, args, opts):
    """Apply ALTER FUNCTION option changes (SET search_path='' / SECURITY
    DEFINER) to the tracked effective definition(s)."""
    schema = _normalize_schema(schema)
    name = name.lower()
    sets_empty = _SEARCH_PATH_EMPTY_RE.search(opts) is not None
    sets_secdef = _SECDEF_RE.search(opts) is not None
    if not sets_empty and not sets_secdef:
        return
    if args is not None:
        sig = _normalize_signature(args)
        targets = [(schema, name, sig)] if (schema, name, sig) in effective else []
    else:
        targets = [k for k in effective if k[0] == schema and k[1] == name]
    for k in targets:
        fn = effective[k]
        if sets_empty:
            fn.search_path_empty = True
        if sets_secdef:
            fn.security_definer = True


def _apply_statements(effective, sql, path):
    """Apply every CREATE / DROP / ALTER FUNCTION statement in one migration to
    the effective-state map, in document order.

    Document order matters within a single file: a CREATE then a later ALTER in
    the same migration must both land. Line comments are stripped first so a
    `-- DROP FUNCTION ...` note is not treated as a real drop.
    """
    clean = _strip_line_comments(sql)
    events = []
    for m in _FUNC_HEADER_RE.finditer(clean):
        events.append((m.start(), "create", m))
    for m in _DROP_FUNC_RE.finditer(clean):
        events.append((m.start(), "drop", m))
    for m in _ALTER_FUNC_RE.finditer(clean):
        events.append((m.start(), "alter", m))
    events.sort(key=lambda e: e[0])

    parsed_creates = {fn.line: fn for fn in parse_functions(sql, os.fspath(path))}
    for _, kind, m in events:
        if kind == "create":
            line = clean.count("\n", 0, m.start()) + 1
            fn = parsed_creates.get(line)
            if fn is not None:
                effective[fn.key] = fn  # later def overwrites earlier
        elif kind == "drop":
            _apply_drop(effective, m.group("schema"), m.group("name"), m.group("args"))
        else:  # alter
            _apply_alter(
                effective,
                m.group("schema"),
                m.group("name"),
                m.group("args"),
                m.group("opts") or "",
            )


def collect_effective_functions(migration_files):
    """Build effective state across all migrations in timestamp order.

    Applies CREATE (latest def wins), DROP (removes), and ALTER (option changes)
    so the audited set reflects the FINAL schema: a function dropped or hardened
    by a later migration is scored on that final state, not a stale earlier one.
    """
    effective = {}
    for path in sorted(migration_files, key=lambda p: Path(p).name):
        sql = Path(path).read_text(encoding="utf-8")
        _apply_statements(effective, sql, os.fspath(path))
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
