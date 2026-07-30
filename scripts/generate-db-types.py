#!/usr/bin/env python3
"""
Parse SomniBot SQL migrations and generate accurate TypeScript database types.
v2: Better JSONB handling, CHECK constraint extraction, manual overrides.
"""

import json
import os
import re
from collections import OrderedDict
from pathlib import Path

# Migrations live at <repo>/packages/supabase/migrations. Resolve relative to this
# script (scripts/generate-db-types.py) so the generator runs from a fresh checkout
# on any OS with no path patching. Override with SOMNIBOT_MIGRATIONS_DIR if needed.
_REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = Path(
    os.environ.get(
        "SOMNIBOT_MIGRATIONS_DIR",
        _REPO_ROOT / "packages" / "supabase" / "migrations",
    )
)


# Maps SQL types to TypeScript types
SQL_TO_TS = {
    "uuid": "string",
    "text": "string",
    "varchar": "string",
    "char": "string",
    "integer": "number",
    "int": "number",
    "smallint": "number",
    "bigint": "number",
    "numeric": "number",
    "decimal": "number",
    "real": "number",
    "double precision": "number",
    "boolean": "boolean",
    "bool": "boolean",
    "timestamptz": "string",
    "timestamp": "string",
    "date": "string",
    "time": "string",
    "jsonb": "Json",
    "json": "Json",
}


def parse_sql_type(sql_type_raw: str) -> tuple[str, bool]:
    """Parse SQL type to (ts_type, is_array)."""
    sql_type = sql_type_raw.strip().lower()
    
    is_array = False
    if sql_type.endswith("[]"):
        is_array = True
        sql_type = sql_type[:-2]
    
    sql_type = re.sub(r'\([^)]*\)', '', sql_type).strip()
    ts = SQL_TO_TS.get(sql_type, "unknown")
    return ts, is_array


class Column:
    def __init__(self, name, sql_type, nullable=True, default=None, check=None, default_raw=None):
        self.name = name
        self.sql_type = sql_type
        self.nullable = nullable
        self.default = default
        self.check = check
        self.default_raw = default_raw  # Raw default string from SQL
    
    def to_ts_type(self) -> str:
        ts_type, is_array = parse_sql_type(self.sql_type)
        
        # If there's a CHECK constraint with specific values, use a union type
        if self.check:
            union = " | ".join(f"'{v}'" for v in self.check)
            if is_array:
                result = f"({union})[]"
            else:
                result = union
        elif ts_type == "Json":
            # Refine JSONB based on default value
            if is_array:
                result = "Json[]"
            elif self.default_raw:
                dr = self.default_raw.strip().strip("'").strip('"')
                if dr == '[]' or dr == "'[]'::jsonb" or dr.endswith("'[]'"):
                    result = "Json[]"
                elif dr == '{}' or dr == "'{}'::jsonb" or dr.endswith("'{}'"):
                    result = "Record<string, Json>"
                else:
                    result = "Json"
            else:
                result = "Json"
        elif is_array:
            result = f"{ts_type}[]"
        else:
            result = ts_type
        
        if self.nullable:
            result += " | null"
        
        return result


class Table:
    def __init__(self, name):
        self.name = name
        self.columns: OrderedDict[str, Column] = OrderedDict()
        self.pk_columns: list[str] = []
    
    def add_column(self, col: Column):
        self.columns[col.name] = col
    
    def has_column(self, name: str) -> bool:
        return name in self.columns


tables: dict[str, Table] = {}


PG_IDENTIFIER_PATTERN = (
    r'(?:"(?:[^"]|"")*"|(?:[^\W\d]|_)(?:\w|\$)*)'
)
PG_IDENTIFIER_RE = re.compile(PG_IDENTIFIER_PATTERN)
PG_IDENTIFIER_CONTINUATION_RE = re.compile(r"(?:\w|\$)")


def is_pg_identifier_continuation(ch: str) -> bool:
    """Return whether one character can continue an unquoted identifier."""
    return PG_IDENTIFIER_CONTINUATION_RE.fullmatch(ch) is not None


def sql_quote_end(text: str, start: int) -> int:
    """Return the index after one SQL string or quoted identifier."""
    quote = text[start]
    backslash_escapes = (
        quote == "'"
        and start > 0
        and text[start - 1] in ("E", "e")
        and (
            start == 1
            or not is_pg_identifier_continuation(text[start - 2])
        )
    )
    i = start + 1
    while i < len(text):
        if backslash_escapes and text[i] == "\\":
            i = min(i + 2, len(text))
            continue
        if text[i] == quote:
            if i + 1 < len(text) and text[i + 1] == quote:
                i += 2
                continue
            return i + 1
        i += 1
    return len(text)


def parse_pg_identifier(raw: str) -> str:
    """Return the PostgreSQL name represented by one identifier token."""
    if raw.startswith('"'):
        return raw[1:-1].replace('""', '"')
    return raw.lower()


def match_pg_identifier(text: str, start: int = 0) -> tuple[str, int] | None:
    """Match one quoted or unquoted PostgreSQL identifier at ``start``."""
    match = PG_IDENTIFIER_RE.match(text, start)
    if match is None:
        return None
    return parse_pg_identifier(match.group(0)), match.end()


def match_qualified_pg_identifier(
    text: str, start: int = 0
) -> tuple[str | None, str, int] | None:
    """Match ``name`` or ``schema.name`` and preserve both name components."""
    first = match_pg_identifier(text, start)
    if first is None:
        return None

    first_name, end = first
    cursor = end
    while cursor < len(text) and text[cursor].isspace():
        cursor += 1
    if cursor >= len(text) or text[cursor] != ".":
        return None, first_name, end

    cursor += 1
    while cursor < len(text) and text[cursor].isspace():
        cursor += 1
    second = match_pg_identifier(text, cursor)
    if second is None:
        return None
    second_name, second_end = second
    return first_name, second_name, second_end


def split_top_level(text: str) -> list[str]:
    """Split comma-separated SQL clauses outside parens and quoted values."""
    parts = []
    current = []
    depth = 0
    i = 0

    while i < len(text):
        ch = text[i]
        if ch in ("'", '"'):
            quote_end = sql_quote_end(text, i)
            current.append(text[i:quote_end])
            i = quote_end
            continue
        if ch == "$":
            quote_end = sql_dollar_quote_end(text, i)
            if quote_end is not None:
                current.append(text[i:quote_end])
                i = quote_end
                continue

        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
            i += 1
            continue

        current.append(ch)
        i += 1

    if current and "".join(current).strip():
        parts.append("".join(current).strip())
    return parts


