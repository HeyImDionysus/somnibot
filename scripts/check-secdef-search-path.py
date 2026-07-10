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

Non-code regions are ignored before matching: -- line comments (honoring string
literals, so a `--` inside `'...'` is data not a comment), /* */ block comments,
and non-executable single-quoted string literals are blanked (positions
preserved), so a name that appears only in data (`'Buy something from the shop'`)
or a diagnostic (`RAISE NOTICE 'gen_random_bytes(16)'`) is never mistaken for a
live reference. Dynamic SQL is the exception: an `EXECUTE '... gen_random_bytes(
...'` string runs under the SAME empty search_path and IS scanned (nested `''`
data inside it is still blanked). Both dollar-quoted (`$$`/`$tag$`) and
single-quoted (`AS '...'`) function bodies are parsed, and option clauses are
read whether they precede or trail the body. Block-commented and string-embedded
CREATE/DROP/ALTER FUNCTION statements are NOT replayed into effective state.

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

    A `--` is only a comment when it is NOT inside a single-quoted string
    literal. `RAISE NOTICE '--';` and `'Buy -- now'` contain dashes that are
    string DATA, not a comment: a naive per-line `find("--")` would truncate at
    those dashes, blanking the literal's closing quote (or a dollar delimiter
    that follows on the same physical line), which corrupts body extraction and
    can skip a function or blank a live `gen_random_bytes(...)` after it.

    Inside a dollar-quoted plpgsql body, `--` IS still a comment — dollar quoting
    delimits the body but the body is code — so we do NOT suppress `--`
    stripping there; we only need to keep tracking single-quote literals (where
    `'...'` inside the body is a plpgsql string in which `--` is data). Tracking
    single-quote state alone (with `''` escapes) handles all of this correctly.
    """
    out = list(sql)
    i = 0
    n = len(sql)
    in_string = False  # inside a single-quoted '...' literal
    while i < n:
        ch = sql[i]
        if in_string:
            if ch == "'":
                if i + 1 < n and sql[i + 1] == "'":
                    i += 2  # doubled '' escape — stay inside the literal
                    continue
                in_string = False
            i += 1
            continue
        if ch == "'":
            in_string = True
            i += 1
            continue
        if ch == "\n":
            in_string = False  # a runaway quote cannot swallow later lines
            i += 1
            continue
        if ch == "-" and i + 1 < n and sql[i + 1] == "-":
            # Blank from here to end of line (positions/newlines preserved).
            j = i
            while j < n and sql[j] != "\n":
                out[j] = " "
                j += 1
            i = j
            continue
        i += 1
    return "".join(out)


def _blank_noncode_for_statements(text):
    """Blank strings, block comments AND dollar-quoted bodies, preserving
    positions, so top-level statement scanning (CREATE/DROP/ALTER FUNCTION event
    collection) sees only real code.

    Event collection must NOT peer into a function body: a `CREATE FUNCTION` that
    appears there is either dynamic-SQL DDL (out of scope for effective-state
    replay) or plain text, and leaving the body intact risks a stray quote there
    mispairing and corrupting a following real DDL statement. Blanking the whole
    body — matching opening dollar tag to its identical closing tag — removes
    that hazard while keeping line/column numbers exact (so `create` events
    still line up with `parse_functions`). The per-body scanner
    (`_prepare_body_for_scan`) is the counterpart that DOES look inside bodies
    and dynamic SQL for unqualified references.
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
                        j += 2
                        continue
                    break
                j += 1
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
        if ch == "$":
            m = _DOLLAR_TAG_RE.match(text, i)
            if m is not None:
                tag = m.group(0)
                close = text.find(tag, i + len(tag))
                if close == -1:
                    end = n  # unterminated body — blank to EOF
                else:
                    end = close + len(tag)
                for k in range(i, end):
                    if out[k] != "\n":
                        out[k] = " "
                i = end
                continue
        i += 1
    return "".join(out)


