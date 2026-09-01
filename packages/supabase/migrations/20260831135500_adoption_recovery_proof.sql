CREATE OR REPLACE FUNCTION public.adoption_recovery_identity()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (SELECT count(*) FROM (SELECT 1 FROM public.guild_config LIMIT 1001) AS bounded) > 1000 THEN RETURN NULL; END IF;
  PERFORM guild_id FROM public.guild_config ORDER BY guild_id FOR SHARE;
  RETURN jsonb_build_object(
    'migrationHead', (SELECT filename FROM public.schema_migrations WHERE success IS TRUE ORDER BY applied_at DESC, filename DESC LIMIT 1),
    'migrationHash', (SELECT md5(coalesce(jsonb_agg(jsonb_build_array(filename, checksum, success) ORDER BY filename)::text, '[]')) FROM public.schema_migrations),
    'adoptionConfigurationHash', (SELECT md5(coalesce(jsonb_agg(to_jsonb(c) - ARRAY['updated_at','adoption_map','dashboard_guide_state','tutorial_state'] ORDER BY guild_id)::text, '[]')) FROM public.guild_config c),
    'schemaHash', md5(concat_ws('|',
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY table_schema,table_name,ordinal_position)::text FROM information_schema.columns c WHERE table_schema='public'),
      (SELECT jsonb_agg(jsonb_build_array(c.relname, k.conname, pg_catalog.pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname)::text FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname)::text FROM pg_catalog.pg_policies p WHERE schemaname='public')))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.adoption_recovery_proof(p_guild_id TEXT, p_since TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_database public.audit_logs%ROWTYPE;
  v_valkey public.audit_logs%ROWTYPE;
  v_rehearsal public.audit_logs%ROWTYPE;
  v_boot public.audit_logs%ROWTYPE;
  v_identity JSONB;
  v_artifact_names TEXT[];
  v_field TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_database FROM public.audit_logs WHERE guild_id = p_guild_id
    AND action IN ('launcher.backup.database_succeeded','launcher.backup.database_failed')
    AND timestamp >= GREATEST(p_since, v_now - INTERVAL '24 hours') ORDER BY timestamp DESC, (success IS NOT TRUE) DESC, id DESC LIMIT 1;
  SELECT * INTO v_valkey FROM public.audit_logs WHERE guild_id = p_guild_id
    AND action IN ('launcher.backup.valkey_succeeded','launcher.backup.valkey_failed')
    AND timestamp >= GREATEST(p_since, v_now - INTERVAL '24 hours') ORDER BY timestamp DESC, (success IS NOT TRUE) DESC, id DESC LIMIT 1;
  SELECT * INTO v_rehearsal FROM public.audit_logs WHERE guild_id = p_guild_id
    AND action IN ('launcher.restore.rehearsal_succeeded','launcher.restore.rehearsal_failed')
    AND timestamp >= GREATEST(p_since, v_now - INTERVAL '24 hours') ORDER BY timestamp DESC, (success IS NOT TRUE) DESC, id DESC LIMIT 1;
  IF v_database.success IS NOT TRUE OR v_valkey.success IS NOT TRUE OR v_rehearsal.success IS NOT TRUE
    OR v_database.action <> 'launcher.backup.database_succeeded' OR v_valkey.action <> 'launcher.backup.valkey_succeeded'
    OR v_rehearsal.action <> 'launcher.restore.rehearsal_succeeded'
    OR v_database.timestamp > v_now OR v_valkey.timestamp > v_now OR v_rehearsal.timestamp > v_now THEN RETURN NULL; END IF;
  IF v_database.details->>'backupId' IS NULL OR (v_database.details->>'backupId') !~ '^[0-9a-f-]{36}$'
    OR COALESCE(v_database.details->>'checksumSha256','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(v_valkey.details->>'checksumSha256','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(v_database.details->>'sourceProjectRef','') !~ '^[a-z0-9]+$'
    OR COALESCE(v_rehearsal.details->>'targetProjectRef','') !~ '^[a-z0-9]+$'
    OR v_rehearsal.details->>'sourceProjectRef' = v_rehearsal.details->>'targetProjectRef'
    OR v_rehearsal.details->>'validated' IS DISTINCT FROM 'true'
    OR v_database.details->>'storageObjectsIncluded' IS DISTINCT FROM 'false'
    OR v_rehearsal.details->>'storageObjectsIncluded' IS DISTINCT FROM 'false'
    OR v_rehearsal.timestamp < v_database.timestamp THEN RETURN NULL; END IF;
  FOREACH v_field IN ARRAY ARRAY['backupId','checksumSha256','capturedAt','sourceProjectRef','migrationHead','migrationHash','configurationHash','adoptionConfigurationHash','schemaHash','artifactChecksums','deployedIdentity'] LOOP
    IF v_database.details->v_field IS NULL OR v_database.details->v_field = 'null'::JSONB
      OR v_database.details->v_field IS DISTINCT FROM v_rehearsal.details->v_field THEN RETURN NULL; END IF;
  END LOOP;
  IF jsonb_typeof(v_database.details->'artifactChecksums') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  SELECT array_agg(item->>'name' ORDER BY item->>'name') INTO v_artifact_names
    FROM jsonb_array_elements(v_database.details->'artifactChecksums') AS item;
  IF v_artifact_names IS DISTINCT FROM ARRAY['data.sql','roles.sql','schema.sql']
    AND v_artifact_names IS DISTINCT FROM ARRAY['data.sql','history-data.sql','history-schema.sql','roles.sql','schema.sql'] THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_database.details->'artifactChecksums') AS item
      WHERE jsonb_typeof(item->'sha256') IS DISTINCT FROM 'string' OR COALESCE(item->>'sha256','') !~ '^[0-9a-f]{64}$'
        OR jsonb_typeof(item->'bytes') IS DISTINCT FROM 'number' OR COALESCE(item->>'bytes','') !~ '^[1-9][0-9]*$') THEN RETURN NULL; END IF;
  IF (v_database.details->>'capturedAt')::TIMESTAMPTZ < GREATEST(p_since, v_now - INTERVAL '24 hours')
    OR (v_database.details->>'capturedAt')::TIMESTAMPTZ > v_database.timestamp
    OR (v_valkey.details->>'capturedAt') IS NULL
    OR (v_valkey.details->>'capturedAt')::TIMESTAMPTZ < GREATEST(p_since, v_now - INTERVAL '24 hours')
    OR (v_valkey.details->>'capturedAt')::TIMESTAMPTZ > v_valkey.timestamp
    OR (v_rehearsal.details->>'rehearsedAt') IS NULL
    OR (v_rehearsal.details->>'rehearsedAt')::TIMESTAMPTZ < v_database.timestamp
    OR (v_rehearsal.details->>'rehearsedAt')::TIMESTAMPTZ > v_rehearsal.timestamp THEN RETURN NULL; END IF;
  v_identity := public.adoption_recovery_identity();
  IF v_identity IS NULL THEN RETURN NULL; END IF;
  FOREACH v_field IN ARRAY ARRAY['migrationHead','migrationHash','adoptionConfigurationHash','schemaHash'] LOOP
    IF v_identity->>v_field IS NULL OR v_identity->>v_field IS DISTINCT FROM v_database.details->>v_field THEN RETURN NULL; END IF;
  END LOOP;
  SELECT audit.* INTO v_boot FROM public.audit_logs AS audit JOIN public.bot_diagnostics AS health ON health.guild_id = audit.guild_id
    AND health.type = 'health' AND audit.details->>'bootId' = health.boot_id::TEXT
    WHERE audit.guild_id = p_guild_id AND audit.action = 'bot.started' AND audit.success IS TRUE
      AND health.snapshot_at > v_now - INTERVAL '5 minutes' AND health.snapshot_at <= v_now
      AND audit.timestamp <= health.snapshot_at ORDER BY audit.timestamp DESC,audit.id DESC LIMIT 1;
  IF v_boot.id IS NULL OR COALESCE(v_boot.details->'runtimeIdentity'->>'exactSha','') !~* '^[a-f0-9]{40}$'
    OR COALESCE(v_database.details->'deployedIdentity'->>'exactSha','') !~* '^[a-f0-9]{40}$'
    OR lower(v_boot.details->'runtimeIdentity'->>'exactSha') IS DISTINCT FROM lower(v_database.details->'deployedIdentity'->>'exactSha')
    OR COALESCE(v_boot.details->'runtimeIdentity'->>'bootId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR COALESCE(v_database.details->'deployedIdentity'->>'bootId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR v_boot.details->'runtimeIdentity'->>'bootId' IS DISTINCT FROM v_boot.details->>'bootId'
    OR v_boot.details->'runtimeIdentity'->>'bootId' IS DISTINCT FROM v_database.details->'deployedIdentity'->>'bootId'
    OR v_boot.details->'runtimeIdentity'->>'migrationHead' IS NULL
    OR v_database.details->'deployedIdentity'->>'migrationHead' IS NULL
    OR v_boot.details->'runtimeIdentity'->>'migrationHead' IS DISTINCT FROM v_identity->>'migrationHead'
    OR v_database.details->'deployedIdentity'->>'migrationHead' IS DISTINCT FROM v_identity->>'migrationHead'
    OR jsonb_typeof(v_boot.details->'runtimeIdentity'->'configurationGeneration') IS DISTINCT FROM 'number'
    OR COALESCE(v_boot.details->'runtimeIdentity'->>'configurationGeneration','') !~ '^(0|[1-9][0-9]*)$'
    OR jsonb_typeof(v_database.details->'deployedIdentity'->'configurationGeneration') IS DISTINCT FROM 'number'
    OR COALESCE(v_database.details->'deployedIdentity'->>'configurationGeneration','') !~ '^(0|[1-9][0-9]*)$'
    OR v_boot.details->'runtimeIdentity'->'configurationGeneration' IS DISTINCT FROM v_database.details->'deployedIdentity'->'configurationGeneration' THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('identity', md5((v_identity || jsonb_build_object('backupId',v_database.details->>'backupId','checksum',v_database.details->>'checksumSha256','valkeyChecksum',v_valkey.details->>'checksumSha256'))::TEXT),
    'evidenceIds',jsonb_build_array(v_database.id,v_valkey.id,v_rehearsal.id),
    'backupId',v_database.details->>'backupId','databaseChecksumSha256',v_database.details->>'checksumSha256',
    'valkeyChecksumSha256',v_valkey.details->>'checksumSha256','rehearsedAt',v_rehearsal.details->>'rehearsedAt',
    'deployedExactSha',lower(v_boot.details->'runtimeIdentity'->>'exactSha'),
    'deployedBootId',v_boot.details->'runtimeIdentity'->>'bootId',
    'deployedMigrationHead',v_boot.details->'runtimeIdentity'->>'migrationHead',
    'deployedConfigurationGeneration',v_boot.details->'runtimeIdentity'->'configurationGeneration',
    'scope','database_rehearsal_and_valkey_snapshot',
    'expiresAt',LEAST((v_database.details->>'capturedAt')::TIMESTAMPTZ,(v_valkey.details->>'capturedAt')::TIMESTAMPTZ) + INTERVAL '24 hours');
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.adoption_recovery_identity(), public.adoption_recovery_proof(TEXT,TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adoption_recovery_identity(), public.adoption_recovery_proof(TEXT,TIMESTAMPTZ) TO service_role;