def parse_column_definition(name: str, definition: str) -> Column | None:
    """Parse the type and supported constraints following a column name."""
    tokens = definition.strip().rstrip(";").rstrip(",").split()
    if not tokens:
        return None

    type_end_keywords = {
        "PRIMARY",
        "NOT",
        "NULL",
        "DEFAULT",
        "REFERENCES",
        "CHECK",
        "UNIQUE",
        "CONSTRAINT",
        "ON",
        "GENERATED",
    }
    sql_type_parts = []
    constraint_start = 0

    for i, tok in enumerate(tokens):
        upper_tok = tok.upper().rstrip(",")
        if upper_tok in type_end_keywords:
            constraint_start = i
            break
        sql_type_parts.append(tok.rstrip(","))
        constraint_start = i + 1

    sql_type = " ".join(sql_type_parts).rstrip(",") or "text"
    constraints_str = " ".join(tokens[constraint_start:])
    nullable = "NOT NULL" not in constraints_str.upper()
    if "PRIMARY KEY" in constraints_str.upper():
        nullable = False

    default_val = parse_default(constraints_str)
    if default_val and default_val.upper() != "NULL":
        nullable = False

    check_vals = None
    check_match = re.search(r"CHECK\s*\(([^)]+)\)", definition, re.IGNORECASE)
    if check_match:
        check_vals = parse_check_values(check_match.group(0))

    return Column(name, sql_type, nullable, default_val, check_vals, default_val)


def parse_check_values(text: str) -> list[str] | None:
    """Extract values from CHECK (col IN ('a', 'b', 'c'))."""
    m = re.search(r"IN\s*\(([^)]+)\)", text, re.IGNORECASE)
    if m:
        vals = re.findall(r"'([^']+)'", m.group(1))
        return vals if vals else None
    return None


def find_inline_checks(full_text: str, col_name: str) -> list[str] | None:
    """Find CHECK constraints for a column in the full CREATE TABLE text."""
    # Pattern: CHECK (col_name IN ('a', 'b'))
    pattern = rf"CHECK\s*\(\s*{re.escape(col_name)}\s+IN\s*\(([^)]+)\)"
    m = re.search(pattern, full_text, re.IGNORECASE)
    if m:
        vals = re.findall(r"'([^']+)'", m.group(1))
        return vals if vals else None
    return None


def parse_default(constraints_str: str) -> str | None:
    """Extract DEFAULT value from constraints string."""
    m = re.search(
        r"DEFAULT\s+(.+?)(?:\s+(?:NOT|NULL|REFERENCES|CHECK|UNIQUE|ON|PRIMARY|CONSTRAINT)|\s*$)",
        constraints_str, re.IGNORECASE
    )
    if m:
        return m.group(1).strip().rstrip(',')
    return None


def parse_create_table(sql: str):
    """Parse a CREATE TABLE statement."""
    header = re.match(
        r"\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?",
        sql,
        re.IGNORECASE,
    )
    if header is None:
        return

    qualified_name = match_qualified_pg_identifier(sql, header.end())
    if qualified_name is None:
        return
    _, table_name, name_end = qualified_name

    opening_paren = re.match(r"\s*\(", sql[name_end:])
    if opening_paren is None:
        return
    if table_name in tables:
        return

    table = Table(table_name)

    # Extract body between outer parens
    paren_depth = 0
    start = name_end + opening_paren.end()
    end = len(sql)
    i = start
    while i < len(sql):
        ch = sql[i]
        if ch in ("'", '"'):
            i = sql_quote_end(sql, i)
            continue
        if ch == "$":
            quote_end = sql_dollar_quote_end(sql, i)
            if quote_end is not None:
                i = quote_end
                continue
        if ch == "(":
            paren_depth += 1
        elif ch == ")":
            if paren_depth == 0:
                end = i
                break
            paren_depth -= 1
        i += 1

    body = sql[start:end]
    full_text = sql  # Keep for CHECK lookups
    parts = split_top_level(body)

    pk_columns = []

    for part in parts:
        part = part.strip()
        if not part:
            continue

        upper = part.upper().lstrip()
        if upper.startswith(("PRIMARY KEY", "UNIQUE", "FOREIGN KEY", "CHECK (", "CONSTRAINT", "EXCLUDE USING")):
            if upper.startswith("PRIMARY KEY"):
                pk_match = re.search(r"PRIMARY\s+KEY\s*\(([^)]+)\)", part, re.IGNORECASE)
                if pk_match:
                    pk_columns = []
                    for raw_column in split_top_level(pk_match.group(1)):
                        identifier = match_pg_identifier(raw_column.strip())
                        if identifier is not None:
                            pk_columns.append(identifier[0])
            continue

        identifier = match_pg_identifier(part)
        if identifier is None:
            continue
        col_name, name_end = identifier
        if (
            not part.startswith('"')
            and col_name.upper()
            in ("PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT", "INDEX")
        ):
            continue

        definition = part[name_end:].strip()
        col = parse_column_definition(col_name, definition)
        if col is None:
            continue

        if "PRIMARY KEY" in definition.upper():
            pk_columns.append(col_name)

        # Also look for table-level CHECK referencing this column
        if not col.check:
            col.check = find_inline_checks(full_text, col_name)

        table.add_column(col)

    table.pk_columns = pk_columns
    tables[table_name] = table


def match_alter_table(sql: str) -> tuple[str | None, Table, str] | None:
    """Return the known target table and its comma-separated clause body."""
    header = re.match(
        r"\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?",
        sql,
        re.IGNORECASE,
    )
    if header is None:
        return None

    qualified_name = match_qualified_pg_identifier(sql, header.end())
    if qualified_name is None:
        return None
    schema_name, table_name, name_end = qualified_name
    table = tables.get(table_name)
    if table is None:
        return None
    return schema_name, table, sql[name_end:].strip().rstrip(";")


def match_clause_column(
    clause: str, prefix: str
) -> tuple[str, str] | None:
    """Match a column identifier after an ALTER subcommand prefix."""
    header = re.match(prefix, clause, re.IGNORECASE)
    if header is None:
        return None
    identifier = match_pg_identifier(clause, header.end())
    if identifier is None:
        return None
    name, name_end = identifier
    return name, clause[name_end:].strip()


def apply_alter_add_column(table: Table, clause: str):
    match = match_clause_column(
        clause,
        r"ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?",
    )
    if match is None:
        return
    col_name, definition = match
    if table.has_column(col_name):
        return
    column = parse_column_definition(col_name, definition)
    if column is not None:
        table.add_column(column)


def apply_alter_drop_column(table: Table, clause: str):
    match = match_clause_column(
        clause,
        r"DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?",
    )
    if match is None:
        return
    table.columns.pop(match[0], None)


def apply_alter_column_nullability(table: Table, clause: str):
    match = match_clause_column(clause, r"ALTER\s+COLUMN\s+")
    if match is None:
        return
    col_name, action = match
    nullability = re.match(r"(SET|DROP)\s+NOT\s+NULL\b", action, re.IGNORECASE)
    if nullability is None:
        return
    column = table.columns.get(col_name)
    if column is not None:
        column.nullable = nullability.group(1).upper() == "DROP"


