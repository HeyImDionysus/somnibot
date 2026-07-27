#!/usr/bin/env python3
"""
Parse SomniBot SQL migrations and generate accurate TypeScript database types.
v2: Better JSONB handling, CHECK constraint extraction, manual overrides.
"""

import re
import os
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
    m = re.match(
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\"?\w+\"?\.)?(?:\"?(\w+)\"?)\s*\(",
        sql, re.IGNORECASE
    )
    if not m:
        return

    table_name = m.group(1)
    if table_name in tables:
        return
    
    table = Table(table_name)
    
    # Extract body between outer parens
    paren_depth = 0
    start = sql.index('(') + 1
    end = len(sql)
    for i in range(start, len(sql)):
        if sql[i] == '(':
            paren_depth += 1
        elif sql[i] == ')':
            if paren_depth == 0:
                end = i
                break
            paren_depth -= 1
    
    body = sql[start:end]
    full_text = sql  # Keep for CHECK lookups
    
    # Split by top-level commas
    parts = []
    current = ""
    depth = 0
    for ch in body:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        elif ch == ',' and depth == 0:
            parts.append(current.strip())
            current = ""
            continue
        current += ch
    if current.strip():
        parts.append(current.strip())
    
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
                    pk_columns = [c.strip().strip('"') for c in pk_match.group(1).split(",")]
            continue
        
        tokens = part.split()
        if len(tokens) < 2:
            continue
        
        col_name = tokens[0].strip('"')
        if col_name.upper() in ("PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT", "INDEX"):
            continue
        
        # Find type vs constraints boundary
        type_end_keywords = {"PRIMARY", "NOT", "NULL", "DEFAULT", "REFERENCES", "CHECK", "UNIQUE", "CONSTRAINT", "ON", "GENERATED"}
        sql_type_parts = []
        constraint_start = 1
        
        for i, tok in enumerate(tokens[1:], 1):
            upper_tok = tok.upper().rstrip(',')
            if upper_tok in type_end_keywords:
                constraint_start = i
                break
            sql_type_parts.append(tok)
            constraint_start = i + 1
        
        sql_type = " ".join(sql_type_parts).rstrip(',')
        if not sql_type:
            sql_type = "text"
        
        constraints_str = " ".join(tokens[constraint_start:])
        
        nullable = True
        if "NOT NULL" in constraints_str.upper():
            nullable = False
        if "PRIMARY KEY" in constraints_str.upper():
            nullable = False
            pk_columns.append(col_name)
        
        default_val = parse_default(constraints_str)
        if default_val and default_val.upper() not in ("NULL",):
            nullable = False
        
        # Check constraint from the column definition
        check_vals = None
        check_match = re.search(r"CHECK\s*\(([^)]+)\)", part, re.IGNORECASE)
        if check_match:
            check_vals = parse_check_values(check_match.group(0))
        
        # Also look for table-level CHECK referencing this column
        if not check_vals:
            check_vals = find_inline_checks(full_text, col_name)
        
        col = Column(col_name, sql_type, nullable, default_val, check_vals, default_val)
        table.add_column(col)
    
    table.pk_columns = pk_columns
    tables[table_name] = table


