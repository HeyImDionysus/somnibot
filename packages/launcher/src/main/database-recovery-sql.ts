import { DatabaseRecoveryError } from './database-recovery-contract.js';

export const RECOVERY_IDENTITY_SQL = `
SELECT jsonb_build_object(
  'observedAt', clock_timestamp(),
  'migrationHead', (SELECT filename FROM public.schema_migrations WHERE success IS TRUE ORDER BY applied_at DESC, filename DESC LIMIT 1),
  'migrationHash', (SELECT md5(coalesce(jsonb_agg(jsonb_build_array(filename, checksum, success) ORDER BY filename)::text, '[]')) FROM public.schema_migrations),
  'configurationHash', (SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY guild_id)::text, '[]')) FROM public.guild_config c),
  'adoptionConfigurationHash', (SELECT md5(coalesce(jsonb_agg(to_jsonb(c) - ARRAY['updated_at','adoption_map','dashboard_guide_state','tutorial_state'] ORDER BY guild_id)::text, '[]')) FROM public.guild_config c),
  'schemaHash', md5(concat_ws('|',
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY table_schema,table_name,ordinal_position)::text FROM information_schema.columns c WHERE table_schema='public'),
    (SELECT jsonb_agg(jsonb_build_array(c.relname, k.conname, pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname)::text FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname)::text FROM pg_policies p WHERE schemaname='public'))),
  'tables', (SELECT jsonb_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'),
  'userCount', (SELECT count(*) FROM auth.users),
  'objectCount', (SELECT count(*) FROM storage.objects)
);`;

export const RECOVERY_TARGET_GUARD_SQL = `
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(812388993321::bigint);
LOCK TABLE auth.users, storage.objects IN ACCESS EXCLUSIVE MODE;
DO $recovery_guard$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'recovery_target_identity_rejected';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e'))
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'))
     OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('d','e','r')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e'))
     OR EXISTS (SELECT 1 FROM auth.users) OR EXISTS (SELECT 1 FROM storage.objects) THEN
    RAISE EXCEPTION 'recovery_target_must_be_unused';
  END IF;
END $recovery_guard$;
SET LOCAL session_replication_role = replica;`;

export type RecoveryIdentity = {
  readonly migrationHead: string;
  readonly migrationHash: string;
  readonly configurationHash: string;
  readonly adoptionConfigurationHash: string;
  readonly schemaHash: string;
  readonly tables: readonly string[];
  readonly userCount: number;
  readonly objectCount: number;
};

export function parseRecoveryIdentity(raw: string): RecoveryIdentity {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('migrationHead' in value) || typeof value.migrationHead !== 'string'
    || !/^\d{14}_[a-z0-9_]+\.sql$/.test(value.migrationHead)
    || !('migrationHash' in value) || typeof value.migrationHash !== 'string' || !/^[0-9a-f]{32}$/.test(value.migrationHash)
    || !('configurationHash' in value) || typeof value.configurationHash !== 'string' || !/^[0-9a-f]{32}$/.test(value.configurationHash)
    || !('adoptionConfigurationHash' in value) || typeof value.adoptionConfigurationHash !== 'string' || !/^[0-9a-f]{32}$/.test(value.adoptionConfigurationHash)
    || !('schemaHash' in value) || typeof value.schemaHash !== 'string' || !/^[0-9a-f]{32}$/.test(value.schemaHash)
    || !('tables' in value) || !Array.isArray(value.tables) || !value.tables.every((item: unknown): item is string => typeof item === 'string')
    || !('userCount' in value) || typeof value.userCount !== 'number' || !Number.isSafeInteger(value.userCount) || value.userCount < 0
    || !('objectCount' in value) || typeof value.objectCount !== 'number' || !Number.isSafeInteger(value.objectCount) || value.objectCount < 0) {
    throw new DatabaseRecoveryError('database-identity-unavailable');
  }
  return { migrationHead: value.migrationHead, migrationHash: value.migrationHash, configurationHash: value.configurationHash,
    adoptionConfigurationHash: value.adoptionConfigurationHash, schemaHash: value.schemaHash,
    tables: value.tables, userCount: value.userCount, objectCount: value.objectCount };
}

export function recoveryTimestamp(raw: string): string {
  const value: unknown = JSON.parse(raw);
  const timestamp = typeof value === 'string' ? value
    : value && typeof value === 'object' && 'observedAt' in value ? value.observedAt : null;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw new DatabaseRecoveryError('database-timestamp-unavailable');
  return new Date(timestamp).toISOString();
}

export function recoveryValidationSql(expected: RecoveryIdentity): string {
  const expectedJson = JSON.stringify(expected).replace(/'/g, "''");
  return `SET LOCAL session_replication_role = origin;
DO $recovery_validation$
DECLARE observed jsonb;
BEGIN
  SELECT recovered INTO observed FROM (${RECOVERY_IDENTITY_SQL.trim().replace(/;$/, '')}) AS identity(recovered);
  IF observed - 'observedAt' IS DISTINCT FROM '${expectedJson}'::jsonb THEN RAISE EXCEPTION 'recovery_validation_mismatch'; END IF;
END $recovery_validation$;`;
}