def apply_alter_add_pk(table: Table, clause: str):
    match = re.match(
        r"ADD\s+PRIMARY\s+KEY\s*\((.*)\)\s*$",
        clause,
        re.IGNORECASE | re.DOTALL,
    )
    if match is None:
        return

    pk_columns = []
    for raw_column in split_top_level(match.group(1)):
        identifier = match_pg_identifier(raw_column.strip())
        if identifier is not None:
            pk_columns.append(identifier[0])
    table.pk_columns = pk_columns
    for col_name in pk_columns:
        column = table.columns.get(col_name)
        if column is not None:
            column.nullable = False


def process_alter_table(sql: str):
    """Apply supported ALTER TABLE subcommands in their source order."""
    matched = match_alter_table(sql)
    if matched is None:
        return
    _, table, body = matched

    for clause in split_top_level(body):
        if re.match(r"\s*ADD\s+COLUMN\b", clause, re.IGNORECASE):
            apply_alter_add_column(table, clause)
        elif re.match(r"\s*DROP\s+COLUMN\b", clause, re.IGNORECASE):
            apply_alter_drop_column(table, clause)
        elif re.match(r"\s*ALTER\s+COLUMN\b", clause, re.IGNORECASE):
            apply_alter_column_nullability(table, clause)
        elif re.match(r"\s*ADD\s+PRIMARY\s+KEY\b", clause, re.IGNORECASE):
            apply_alter_add_pk(table, clause)


def parse_drop_table(sql: str):
    """Parse DROP TABLE [IF EXISTS] [schema.]t so dropped tables disappear."""
    header = re.match(
        r"\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?",
        sql,
        re.IGNORECASE,
    )
    if header is None:
        return

    cursor = header.end()
    while cursor < len(sql):
        while cursor < len(sql) and sql[cursor].isspace():
            cursor += 1
        qualified_name = match_qualified_pg_identifier(sql, cursor)
        if qualified_name is None:
            return
        _, table_name, cursor = qualified_name
        tables.pop(table_name, None)

        while cursor < len(sql) and sql[cursor].isspace():
            cursor += 1
        if cursor >= len(sql) or sql[cursor] != ",":
            return
        cursor += 1


PLPGSQL_WORD_RE = re.compile(r"(?:[^\W\d]|_)(?:\w|\$)*")
DOLLAR_QUOTE_RE = re.compile(r"\$(?:(?:[^\W\d]|_)\w*)?\$")
PLPGSQL_LABEL_RE = re.compile(
    rf"<<\s*{PG_IDENTIFIER_PATTERN}\s*>>"
)


def match_dollar_quote_delimiter(
    text: str,
    start: int,
) -> re.Match | None:
    """Match a dollar delimiter only where it can begin a SQL token."""
    if (
        start > 0
        and is_pg_identifier_continuation(text[start - 1])
    ):
        return None
    return DOLLAR_QUOTE_RE.match(text, start)


def sql_dollar_quote_end(text: str, start: int) -> int | None:
    """Return the index after one dollar-quoted value, if one starts here."""
    delimiter = match_dollar_quote_delimiter(text, start)
    if delimiter is None:
        return None
    closing = text.find(delimiter.group(0), delimiter.end())
    if closing < 0:
        return len(text)
    return closing + len(delimiter.group(0))


def find_dollar_quote_delimiter(
    text: str,
    start: int = 0,
) -> re.Match | None:
    """Find the next dollar delimiter that starts at a token boundary."""
    for delimiter in DOLLAR_QUOTE_RE.finditer(text, start):
        if (
            delimiter.start() == 0
            or not is_pg_identifier_continuation(
                text[delimiter.start() - 1]
            )
        ):
            return delimiter
    return None


def split_sql_statements(content: str) -> list[str]:
    """Split migration SQL outside quoted values and comments."""
    statements = []
    current = []
    i = 0

    while i < len(content):
        ch = content[i]
        next_ch = content[i + 1] if i + 1 < len(content) else ""

        if ch in ("'", '"'):
            quote_end = sql_quote_end(content, i)
            current.append(content[i:quote_end])
            i = quote_end
            continue

        if ch == "$":
            quote_end = sql_dollar_quote_end(content, i)
            if quote_end is not None:
                current.append(content[i:quote_end])
                i = quote_end
                continue

        if ch == "-" and next_ch == "-":
            i += 2
            while i < len(content) and content[i] not in "\r\n":
                i += 1
            current.append("\n")
            if i < len(content) and content[i] == "\r":
                i += 1
            if i < len(content) and content[i] == "\n":
                i += 1
            continue

        if ch == "/" and next_ch == "*":
            depth = 1
            newline_count = 0
            i += 2
            while i < len(content) and depth:
                if content.startswith("/*", i):
                    depth += 1
                    i += 2
                elif content.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    if content[i] == "\n":
                        newline_count += 1
                    i += 1
            current.append("\n" * newline_count if newline_count else " ")
            continue

        if ch == ";":
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
            i += 1
            continue

        current.append(ch)
        i += 1

    statement = "".join(current).strip()
    if statement:
        statements.append(statement)
    return statements


def tokenize_plpgsql(body: str) -> list[tuple[str, str, int, int]]:
    """Tokenize procedural control words while skipping SQL quoted content."""
    tokens = []
    i = 0
    while i < len(body):
        ch = body[i]
        if body.startswith("--", i):
            newline = body.find("\n", i + 2)
            i = len(body) if newline < 0 else newline + 1
            continue
        if body.startswith("/*", i):
            depth = 1
            i += 2
            while i < len(body) and depth:
                if body.startswith("/*", i):
                    depth += 1
                    i += 2
                elif body.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            continue
        if ch in ("'", '"'):
            i = sql_quote_end(body, i)
            continue
        if ch == "$":
            quote_end = sql_dollar_quote_end(body, i)
            if quote_end is not None:
                i = quote_end
                continue
        if ch == "<":
            label = PLPGSQL_LABEL_RE.match(body, i)
            if label is not None:
                tokens.append(("label", label.group(0), i, label.end()))
                i = label.end()
                continue
        if ch == ";":
            tokens.append(("semicolon", ch, i, i + 1))
            i += 1
            continue

        word = PLPGSQL_WORD_RE.match(body, i)
        if word is not None:
            tokens.append(("word", word.group(0).upper(), i, word.end()))
            i = word.end()
            continue
        i += 1
    return tokens


def literal_plpgsql_condition(condition: str) -> bool | None:
    """Evaluate only syntactically literal TRUE/FALSE procedural conditions."""
    normalized = condition.strip()
    while normalized.startswith("(") and normalized.endswith(")"):
        normalized = normalized[1:-1].strip()
    if normalized.upper() == "TRUE":
        return True
    if normalized.upper() == "FALSE":
        return False
    return None


