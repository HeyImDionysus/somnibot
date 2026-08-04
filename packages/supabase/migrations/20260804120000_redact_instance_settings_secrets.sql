-- Remove legacy plaintext credential values from instance_settings.
--
-- The launcher is the encrypted credential owner.  Dashboard setup may keep
-- non-secret identifiers and URLs, but must not persist reusable credentials.
-- Preserve only a configured marker so existing installs retain readiness
-- state; the launcher/runtime environment remains the source of the value.

DO $$
DECLARE
  secret_key TEXT;
  secret_keys TEXT[] := ARRAY[
    'discord_token',
    'discord_bot_token',
    'discord_client_secret',
    'paypal_client_secret',
    'paypal_webhook_id',
    'paypal_webhook_proof_key',
    'lavalink_password',
    'valkey_url',
    'supabase_secret_key',
    'supabase_access_token',
    'supabase_db_url',
    'supabase_db_url_template',
    'supabase_db_password',
    'tailscale_auth_key',
    'vps_csrf_secret',
    'vps_nextauth_secret',
    'vps_webhook_replay_secret',
    'vps_valkey_password',
    'vps_lavalink_password'
  ];
BEGIN
  FOREACH secret_key IN ARRAY secret_keys LOOP
    INSERT INTO instance_settings (key, value, section, updated_at)
      SELECT secret_key || '_configured', 'true', section, now()
      FROM instance_settings
      WHERE key = secret_key
        AND value IS NOT NULL
        AND btrim(value) <> ''
    ON CONFLICT (key) DO UPDATE
      SET value = 'true', updated_at = now();

    DELETE FROM instance_settings WHERE key = secret_key;
  END LOOP;
END $$;
