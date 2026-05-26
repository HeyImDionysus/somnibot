#!/usr/bin/env python3
"""
Parse SomniBot SQL migrations and generate accurate TypeScript database types.
v2: Better JSONB handling, CHECK constraint extraction, manual overrides.
"""

import re
import os
from collections import OrderedDict
from pathlib import Path

MIGRATIONS_DIR = Path("/work/repos/somnibot-typegen/packages/supabase/migrations")


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
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\"?(\w+)\"?)\s*\(",
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
    # Extract table name
    m = re.match(r"ALTER\s+TABLE\s+(?:\"?(\w+)\"?)\s+", sql, re.IGNORECASE)
    if not m:
        return
    
    table_name = m.group(1)
    if table_name not in tables:
        return
    
    table = tables[table_name]
    
    # Find all ADD COLUMN clauses
    # Split by ADD COLUMN (case insensitive)
    pattern = r"ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+([^,]+?)(?=,\s*ADD\s+COLUMN|$)"
    for col_match in re.finditer(pattern, sql, re.IGNORECASE | re.DOTALL):
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
        r"ALTER\s+TABLE\s+(?:\"?(\w+)\"?)\s+ADD\s+PRIMARY\s+KEY\s*\(([^)]+)\)",
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


def process_migration(filepath: Path):
    """Process a single migration file."""
    content = filepath.read_text()
    
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
        elif "ADD COLUMN" in upper and upper.startswith("ALTER TABLE"):
            parse_alter_add_column(stmt)
        elif "ADD PRIMARY KEY" in upper and upper.startswith("ALTER TABLE"):
            parse_alter_add_pk(stmt)


# ============================================================
# Manual type overrides for well-known JSONB columns
# ============================================================
# These override the generated JSONB types with more specific types
# Format: (table_name, column_name) → ts_type
JSONB_OVERRIDES: dict[tuple[str, str], str] = {
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
        if override_key in JSONB_OVERRIDES:
            ts_type = JSONB_OVERRIDES[override_key]
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


def main():
    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    print(f"Processing {len(migration_files)} migration files...")
    
    for mf in migration_files:
        process_migration(mf)
    
    print(f"\nFound {len(tables)} tables")
    
    # Build output
    lines = []
    lines.append("/**")
    lines.append(" * AUTO-GENERATED from SQL migrations — DO NOT EDIT BY HAND")
    lines.append(f" * Source: {len(migration_files)} migration files in packages/supabase/migrations/")
    lines.append(" * Run `scripts/generate-db-types.ts` to regenerate.")
    lines.append(" *")
    lines.append(" * This file is the SINGLE SOURCE OF TRUTH for database column types.")
    lines.append(" * If a column name doesn't exist here, it doesn't exist in the database.")
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
    
    uncategorized = [t for t in tables if t not in categorized and t not in SKIP_TABLES]
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
    
    result = "\n".join(lines)
    
    out_path = MIGRATIONS_DIR.parent.parent / "shared" / "src" / "types" / "database.ts"
    out_path.write_text(result)
    print(f"Generated types written to {out_path}")
    print(f"Total lines: {len(result.splitlines())}")
    
    # Also print a diff summary of what changed vs old types
    print("\n=== KEY DIFFERENCES FROM OLD database.ts ===")
    print("\nTables that are NEW (not in old hand-written types):")
    old_types = {"users", "guild", "guild_config", "members", "role_templates", "channel_templates",
                 "guild_desired_state", "discord_id_map", "reaction_roles", "automod_rules",
                 "infractions", "ticket_panels", "tickets", "ticket_transcripts", "automations",
                 "custom_commands", "embed_configs", "member_levels", "level_rewards", "xp_multipliers",
                 "member_rank_settings", "temp_channel_hubs", "stats_channels", "scheduled_messages",
                 "giveaways", "products", "product_files", "plans", "customers", "promotions",
                 "orders", "license_keys", "entitlements", "product_license_config", "license_sessions",
                 "license_validations", "payments", "audit_logs", "webhook_events",
                 "dashboard_roles", "dashboard_user_roles", "portal_sessions", "fraud_signals",
                 "fraud_rules", "incidents", "incident_events", "dead_letter_queue",
                 "workflow_events", "admin_changes"}
    
    for tname in sorted(tables.keys()):
        if tname not in old_types and tname not in SKIP_TABLES:
            print(f"  + {tname} ({len(tables[tname].columns)} columns)")
    
    print("\nguild_config columns in schema:")
    if "guild_config" in tables:
        for col in tables["guild_config"].columns.values():
            print(f"  {col.name}: {col.sql_type} {'NOT NULL' if not col.nullable else 'NULL'}")


if __name__ == "__main__":
    main()