SCHEMA_COLUMN_GUARD_RE = re.compile(
    r"""
    \A\s*(?P<negated>NOT\s+)?EXISTS\s*\(
      \s*SELECT\s+1
      \s+FROM\s+information_schema\s*\.\s*columns
      \s+WHERE\s+(?P<where>.*)
    \)\s*\Z
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)
SCHEMA_COLUMN_PREDICATE_RE = re.compile(
    r"""
    (?:[A-Za-z_][A-Za-z0-9_$]*\s*\.\s*)?
    (?P<field>table_schema|table_name|column_name)
    \s*=\s*'(?P<value>(?:''|[^'])*)'
    """,
    re.IGNORECASE | re.VERBOSE,
)


def parse_schema_column_guard(
    condition: str,
) -> tuple[bool, dict[str, str]] | None:
    """Parse the narrow information_schema column-existence guard model."""
    guard = SCHEMA_COLUMN_GUARD_RE.fullmatch(condition)
    if guard is None:
        return None

    predicates = {}
    for raw_predicate in re.split(
        r"\s+AND\s+",
        guard.group("where").strip(),
        flags=re.IGNORECASE,
    ):
        predicate = SCHEMA_COLUMN_PREDICATE_RE.fullmatch(raw_predicate.strip())
        if predicate is None:
            return None
        field = predicate.group("field").lower()
        if field in predicates:
            return None
        predicates[field] = predicate.group("value").replace("''", "'")

    if not {"table_name", "column_name"}.issubset(predicates):
        return None
    return guard.group("negated") is not None, predicates


def match_schema_column_guard_target(
    condition: str,
    alter_sql: str,
) -> tuple[bool, Table, str, str] | None:
    """Match a schema guard to one supported ALTER COLUMN target."""
    guard = parse_schema_column_guard(condition)
    if guard is None:
        return None
    negated, predicates = guard

    matched = match_alter_table(alter_sql)
    if matched is None:
        return None
    schema_name, table, body = matched
    clauses = split_top_level(body)
    if len(clauses) != 1 or table.name != predicates["table_name"]:
        return None

    guard_schema = predicates.get("table_schema")
    if (
        (schema_name is None and guard_schema is not None)
        or (schema_name is not None and schema_name != guard_schema)
    ):
        return None

    clause = clauses[0]
    column_match = None
    for prefix in (
        r"ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?",
        r"DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?",
        r"ALTER\s+COLUMN\s+",
    ):
        column_match = match_clause_column(
            clause,
            prefix,
        )
        if column_match is not None:
            break
    if (
        column_match is None
        or column_match[0] != predicates["column_name"]
    ):
        return None
    return negated, table, predicates["column_name"], clause


def schema_guard_models_column_action(condition: str, alter_sql: str) -> bool:
    """Recognize the generator's narrow clean-chain ADD/DROP guard model."""
    target = match_schema_column_guard_target(condition, alter_sql)
    if target is None:
        return False
    negated, _, _, clause = target
    if negated:
        action = match_clause_column(
            clause,
            r"ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?",
        )
    else:
        action = match_clause_column(
            clause,
            r"DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?",
        )
    return action is not None


def schema_guard_model_truth(condition: str) -> bool | None:
    """Evaluate a column-existence guard against the current table model."""
    guard = parse_schema_column_guard(condition)
    if guard is None:
        return None
    negated, predicates = guard
    table = tables.get(predicates["table_name"])
    if table is None:
        return None
    exists = table.has_column(predicates["column_name"])
    return not exists if negated else exists


def capture_procedural_path(frames: list[dict]) -> list[dict]:
    """Freeze the candidate's branch while retaining alternate-branch flags."""
    path = []
    for frame in frames:
        if frame["kind"] == "block":
            continue
        entry = {"kind": frame["kind"]}
        if frame["kind"] == "if":
            entry.update(
                {
                    "frame": frame,
                    "branch": frame["branch"],
                    "branch_index": frame["branch_index"],
                }
            )
        path.append(entry)
    return path


def resolve_condition_truths(frame: dict, alter_sql: str) -> list[bool | None]:
    """Resolve an IF once at its source-order position for this target."""
    if frame["condition_truths"] is None:
        condition_truths = []
        for condition in frame["conditions"]:
            truth = literal_plpgsql_condition(condition)
            if truth is None:
                truth = schema_guard_model_truth(condition)
            condition_truths.append(truth)
        frame["condition_truths"] = condition_truths

    truths = []
    for condition, truth in zip(
        frame["conditions"],
        frame["condition_truths"],
    ):
        if (
            literal_plpgsql_condition(condition) is None
            and match_schema_column_guard_target(
                condition,
                alter_sql,
            )
            is None
        ):
            truth = None
        truths.append(truth)
    return truths


def procedural_path_allows_alter(path: list[dict], alter_sql: str) -> bool:
    """Require branch proof, except for the narrow clean-chain ADD/DROP model."""
    for entry in path:
        if entry["kind"] == "if":
            truths = resolve_condition_truths(
                entry["frame"],
                alter_sql,
            )
            branch = entry["branch"]
            branch_index = entry["branch_index"]
            if branch == "else":
                branch_selected = all(truth is False for truth in truths)
            else:
                branch_selected = (
                    branch_index is not None
                    and all(
                        truth is False
                        for truth in truths[:branch_index]
                    )
                    and truths[branch_index] is True
                )
            if branch_selected:
                continue
            if (
                branch == "then"
                and not entry["frame"]["has_alternate"]
                and schema_guard_models_column_action(
                    entry["frame"]["conditions"][0],
                    alter_sql,
                )
            ):
                continue
        return False
    return True


def pop_control_frame(frames: list[dict], kind: str):
    """Pop a completed procedural frame and any malformed nested frames."""
    for index in range(len(frames) - 1, -1, -1):
        if frames[index]["kind"] == kind:
            del frames[index:]
            return


def nearest_conditional_frame(frames: list[dict]) -> dict | None:
    """Return the innermost IF or CASE that can own ELSE/ELSIF."""
    for frame in reversed(frames):
        if frame["kind"] in ("if", "case"):
            return frame
    return None


