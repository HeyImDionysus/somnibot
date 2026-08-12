-- Administration and infrastructure control-plane settings.
-- Editable guild controls are persisted with matching API/DB bounds. Security
-- invariants remain fixed and are rendered as read-only status controls.
BEGIN;

ALTER TABLE public.product_license_config
  ADD COLUMN IF NOT EXISTS sdk_cache_ttl_ms integer NOT NULL DEFAULT 60000;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_license_config_sdk_cache_ttl_ms_check') THEN
    ALTER TABLE public.product_license_config ADD CONSTRAINT product_license_config_sdk_cache_ttl_ms_check CHECK (sdk_cache_ttl_ms BETWEEN 1000 AND 3600000);
  END IF;
END $$;
ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS audit_export_row_limit integer NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS audit_flush_interval_ms integer NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS automation_dm_cooldown_seconds integer NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS automation_max_chain_depth integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS automation_preview_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS automation_user_fire_limit_per_minute integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS custom_commands_max_per_guild integer NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS custom_commands_mention_safety boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS diagnostics_snapshot_interval_ms integer NOT NULL DEFAULT 60000,
  ADD COLUMN IF NOT EXISTS incidents_auto_create_from_critical_alerts boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS incidents_default_severity text NOT NULL DEFAULT 'warning',
  ADD COLUMN IF NOT EXISTS incidents_list_page_size integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS rbac_custom_role_priority_default integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS rbac_max_permissions_per_role integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS rbac_priority_escalation_guard boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS rbac_unknown_route_access text NOT NULL DEFAULT 'deny';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_audit_export_row_limit_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_audit_export_row_limit_check CHECK (audit_export_row_limit BETWEEN 1 AND 100000); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_audit_flush_interval_ms_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_audit_flush_interval_ms_check CHECK (audit_flush_interval_ms BETWEEN 1000 AND 60000); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_automation_dm_cooldown_seconds_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_automation_dm_cooldown_seconds_check CHECK (automation_dm_cooldown_seconds BETWEEN 0 AND 86400); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_automation_max_chain_depth_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_automation_max_chain_depth_check CHECK (automation_max_chain_depth BETWEEN 1 AND 10); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_automation_user_fire_limit_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_automation_user_fire_limit_check CHECK (automation_user_fire_limit_per_minute BETWEEN 1 AND 100); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_custom_commands_max_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_custom_commands_max_check CHECK (custom_commands_max_per_guild BETWEEN 1 AND 10000); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_diagnostics_snapshot_interval_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_diagnostics_snapshot_interval_check CHECK (diagnostics_snapshot_interval_ms BETWEEN 10000 AND 3600000); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_incidents_default_severity_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_incidents_default_severity_check CHECK (incidents_default_severity IN ('info', 'warning', 'critical', 'outage')); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_incidents_list_page_size_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_incidents_list_page_size_check CHECK (incidents_list_page_size BETWEEN 1 AND 100); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_rbac_priority_default_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_rbac_priority_default_check CHECK (rbac_custom_role_priority_default BETWEEN 0 AND 999); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_rbac_max_permissions_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_rbac_max_permissions_check CHECK (rbac_max_permissions_per_role BETWEEN 1 AND 500); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_rbac_unknown_route_check') THEN ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_rbac_unknown_route_check CHECK (rbac_unknown_route_access = 'deny'); END IF;
END $$;
COMMENT ON COLUMN public.guild_config.custom_commands_mention_safety IS 'Locked security invariant: custom command output always uses allowedMentions.parse=[].';
COMMENT ON COLUMN public.guild_config.rbac_priority_escalation_guard IS 'Locked security invariant: role grants cannot exceed the actor role priority.';
COMMENT ON COLUMN public.guild_config.rbac_unknown_route_access IS 'Locked security invariant: routes without an explicit permission mapping are denied.';
COMMIT;