def parse_alter_add_column(sql: str):
    """Parse ALTER TABLE ... ADD COLUMN [IF NOT EXISTS] ...
    
    Handles multi-column ALTER TABLE statements like:
      ALTER TABLE t ADD COLUMN IF NOT EXISTS a TEXT, ADD COLUMN IF NOT EXISTS b INT;
    """
    # Extract table name (tolerating an optional schema qualifier, e.g. public.foo)
    m = re.match(r"ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:\"?\w+\"?\.)?(?:\"?(\w+)\"?)\s+",
                 sql, re.IGNORECASE)
    if not m:
        return

    table_name = m.group(1)
    if table_name not in tables:
        return

    table = tables[table_name]

    # Strip the leading "ALTER TABLE [schema.]<name>" so only the clause list remains.
    body = re.sub(r"^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:\"?\w+\"?\.)?(?:\"?\w+\"?)\s+",
                  "", sql, count=1, flags=re.IGNORECASE).rstrip().rstrip(';')

    # Split into top-level clauses on commas that are NOT inside parentheses.
    # This keeps commas inside CHECK (col IN ('a','b')) and type precision like
    # NUMERIC(3,1) attached to their owning column instead of splitting a clause.
    clauses = []
    current = ""
    depth = 0
    for ch in body:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        elif ch == ',' and depth == 0:
            clauses.append(current.strip())
            current = ""
            continue
        current += ch
    if current.strip():
        clauses.append(current.strip())

    # Only ADD COLUMN clauses are relevant here; ignore ADD CONSTRAINT / ALTER
    # COLUMN / DROP etc. which are handled elsewhere (or intentionally not).
    add_col_re = re.compile(r"^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+(.+)$",
                            re.IGNORECASE | re.DOTALL)
    for clause in clauses:
        col_match = add_col_re.match(clause)
        if not col_match:
            continue
        col_name = col_match.group(1).strip('"')
        rest = col_match.group(2).strip().rstrip(';').rstrip(',')

        if table.has_column(col_name):
            continue

        tokens = rest.split()
        if not tokens:
            continue
        
        type_end_keywords = {"PRIMARY", "NOT", "NULL", "DEFAULT", "REFERENCES", "CHECK", "UNIQUE", "CONSTRAINT", "ON", "GENERATED"}
        sql_type_parts = []
        constraint_start = 0
        
        for i, tok in enumerate(tokens):
            upper_tok = tok.upper().rstrip(',')
            if upper_tok in type_end_keywords:
                constraint_start = i
                break
            sql_type_parts.append(tok.rstrip(','))
            constraint_start = i + 1
        
        sql_type = " ".join(sql_type_parts).rstrip(',')
        if not sql_type:
            sql_type = "text"
        
        constraints_str = " ".join(tokens[constraint_start:])
        
        nullable = True
        if "NOT NULL" in constraints_str.upper():
            nullable = False
        
        default_val = parse_default(constraints_str)
        if default_val and default_val.upper() not in ("NULL",):
            nullable = False
        
        check_vals = None
        check_match = re.search(r"CHECK\s*\(([^)]+)\)", rest, re.IGNORECASE)
        if check_match:
            check_vals = parse_check_values(check_match.group(0))
        
        col = Column(col_name, sql_type, nullable, default_val, check_vals, default_val)
        table.add_column(col)


def parse_alter_add_pk(sql: str):
    """Parse ALTER TABLE ... ADD PRIMARY KEY (col1, col2)."""
    m = re.match(
        r"ALTER\s+TABLE\s+(?:\"?\w+\"?\.)?(?:\"?(\w+)\"?)\s+ADD\s+PRIMARY\s+KEY\s*\(([^)]+)\)",
        sql, re.IGNORECASE
    )
    if not m:
        return
    
    table_name = m.group(1)
    pk_cols = [c.strip().strip('"') for c in m.group(2).split(",")]
    
    if table_name in tables:
        tables[table_name].pk_columns = pk_cols
        for col_name in pk_cols:
            if col_name in tables[table_name].columns:
                tables[table_name].columns[col_name].nullable = False


def parse_alter_drop_column(sql: str):
    """Parse ALTER TABLE [schema.]t DROP COLUMN [IF EXISTS] col [, DROP COLUMN ...].

    Without this, a column added by an early CREATE TABLE / ADD COLUMN and later
    removed would linger as a phantom in the generated types (drift vs reality).
    """
    m = re.match(
        r"ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:\"?\w+\"?\.)?(?:\"?(\w+)\"?)\s+",
        sql, re.IGNORECASE,
    )
    if not m:
        return
    table_name = m.group(1)
    table = tables.get(table_name)
    if table is None:
        return
    for dc in re.finditer(
        r"DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?\"?(\w+)\"?", sql, re.IGNORECASE
    ):
        col_name = dc.group(1)
        if col_name in table.columns:
            del table.columns[col_name]


def parse_drop_table(sql: str):
    """Parse DROP TABLE [IF EXISTS] [schema.]t so dropped tables disappear."""
    for m in re.finditer(
        r"DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:\"?\w+\"?\.)?\"?(\w+)\"?",
        sql, re.IGNORECASE,
    ):
        tables.pop(m.group(1), None)