def process_do_block(stmt: str):
    """Conservatively apply supported ALTERs inside a procedural DO block.

    ALTER COLUMN nullability is accepted only on direct, literal-selected, or
    matched schema-guard paths outside loops, CASE statements, and
    exception-bearing blocks. The existing clean-chain model for canonical
    ADD/DROP column guards remains only when the IF has no alternate branch.
    """
    delimiter = find_dollar_quote_delimiter(stmt)
    if delimiter is None:
        return
    delimiter_text = delimiter.group(0)
    body_end = stmt.rfind(delimiter_text)
    if body_end <= delimiter.end():
        return
    body = stmt[delimiter.end():body_end]
    tokens = tokenize_plpgsql(body)

    frames: list[dict] = []
    candidates = []
    at_statement_start = True
    i = 0

    while i < len(tokens):
        token_type, value, start, end = tokens[i]
        if token_type == "semicolon":
            at_statement_start = True
            i += 1
            continue
        if token_type == "label":
            i += 1
            continue
        if not at_statement_start:
            i += 1
            continue

        if value == "BEGIN":
            frames.append(
                {
                    "kind": "block",
                    "has_exception": False,
                    "in_exception": False,
                }
            )
            i += 1
            at_statement_start = True
            continue

        if value == "IF":
            then_index = i + 1
            while (
                then_index < len(tokens)
                and tokens[then_index][1] != "THEN"
            ):
                then_index += 1
            if then_index >= len(tokens):
                return
            condition = body[end:tokens[then_index][2]]
            frames.append(
                {
                    "kind": "if",
                    "conditions": [condition],
                    "condition_truths": None,
                    "branch": "then",
                    "branch_index": 0,
                    "has_alternate": False,
                }
            )
            i = then_index + 1
            at_statement_start = True
            continue

        if value == "ELSIF":
            then_index = i + 1
            while (
                then_index < len(tokens)
                and tokens[then_index][1] != "THEN"
            ):
                then_index += 1
            if then_index >= len(tokens):
                return
            condition = body[end:tokens[then_index][2]]
            conditional = nearest_conditional_frame(frames)
            if conditional is not None and conditional["kind"] == "if":
                conditional["conditions"].append(condition)
                conditional["branch"] = "elsif"
                conditional["branch_index"] = (
                    len(conditional["conditions"]) - 1
                )
                conditional["has_alternate"] = True
            i = then_index + 1
            at_statement_start = True
            continue

        if value == "ELSE":
            conditional = nearest_conditional_frame(frames)
            if conditional is not None and conditional["kind"] == "if":
                conditional["branch"] = "else"
                conditional["branch_index"] = None
                conditional["has_alternate"] = True
            i += 1
            at_statement_start = True
            continue

        if value in ("FOR", "FOREACH", "WHILE"):
            loop_index = i + 1
            while (
                loop_index < len(tokens)
                and tokens[loop_index][1] != "LOOP"
            ):
                loop_index += 1
            frames.append({"kind": "loop"})
            i = loop_index + 1
            at_statement_start = True
            continue

        if value == "LOOP":
            frames.append({"kind": "loop"})
            i += 1
            at_statement_start = True
            continue

        if value == "CASE":
            frames.append({"kind": "case"})
            i += 1
            at_statement_start = False
            continue

        if value == "EXCEPTION":
            for frame in reversed(frames):
                if frame["kind"] == "block":
                    frame["has_exception"] = True
                    frame["in_exception"] = True
                    break
            i += 1
            at_statement_start = True
            continue

        if value == "END":
            closing_kind = "block"
            next_index = i + 1
            if next_index < len(tokens):
                suffix = tokens[next_index][1]
                if suffix == "IF":
                    closing_kind = "if"
                    i = next_index
                elif suffix == "LOOP":
                    closing_kind = "loop"
                    i = next_index
                elif suffix == "CASE":
                    closing_kind = "case"
                    i = next_index
            pop_control_frame(frames, closing_kind)
            i += 1
            at_statement_start = False
            continue

        if value == "ALTER":
            semicolon_index = i + 1
            while (
                semicolon_index < len(tokens)
                and tokens[semicolon_index][0] != "semicolon"
            ):
                semicolon_index += 1
            if semicolon_index >= len(tokens):
                return
            alter_sql = body[start:tokens[semicolon_index][3]]
            control_path = capture_procedural_path(frames)
            block_frames = [
                frame for frame in frames if frame["kind"] == "block"
            ]
            in_exception_handler = any(
                frame["in_exception"] for frame in block_frames
            )
            candidates.append(
                (
                    alter_sql,
                    control_path,
                    in_exception_handler,
                    block_frames,
                )
            )
            i = semicolon_index + 1
            at_statement_start = True
            continue

        # Skip an unsupported procedural/SQL statement to its terminator. This
        # prevents CASE/IF words inside ordinary SQL from becoming control flow.
        while i < len(tokens) and tokens[i][0] != "semicolon":
            i += 1
        at_statement_start = True

    for alter_sql, control_path, in_exception_handler, block_frames in candidates:
        if (
            procedural_path_allows_alter(control_path, alter_sql)
            and not in_exception_handler
            and not any(frame["has_exception"] for frame in block_frames)
        ):
            process_alter_table(alter_sql)


def process_migration(filepath: Path):
    """Process a single migration file."""
    content = filepath.read_text(encoding="utf-8")

    for stmt in split_sql_statements(content):
        if not stmt:
            continue
        upper = stmt.upper().lstrip()
        if upper.startswith("CREATE TABLE"):
            parse_create_table(stmt)
        elif upper.startswith("DROP TABLE"):
            parse_drop_table(stmt)
        elif upper.startswith("ALTER TABLE"):
            process_alter_table(stmt)
        elif upper.startswith("DO") and re.search(
            r"\b(?:ADD|DROP|ALTER)\s+COLUMN\b",
            upper,
        ):
            # Idempotency-guarded column changes wrapped in DO $$ ... $$.
            process_do_block(stmt)


