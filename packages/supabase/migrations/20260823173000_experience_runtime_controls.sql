ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS owner_notification_policy JSONB NOT NULL DEFAULT '{
    "schemaVersion": 1,
    "enabled": true,
    "minimumSeverity": "warning",
    "audiences": ["owner"],
    "channels": ["discord_channel", "discord_dm"],
    "cooldownSeconds": 60,
    "quietHours": null,
    "acknowledgementRequired": ["critical"],
    "escalation": {"afterSeconds": 900, "audiences": ["owner"]}
  }'::JSONB,
  ADD COLUMN IF NOT EXISTS owner_notification_rollout JSONB NOT NULL DEFAULT '{
    "state": "general_availability",
    "guildIds": [],
    "deploymentIds": []
  }'::JSONB;

ALTER TABLE public.guild_config
  ADD CONSTRAINT guild_config_owner_notification_policy_object
    CHECK (jsonb_typeof(owner_notification_policy) = 'object'),
  ADD CONSTRAINT guild_config_owner_notification_rollout_object
    CHECK (jsonb_typeof(owner_notification_rollout) = 'object');

COMMENT ON COLUMN public.guild_config.owner_notification_policy IS
  'Versioned owner-alert delivery, cooldown, acknowledgement, quiet-hours, and escalation policy.';
COMMENT ON COLUMN public.guild_config.owner_notification_rollout IS
  'Auditable runtime rollout state for owner notifications; emergency and maintenance states fail closed.';