def process_do_block(stmt: str):
    """Extract ALTER TABLE ... ADD/DROP COLUMN statements nested inside DO $$ ... $$.

    Idempotent migrations frequently wrap column changes in a
    `DO $$ BEGIN IF NOT EXISTS (...) THEN ALTER TABLE t ADD COLUMN c ...; END IF; END $$;`
    guard. The outer statement starts with `DO`, so it is otherwise ignored — but
    the columns are real. Pull the inner ALTER ... ADD/DROP COLUMN statements out
    (each terminated by `;`), in source order, and feed them to the normal parsers.
    """
    inner_re = re.compile(
        r"ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:\"?\w+\"?\.)?\"?\w+\"?\s+"
        r"(?:ADD|DROP)\s+COLUMN\b.*?;",
        re.IGNORECASE | re.DOTALL,
    )
    for inner in inner_re.finditer(stmt):
        text = inner.group(0)
        if re.search(r"\bDROP\s+COLUMN\b", text, re.IGNORECASE):
            parse_alter_drop_column(text)
        else:
            parse_alter_add_column(text)


def process_migration(filepath: Path):
    """Process a single migration file."""
    content = filepath.read_text(encoding="utf-8")
    
    # Remove comments
    content = re.sub(r'--[^\n]*', '', content)
    content = re.sub(r'/\*.*?\*/', '', content, flags=re.DOTALL)
    
    # Split into statements by semicolons, respecting $$ blocks
    statements = []
    current = ""
    in_dollar = False
    i = 0
    while i < len(content):
        if content[i:i+2] == '$$':
            in_dollar = not in_dollar
            current += '$$'
            i += 2
            continue
        if content[i] == ';' and not in_dollar:
            statements.append(current.strip())
            current = ""
        else:
            current += content[i]
        i += 1
    if current.strip():
        statements.append(current.strip())
    
    for stmt in statements:
        if not stmt:
            continue
        upper = stmt.upper().lstrip()
        if upper.startswith("CREATE TABLE"):
            parse_create_table(stmt)
        elif upper.startswith("DROP TABLE"):
            parse_drop_table(stmt)
        elif upper.startswith("ALTER TABLE"):
            # A single ALTER may add, drop, and/or set a PK; apply each in order.
            if "ADD COLUMN" in upper:
                parse_alter_add_column(stmt)
            if "DROP COLUMN" in upper:
                parse_alter_drop_column(stmt)
            if "ADD PRIMARY KEY" in upper:
                parse_alter_add_pk(stmt)
        elif upper.startswith("DO") and ("ADD COLUMN" in upper or "DROP COLUMN" in upper):
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
    # orders
    ("orders", "status"): "'pending' | 'completed' | 'refunded' | 'disputed' | 'cancelled' | 'pending_review'",
    # license_validations — CHECK widened by
    # 20260727030000_license_validations_result_undetermined.sql to cover the
    # entitlement statuses the validate route already logs verbatim plus the
    # service-fault outcomes ('unavailable' = status could not be determined,
    # which is deliberately NOT the same as 'revoked') and the terminal
    # per-device `session_invalidated` verdict.
    ("license_validations", "result"): (
        "'valid' | 'invalid_key' | 'expired' | 'suspended' | 'revoked'"
        " | 'over_device_limit' | 'product_mismatch' | 'cancelled' | 'pending'"
        " | 'grace_period' | 'unavailable' | 'rate_limited' | 'session_invalidated'"
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


def generate_row_interface(table: Table, name: str) -> str:
    """Generate a TypeScript interface for a table's Row type."""
    lines = [f"export interface {name} {{"]
    for col in table.columns.values():
        override_key = (table.name, col.name)
        if override_key in TYPE_OVERRIDES:
            ts_type = TYPE_OVERRIDES[override_key]
        else:
            ts_type = col.to_ts_type()
        lines.append(f"  {col.name}: {ts_type};")
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
    lines.append(" * limitations (no ALTER COLUMN type/nullability tracking, no constraint")
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

    uncategorized = sorted(t for t in tables if t not in categorized and t not in SKIP_TABLES)
    if uncategorized:
        CATEGORIES["Other"] = uncategorized

    for cat_name, tbl_names in CATEGORIES.items():
        cat_tables = [(n, tables[n]) for n in tbl_names if n in tables and n not in SKIP_TABLES]
        if not cat_tables:
            continue

        lines.append(f"// — {cat_name} —")
        lines.append("")

        for tbl_name, tbl in cat_tables:
            db_name = TABLE_TO_DB_NAME.get(tbl_name, "Db" + "".join(p.capitalize() for p in tbl_name.split("_")))
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