# ============================================================
# Manual type overrides for columns whose final type cannot be reconstructed
# from the initial CREATE TABLE alone (for example, later CHECK replacements).
# ============================================================
# These override the generated JSONB types with more specific types
# Format: (table_name, column_name) → ts_type
TYPE_OVERRIDES: dict[tuple[str, str], str] = {
    # guild_config
    ("guild_config", "interest_role_mapping"): "Record<string, string>",
    ("guild_config", "escalation_chain"): "EscalationStep[]",
    ("guild_config", "onboarding_config"): "Record<string, unknown> | null",
    # ticket_panels
    ("ticket_panels", "panel_message"): "Record<string, unknown>",
    ("ticket_panels", "ticket_types"): "TicketTypeConfig[]",
    ("ticket_panels", "forum_config"): "Record<string, unknown> | null",
    # automations
    ("automations", "trigger_config"): "Record<string, unknown>",
    ("automations", "conditions"): "Record<string, unknown>[]",
    ("automations", "actions"): "Record<string, unknown>[]",
    # automation_executions
    ("automation_executions", "errors"): "Record<string, unknown>[]",
    # custom_commands
    ("custom_commands", "actions"): "Record<string, unknown>[]",
    # embed_configs
    ("embed_configs", "fields"): "Record<string, unknown>[]",
    ("embed_configs", "components_v2_data"): "Record<string, unknown> | null",
    # guild_desired_state
    ("guild_desired_state", "roles"): "Record<string, unknown>[]",
    ("guild_desired_state", "channels"): "Record<string, unknown>[]",
    ("guild_desired_state", "permission_map"): "Record<string, unknown>",
    ("guild_desired_state", "drift_details"): "Record<string, unknown> | null",
    # guild_live_state
    ("guild_live_state", "roles"): "Record<string, unknown>[]",
    ("guild_live_state", "channels"): "Record<string, unknown>[]",
    ("guild_live_state", "categories"): "Record<string, unknown>[]",
    ("guild_live_state", "onboarding_prompts"): "Record<string, unknown>[]",
    # bot_diagnostics
    ("bot_diagnostics", "lavalink_nodes"): "Record<string, unknown>[]",
    ("bot_diagnostics", "data"): "Record<string, unknown> | null",
    # server_templates
    ("server_templates", "template_data"): "Record<string, unknown>",
    # role_templates
    ("role_templates", "permission_details"): "Record<string, unknown>",
    # channel_templates
    ("channel_templates", "overrides"): "Record<string, unknown>",
    # products
    ("products", "metadata"): "Record<string, unknown>",
    # audit_logs
    ("audit_logs", "details"): "Record<string, unknown>",
    ("audit_logs", "before_state"): "Record<string, unknown> | null",
    ("audit_logs", "after_state"): "Record<string, unknown> | null",
    # webhook_events
    ("webhook_events", "payload"): "Record<string, unknown>",
    # bot_action_queue
    ("bot_action_queue", "payload"): "Record<string, unknown>",
    ("bot_action_queue", "result"): "Record<string, unknown> | null",
    ("bot_action_queue", "status"): "'staged' | 'pending' | 'processing' | 'completed' | 'failed'",
    # commerce_fulfillment_outward_intents — CHECK widened later in
    # 20260727041000_checkout_double_charge_rails.sql after the table's initial
    # CREATE statement. The generator currently needs an explicit override for
    # replacement CHECK constraints.
    ("commerce_fulfillment_outward_intents", "state"): (
        "'sending' | 'sent' | 'uncertain' | 'superseded'"
    ),
    # orders
    ("orders", "status"): "'pending' | 'completed' | 'refunded' | 'disputed' | 'cancelled' | 'pending_review'",
    # license_validations — CHECK widened by
    # 20260727030000_license_validations_result_undetermined.sql to cover the
    # entitlement statuses the validate route already logs verbatim plus the
    # service-fault outcomes ('unavailable' = status could not be determined,
    # which is deliberately NOT the same as 'revoked') and the terminal
    # per-device `session_invalidated` verdict and the fail-closed outcome for
    # a seat-tracked request that omitted its device fingerprint.
    ("license_validations", "result"): (
        "'valid' | 'invalid_key' | 'expired' | 'suspended' | 'revoked'"
        " | 'over_device_limit' | 'product_mismatch' | 'cancelled' | 'pending'"
        " | 'grace_period' | 'unavailable' | 'rate_limited' | 'session_invalidated'"
        " | 'device_fingerprint_required'"
    ),
    ("orders", "temporary_role_grants_snapshot"): "Array<{ role_id: string; duration_seconds: number }>",
    # fraud_signals
    ("fraud_signals", "evidence"): "Record<string, unknown>",
    # fraud_rules
    ("fraud_rules", "config"): "Record<string, unknown>",
    # incidents / incident_events
    ("incident_events", "metadata"): "Record<string, unknown>",
    ("incident_events", "details"): "Record<string, unknown> | null",
    # dead_letter_queue
    ("dead_letter_queue", "payload"): "Record<string, unknown>",
    # workflow_events
    ("workflow_events", "payload"): "Record<string, unknown>",
    ("workflow_events", "input_data"): "Record<string, unknown> | null",
    ("workflow_events", "output_data"): "Record<string, unknown> | null",
    ("workflow_events", "result"): "'success' | 'error' | 'skipped' | 'pending' | null",
    # admin_changes
    ("admin_changes", "before_state"): "Record<string, unknown> | null",
    ("admin_changes", "after_state"): "Record<string, unknown> | null",
    ("admin_changes", "undo_payload"): "Record<string, unknown> | null",
    # dashboard_roles
    ("dashboard_roles", "permissions"): "DashboardPermission[]",
    # alerts
    ("alerts", "metadata"): "Record<string, unknown>",
    ("alerts", "details"): "Record<string, unknown> | null",
    # sync_actions
    ("sync_actions", "details"): "Record<string, unknown> | null",
    # stats_channels
    ("stats_channels", "stat_config"): "Record<string, unknown>",
    # product_license_config
    ("product_license_config", "watermark_config"): "Record<string, unknown> | null",
    # automod_rules
    ("automod_rules", "config"): "AutoModRuleConfig",
    # ticket_metrics (nothing to override)
    # reconciliation_runs
    ("reconciliation_runs", "findings"): "Record<string, unknown>",
    ("reconciliation_runs", "fixes_applied"): "Record<string, unknown>",
}

# Tables to skip
SKIP_TABLES = {"schema_migrations", "product-files", "reconciliation_runs"}

# Table → interface name mapping
TABLE_TO_DB_NAME = {
    "users": "DbUser",
    "guild": "DbGuild",
    "guild_config": "DbGuildConfig",
    "members": "DbMember",
    "role_templates": "DbRoleTemplate",
    "channel_templates": "DbChannelTemplate",
    "server_templates": "DbServerTemplate",
    "guild_desired_state": "DbGuildDesiredState",
    "discord_id_map": "DbDiscordIdMap",
    "reaction_roles": "DbReactionRole",
    "automod_rules": "DbAutomodRule",
    "infractions": "DbInfraction",
    "ticket_panels": "DbTicketPanel",
    "tickets": "DbTicket",
    "ticket_transcripts": "DbTicketTranscript",
    "automations": "DbAutomation",
    "automation_executions": "DbAutomationExecution",
    "custom_commands": "DbCustomCommand",
    "embed_configs": "DbEmbedConfig",
    "member_levels": "DbMemberLevel",
    "level_rewards": "DbLevelReward",
    "xp_multipliers": "DbXpMultiplier",
    "member_rank_settings": "DbMemberRankSettings",
    "temp_channel_hubs": "DbTempChannelHub",
    "active_temp_channels": "DbActiveTempChannel",
    "stats_channels": "DbStatsChannel",
    "scheduled_messages": "DbScheduledMessage",
    "giveaways": "DbGiveaway",
    "products": "DbProduct",
    "product_files": "DbProductFile",
    "plans": "DbPlan",
    "customers": "DbCustomer",
    "promotions": "DbPromotion",
    "orders": "DbOrder",
    "license_keys": "DbLicenseKey",
    "entitlements": "DbEntitlement",
    "product_license_config": "DbProductLicenseConfig",
    "license_sessions": "DbLicenseSession",
    "license_validations": "DbLicenseValidation",
    "payments": "DbPayment",
    "audit_logs": "DbAuditLog",
    "webhook_events": "DbWebhookEvent",
    "instance_settings": "DbInstanceSettings",
    "bot_diagnostics": "DbBotDiagnostics",
    "guild_live_state": "DbGuildLiveState",
    "bot_action_queue": "DbBotActionQueue",
    "dashboard_roles": "DbDashboardRole",
    "dashboard_user_roles": "DbDashboardUserRole",
    "portal_sessions": "DbPortalSession",
    "fraud_signals": "DbFraudSignal",
    "fraud_rules": "DbFraudRule",
    "incidents": "DbIncident",
    "incident_events": "DbIncidentEvent",
    "dead_letter_queue": "DbDeadLetterItem",
    "workflow_events": "DbWorkflowEvent",
    "admin_changes": "DbAdminChange",
    "alerts": "DbAlert",
    "message_reports": "DbMessageReport",
    "sync_actions": "DbSyncAction",
    "ticket_metrics": "DbTicketMetric",
}