# A single-quoted string literal is dynamic SQL (executable) when it is the
# operand of EXECUTE — either `EXECUTE '...'` or `EXECUTE format('...', ...)`.
# Such a string runs under the SAME empty search_path, so an unqualified
# `gen_random_bytes(` inside it fails at runtime exactly like inline code and
# MUST be scanned, not blanked. `\s*` allows the `format(` wrapper.
_EXECUTE_LEADIN_RE = re.compile(r"\bEXECUTE\s+(?:format\s*\(\s*)?$", re.IGNORECASE)


def _prepare_body_for_scan(body):
    """Prepare a function body for the extension/table scanners.

    Blanks block comments and NON-executable string literals (data,
    diagnostics), but PRESERVES the code inside dynamic-SQL strings that are the
    operand of `EXECUTE` / `EXECUTE format(...)` so an unqualified extension call
    hidden in dynamic SQL is still caught. Positions (line/column) are preserved
    throughout so reported line numbers stay accurate.

    False-positive safety inside dynamic SQL: a nested single-quoted literal
    (written `''`-doubled inside the outer string) is data within the dynamic
    SQL — e.g. `EXECUTE 'RAISE NOTICE ''gen_random_bytes(1)'''` — so its
    contents are blanked too. Only bare (unquoted) references in the dynamic SQL
    remain, which is precisely the runtime-failing form.
    """
    out = list(body)
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if ch == "/" and i + 1 < n and body[i + 1] == "*":
            j = i + 2
            while j < n and not (body[j] == "*" and j + 1 < n and body[j + 1] == "/"):
                j += 1
            end = min(j + 2, n)
            for k in range(i, end):
                if out[k] != "\n":
                    out[k] = " "
            i = end
            continue
        if ch == "'":
            # Find the matching close quote, honoring '' escapes.
            j = i + 1
            while j < n:
                if body[j] == "'":
                    if j + 1 < n and body[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            # Is this string the operand of EXECUTE [format(]?  Look at the
            # code immediately before the opening quote.
            is_dynamic = _EXECUTE_LEADIN_RE.search(body[:i]) is not None
            if is_dynamic:
                # Keep code, but blank NESTED '' data inside the dynamic SQL.
                k = i + 1
                while k < min(j, n):
                    if body[k] == "'" and k + 1 < min(j, n) and body[k + 1] == "'":
                        # A nested quote pair: blank until the closing pair.
                        out[k] = " "
                        out[k + 1] = " "
                        p = k + 2
                        while p < min(j, n):
                            if body[p] == "'" and p + 1 < min(j, n) and body[p + 1] == "'":
                                out[p] = " "
                                out[p + 1] = " "
                                k = p + 2
                                break
                            if out[p] != "\n":
                                out[p] = " "
                            p += 1
                        else:
                            k = p
                        continue
                    k += 1
            else:
                # Non-executable literal — blank contents (keep quotes).
                for k in range(i + 1, min(j, n)):
                    if out[k] != "\n":
                        out[k] = " "
            i = j + 1
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


# Canonical spellings for the built-in types whose common aliases / short forms
# would otherwise make the SAME function signature look like two. Postgres treats
# these as identical for function identity, so we normalize them to one form.
# (Keys and values are lowercase, whitespace-collapsed.)
_TYPE_ALIASES = {
    "int": "integer",
    "int4": "integer",
    "int2": "smallint",
    "int8": "bigint",
    "serial": "integer",  # domains over int, but callers overload on the int
    "bigserial": "bigint",
    "smallserial": "smallint",
    "bool": "boolean",
    "float4": "real",
    "float8": "double precision",
    "float": "double precision",
    "double": "double precision",  # bare "double" is only ever "double precision"
    "decimal": "numeric",
    "varchar": "character varying",
    "char": "character",
    "bpchar": "character",
    "varbit": "bit varying",
    "timetz": "time with time zone",
    "timestamptz": "timestamp with time zone",
}

# Multi-word canonical type names, longest first, so a param name preceding one
# (`p timestamp with time zone`) is separable from the bare type
# (`timestamp with time zone`). Used to decide whether a leading token is a
# parameter name or part of the type.
_MULTIWORD_TYPES = (
    "timestamp with time zone",
    "timestamp without time zone",
    "time with time zone",
    "time without time zone",
    "double precision",
    "character varying",
    "bit varying",
)


def _canonical_type(type_str):
    """Canonicalize a single type expression to a stable comparable form.

    Collapses whitespace, lowercases, drops typmods (`numeric(10,2)`->`numeric`,
    `varchar(255)`->`character varying`), normalizes array suffixes, and maps
    known aliases (`int4`->`integer`). Postgres ignores typmod and treats these
    aliases as one type for function identity, so this makes `f(int)` and
    `f(integer)` (and `f(varchar(10))` / `f(character varying)`) one key.
    """
    t = type_str.strip().lower()
    # Normalize array markers: `int[]`, `int array` -> canonical base + "[]".
    array = False
    t = re.sub(r"\s+array\b", "[]", t)
    while t.endswith("[]"):
        array = True
        t = t[:-2].strip()
    # Drop a trailing typmod like (255) or (10, 2) — not part of identity.
    t = re.sub(r"\s*\([^)]*\)\s*$", "", t).strip()
    t = re.sub(r"\s+", " ", t)
    t = _TYPE_ALIASES.get(t, t)
    if array:
        t += "[]"
    return t


def _extract_type(tokens):
    """Given the tokens of one argument (name/markers already stripped for
    IN/OUT/VARIADIC), return the canonical type, discarding a leading parameter
    name if present.

    A leading token is a parameter name only if what follows is itself a valid
    type. We detect a bare multi-word type (`double precision`) so we do NOT
    mistake its first word for a name, and otherwise fall back to: if there are
    >= 2 tokens, the first is the name. Single-token args are the type.
    """
    joined = " ".join(tokens).strip()
    low = re.sub(r"\s+", " ", joined.lower())
    # If the WHOLE thing is a bare multi-word type, there is no parameter name.
    base_for_match = re.sub(r"\s*\([^)]*\)\s*$", "", low).strip()
    base_for_match = re.sub(r"(\s*\[\s*\])+$|\s+array$", "", base_for_match).strip()
    for mw in _MULTIWORD_TYPES:
        if base_for_match == mw:
            return _canonical_type(joined)
    # If it ENDS with a multi-word type preceded by a name (`p double precision`),
    # strip the leading name tokens and keep the type.
    for mw in _MULTIWORD_TYPES:
        if base_for_match.endswith(" " + mw):
            return _canonical_type(mw)
    # Otherwise: >= 2 tokens -> first is a param name, rest is the (single-word,
    # possibly typmodded/array) type; 1 token -> it is the type.
    if len(tokens) >= 2:
        return _canonical_type(" ".join(tokens[1:]))
    return _canonical_type(joined)


def _normalize_signature(args_raw):
    """Reduce an argument list to a comparable ordered type signature.

    Drops parameter names, IN/OUT/VARIADIC markers and DEFAULTs, then
    CANONICALIZES each type (alias + typmod + whitespace + array) so the same
    Postgres function identity produces one key regardless of how the argument
    was spelled. Enough to distinguish overloads while collapsing spelling noise.
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
        p = p.rstrip(",").strip()
        # Drop typmod parens (`numeric(10, 2)` -> `numeric`) BEFORE tokenizing so
        # the space inside `(10, 2)` does not split one type into two tokens.
        # Typmod is not part of Postgres function identity.
        p = re.sub(r"\s*\([^)]*\)", "", p).strip()
        tokens = p.split()
        while tokens and tokens[0].upper() in ("IN", "OUT", "INOUT", "VARIADIC"):
            tokens.pop(0)
        if not tokens:
            continue
        sig.append(_extract_type(tokens))
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
# SECURITY INVOKER — the inverse of SECURITY DEFINER. An ALTER that switches a
# function to INVOKER takes it out of scope for this gate.
_SEC_INVOKER_RE = re.compile(r"\bSECURITY\s+INVOKER\b", re.IGNORECASE)
# ALTER FUNCTION forms that STOP the search_path from being the empty string:
#   * SET search_path = <nonempty>   (e.g. public) — a non-'' value;
#   * RESET search_path              — clears the per-function setting;
#   * RESET ALL                      — clears every per-function SET, incl.
#                                      search_path.
# These must clear a previously-tracked empty search_path so a later relaxation
# of a once-buggy function does not keep flagging it.
_SEARCH_PATH_SET_NONEMPTY_RE = re.compile(
    r"\bSET\s+\"?search_path\"?\s*(?:=|\bTO\b)\s*(?!''(?!\S))\S", re.IGNORECASE
)
_SEARCH_PATH_RESET_RE = re.compile(
    r"\bRESET\s+(?:\"?search_path\"?|ALL)\b", re.IGNORECASE
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
        # Blank non-executable string literals / block comments in the body so
        # data and diagnostics that merely mention a name are not matched as
        # references — but KEEP code inside EXECUTE '...' dynamic SQL, which runs
        # under the same empty search_path and fails the same way.
        fn.body = _prepare_body_for_scan(body)
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
    """Apply ALTER FUNCTION option changes to the tracked effective definition(s).

    Both DIRECTIONS matter for effective-schema semantics — an ALTER can pull a
    function INTO scope or OUT of it:

      * `SET search_path = ''`            -> search_path_empty = True
      * `SET search_path = <nonempty>`    -> search_path_empty = False
      * `RESET search_path` / `RESET ALL` -> search_path_empty = False
      * `SECURITY DEFINER`                -> security_definer = True
      * `SECURITY INVOKER`                -> security_definer = False

    If a later migration relaxes a once-buggy function (RESETs its search_path,
    points it at a real schema, or switches it to SECURITY INVOKER), the earlier
    True flags MUST be cleared — otherwise the audit reports a violation for a
    function that no longer runs in the failing configuration, blocking a valid
    fix.
    """
    schema = _normalize_schema(schema)
    name = name.lower()

    # Resolve each option to True / False / None (None = "not mentioned, leave
    # the tracked value alone").
    new_empty = None
    if _SEARCH_PATH_EMPTY_RE.search(opts) is not None:
        new_empty = True
    elif (
        _SEARCH_PATH_SET_NONEMPTY_RE.search(opts) is not None
        or _SEARCH_PATH_RESET_RE.search(opts) is not None
    ):
        new_empty = False

    new_secdef = None
    if _SECDEF_RE.search(opts) is not None:
        new_secdef = True
    elif _SEC_INVOKER_RE.search(opts) is not None:
        new_secdef = False

    if new_empty is None and new_secdef is None:
        return  # no option this gate tracks — e.g. ALTER ... OWNER TO / COST

    if args is not None:
        sig = _normalize_signature(args)
        targets = [(schema, name, sig)] if (schema, name, sig) in effective else []
    else:
        targets = [k for k in effective if k[0] == schema and k[1] == name]
    for k in targets:
        fn = effective[k]
        if new_empty is not None:
            fn.search_path_empty = new_empty
        if new_secdef is not None:
            fn.security_definer = new_secdef


def _apply_statements(effective, sql, path):
    """Apply every CREATE / DROP / ALTER FUNCTION statement in one migration to
    the effective-state map, in document order.

    Document order matters within a single file: a CREATE then a later ALTER in
    the same migration must both land. Non-code regions are blanked first so
    neither a `-- DROP FUNCTION ...` line-comment note NOR a block-commented
    `/* CREATE OR REPLACE FUNCTION ... */` (nor DDL text sitting inside a string
    literal) is mistaken for a real event. A commented-out qualified CREATE that
    was replayed could otherwise overwrite a real buggy definition with a clean
    one (or a commented DROP could remove it), making the gate pass while
    production still ships the bad function.
    """
    clean = _blank_noncode_for_statements(_strip_line_comments(sql))
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