TS_INTERFACE_IDENTIFIER_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")


def table_interface_name(table_name: str) -> str:
    """Return a deterministic valid TypeScript interface name for a table."""
    interface_name = TABLE_TO_DB_NAME.get(table_name)
    if interface_name is None:
        words = re.findall(r"[A-Za-z0-9]+", table_name)
        suffix = "".join(word[:1].upper() + word[1:] for word in words)
        interface_name = "Db" + (suffix or "Table")
    if TS_INTERFACE_IDENTIFIER_RE.fullmatch(interface_name) is None:
        raise ValueError(
            f"invalid TypeScript interface name {interface_name!r} "
            f"for table {table_name!r}"
        )
    return interface_name


def build_table_interface_names(table_names: list[str]) -> dict[str, str]:
    """Build a one-to-one table/interface mapping or fail on collisions."""
    interface_names = {}
    owners = {}
    for table_name in sorted(table_names):
        interface_name = table_interface_name(table_name)
        previous_table = owners.get(interface_name)
        if previous_table is not None and previous_table != table_name:
            raise ValueError(
                "TypeScript interface name collision: "
                f"{previous_table!r} and {table_name!r} both map to "
                f"{interface_name!r}"
            )
        owners[interface_name] = table_name
        interface_names[table_name] = interface_name
    return interface_names


def generate_row_interface(table: Table, name: str) -> str:
    """Generate a TypeScript interface for a table's Row type."""
    lines = [f"export interface {name} {{"]
    for col in table.columns.values():
        override_key = (table.name, col.name)
        if override_key in TYPE_OVERRIDES:
            ts_type = TYPE_OVERRIDES[override_key]
        else:
            ts_type = col.to_ts_type()
        property_name = col.name
        if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", property_name) is None:
            property_name = json.dumps(property_name, ensure_ascii=False)
        lines.append(f"  {property_name}: {ts_type};")
    lines.append("}")
    return "\n".join(lines)


CATEGORIES = OrderedDict([
    ("Core", ["users", "guild", "guild_config", "instance_settings"]),
    ("Members", ["members"]),
    ("Templates & Server Structure", [
        "role_templates", "channel_templates", "server_templates",
        "guild_desired_state", "discord_id_map", "guild_live_state",
    ]),
    ("Reaction Roles", ["reaction_roles"]),
    ("Moderation", ["automod_rules", "infractions", "message_reports"]),
    ("Ticketing", ["ticket_panels", "tickets", "ticket_transcripts", "ticket_metrics"]),
    ("Automations", ["automations", "automation_executions", "custom_commands"]),
    ("Embeds", ["embed_configs"]),
    ("Levels & XP", ["member_levels", "level_rewards", "xp_multipliers", "member_rank_settings"]),
    ("Temp Channels & Stats", ["temp_channel_hubs", "active_temp_channels", "stats_channels"]),
    ("Scheduled Messages", ["scheduled_messages"]),
    ("Commerce — Products", ["products", "product_files", "plans"]),
    ("Commerce — Customers", ["customers", "promotions"]),
    ("Commerce — Orders", ["orders"]),
    ("Commerce — Licensing", ["license_keys", "entitlements", "product_license_config", "license_sessions", "license_validations"]),
    ("Commerce — Payments", ["payments"]),
    ("Commerce — Giveaways", ["giveaways"]),
    ("Audit & Operations", ["audit_logs", "webhook_events", "bot_diagnostics", "bot_action_queue", "alerts"]),
    ("Dashboard RBAC", ["dashboard_roles", "dashboard_user_roles"]),
    ("Customer Portal", ["portal_sessions"]),
    ("Fraud Controls", ["fraud_signals", "fraud_rules"]),
    ("Incidents", ["incidents", "incident_events"]),
    ("DLQ & Workflows", ["dead_letter_queue", "workflow_events"]),
    ("Admin Changes", ["admin_changes"]),
    ("Sync", ["sync_actions"]),
])


HELPER_TYPES = '''// ============================================================
// Helper Types & Constants (manually maintained)
// ============================================================

// Generic JSON type for JSONB columns
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// Two-phase privacy RPC results. Both purge functions return JSONB so callers
// must inspect purge_status instead of treating a successful RPC as completion.
export type PrivacyPurgeStatus = 'pending_role_cleanup' | 'completed';

export interface PrivacyPurgeRpcResult {
  [key: string]: Json;
  purge_status: PrivacyPurgeStatus;
  pending_role_cleanup_count: number;
}

export type PurgeMemberDataRpcResult = PrivacyPurgeRpcResult;
export type PurgeGuildDataRpcResult = PrivacyPurgeRpcResult;

// Auto-Mod Rule Config Types
export type AutoModRuleType =
  | 'word_filter'
  | 'link_filter'
  | 'invite_filter'
  | 'spam_filter'
  | 'duplicate_filter'
  | 'caps_filter'
  | 'mention_spam'
  | 'newline_spam';

export type AutoModAction = 'delete' | 'warn' | 'mute' | 'kick' | 'ban';

export interface WordFilterConfig {
  words: string[];
  matchMode: 'exact' | 'wildcard' | 'regex';
  caseSensitive: boolean;
}

export interface LinkFilterConfig {
  mode: 'whitelist' | 'blacklist';
  domains: string[];
}

export interface InviteFilterConfig {
  allowOwnServer: boolean;
}

export interface SpamFilterConfig {
  maxMessages: number;
  intervalSeconds: number;
}

export interface DuplicateFilterConfig {
  threshold: number;
  intervalSeconds: number;
}

export interface CapsFilterConfig {
  maxPercent: number;
  minLength: number;
}

export interface MentionSpamConfig {
  maxMentions: number;
}

export interface NewlineSpamConfig {
  maxNewlines: number;
}

export type AutoModRuleConfig =
  | WordFilterConfig
  | LinkFilterConfig
  | InviteFilterConfig
  | SpamFilterConfig
  | DuplicateFilterConfig
  | CapsFilterConfig
  | MentionSpamConfig
  | NewlineSpamConfig;

// Infraction Types
export type InfractionType = 'warn' | 'mute' | 'kick' | 'ban';

// Escalation Chain
export interface EscalationStep {
  threshold: number;
  action: 'warn' | 'mute' | 'kick' | 'ban';
  durationMinutes?: number;
  dmMember: boolean;
}

export const DEFAULT_ESCALATION_CHAIN: EscalationStep[] = [
  { threshold: 1, action: 'warn', dmMember: true },
  { threshold: 2, action: 'warn', dmMember: true },
  { threshold: 3, action: 'mute', durationMinutes: 60, dmMember: true },
  { threshold: 4, action: 'mute', durationMinutes: 1440, dmMember: true },
  { threshold: 5, action: 'kick', dmMember: true },
  { threshold: 6, action: 'ban', dmMember: true },
];

// Ticket Type Config
export interface TicketTypeConfig {
  id: string;
  label: string;
  emoji: string;
  color: 'blue' | 'grey' | 'green' | 'red';
  description?: string;
  categoryOverride?: string;
  managerRoleOverride?: string[];
  introMessageOverride?: string;
}

// Dashboard Permissions
export type DashboardPermission =
  | 'dashboard.full_access'
  | 'dashboard.view_analytics'
  | 'dashboard.manage_store'
  | 'dashboard.manage_products'
  | 'dashboard.manage_orders'
  | 'dashboard.manage_customers'
  | 'dashboard.manage_licenses'
  | 'dashboard.manage_moderation'
  | 'dashboard.manage_tickets'
  | 'dashboard.manage_automations'
  | 'dashboard.manage_server'
  | 'dashboard.manage_roles'
  | 'dashboard.manage_channels'
  | 'dashboard.manage_team'
  | 'dashboard.view_audit'
  | 'dashboard.view_diagnostics'
  | 'dashboard.manage_incidents'
  | 'dashboard.view_fraud'
  | 'dashboard.manage_fraud'
  | 'dashboard.view_workflows'
  | 'dashboard.manage_workflows'
  | 'dashboard.undo_changes';

// Fraud Types
export type FraudSignalType =
  | 'velocity'
  | 'device_abuse'
  | 'chargeback'
  | 'ip_mismatch'
  | 'key_sharing'
  | 'payment_pattern';

export type FraudSeverity = 'low' | 'medium' | 'high' | 'critical';
export type FraudSignalStatus = 'open' | 'investigating' | 'confirmed' | 'dismissed' | 'auto_resolved';

export type FraudRuleType =
  | 'velocity_limit'
  | 'device_limit'
  | 'ip_block'
  | 'amount_threshold'
  | 'pattern_match';

// Incident Types
export type IncidentSeverity = 'info' | 'warning' | 'critical' | 'outage';
export type IncidentStatus = 'open' | 'investigating' | 'identified' | 'monitoring' | 'resolved';

// DLQ Types
export type DLQStatus = 'pending' | 'retrying' | 'exhausted' | 'resolved' | 'discarded';

// Admin Change Types
export type BlastRadius = 'low' | 'medium' | 'high' | 'critical';
'''


def build_types() -> str:
    """Parse all migrations and return the generated TypeScript source as a string."""
    tables.clear()
    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    print(f"Processing {len(migration_files)} migration files...")

    for mf in migration_files:
        process_migration(mf)

    print(f"Found {len(tables)} tables")

    # Build output
    lines = []
    lines.append("/**")
    lines.append(" * AUTO-GENERATED SNAPSHOT of the DB schema derived from SQL migrations.")
    lines.append(" * DO NOT EDIT BY HAND — run `python scripts/generate-db-types.py` to refresh.")
    lines.append(f" * Source: {len(migration_files)} migration files in packages/supabase/migrations/")
    lines.append(" *")
    lines.append(" * This snapshot is a DRIFT TRIPWIRE, not the app's type source of truth.")
    lines.append(" * Application code imports the hand-maintained packages/shared/src/types/")
    lines.append(" * database.ts. CI regenerates this file and fails if it differs from the")
    lines.append(" * committed copy, forcing a review whenever a migration changes the schema.")
    lines.append(" * The generator is a best-effort SQL parser; see the RUNBOOK for its known")
    lines.append(" * limitations (no ALTER COLUMN type tracking, no constraint")
    lines.append(" * re-derivation), which is why it is a tripwire rather than the source type.")
    lines.append(" */")
    lines.append("")

    # Helper types first (Json, etc.) since row types reference them
    lines.append(HELPER_TYPES)
    lines.append("")
    lines.append("// ============================================================")
    lines.append("// Row Types — auto-generated from SQL migrations")
    lines.append("// ============================================================")
    lines.append("")

    categorized = set()
    for tbl_list in CATEGORIES.values():
        categorized.update(tbl_list)

    included_tables = [
        table_name for table_name in tables if table_name not in SKIP_TABLES
    ]
    interface_names = build_table_interface_names(included_tables)
    uncategorized = sorted(
        table_name
        for table_name in included_tables
        if table_name not in categorized
    )
    categories = list(CATEGORIES.items())
    if uncategorized:
        categories.append(("Other", uncategorized))

    for cat_name, tbl_names in categories:
        cat_tables = [(n, tables[n]) for n in tbl_names if n in tables and n not in SKIP_TABLES]
        if not cat_tables:
            continue

        lines.append(f"// — {cat_name} —")
        lines.append("")

        for tbl_name, tbl in cat_tables:
            db_name = interface_names[tbl_name]
            lines.append(generate_row_interface(tbl, db_name))
            lines.append("")

    # Normalise trailing whitespace and guarantee a single trailing newline so the
    # output is stable across platforms and safe to byte-compare in CI.
    return "\n".join(lines).rstrip("\n") + "\n"


# Default snapshot location: a dedicated generated file, NEVER the hand-maintained
# database.ts (which application code imports and which the generator cannot fully
# reproduce). Overridable with --out for local experimentation.
DEFAULT_OUT_PATH = (
    MIGRATIONS_DIR.parent.parent / "shared" / "src" / "types" / "database.generated.ts"
)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Generate the DB-schema drift snapshot from SQL migrations."
    )
    parser.add_argument(
        "--out", type=Path, default=DEFAULT_OUT_PATH,
        help="Path to write the generated snapshot (default: database.generated.ts).",
    )
    parser.add_argument(
        "--check", action="store_true",
        help="Do not write; exit non-zero if the committed snapshot differs from a "
             "fresh generation (used by CI to fail on drift).",
    )
    args = parser.parse_args(argv)

    result = build_types()

    if args.check:
        # Compare newline-agnostically: the committed snapshot is stored with LF
        # (.gitattributes enforces this), but read it robustly so a stray CRLF
        # checkout on Windows does not produce a false drift.
        existing = ""
        if args.out.exists():
            existing = args.out.read_text(encoding="utf-8").replace("\r\n", "\n")
        if existing == result:
            print(f"OK: {args.out} is up to date with migrations (no drift).")
            return 0
        import difflib
        diff = "".join(
            difflib.unified_diff(
                existing.splitlines(keepends=True),
                result.splitlines(keepends=True),
                fromfile=f"{args.out} (committed)",
                tofile=f"{args.out} (regenerated)",
            )
        )
        print("DRIFT DETECTED: committed DB-type snapshot is stale.")
        print("Run `python scripts/generate-db-types.py` and commit the result.")
        print()
        print(diff[:8000])
        return 1

    # Always write LF so the committed snapshot is identical on every OS and byte-
    # compares cleanly against a Linux-CI regeneration.
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(result)
    print(f"Generated snapshot written to {args.out}")
    print(f"Total lines: {len(result.splitlines())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
