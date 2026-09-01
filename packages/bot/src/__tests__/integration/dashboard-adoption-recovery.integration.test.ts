import { randomUUID } from 'node:crypto';
import postgres, { type TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { getTestDbUrl, requireSupabase } from './helpers.js';

type ProvenanceIdentity = {
  readonly exactSha: string;
  readonly bootId: string;
  readonly migrationHead: string;
  readonly configurationGeneration: number;
};
type RecoveryFixture = {
  readonly guild: string;
  readonly owner: string;
  readonly details: Record<string, unknown>;
  readonly migrationHead: string;
  readonly deployedIdentity: ProvenanceIdentity;
};
const baseArtifactNames = ['roles.sql', 'schema.sql', 'data.sql'] as const;
const historyArtifactNames = [...baseArtifactNames, 'history-schema.sql', 'history-data.sql'] as const;
const artifactsFor = (names: readonly string[]) => names.map((name) => ({ name, bytes: 1, sha256: 'd'.repeat(64) }));

async function withRecovery(run: (tx: TransactionSql, fixture: RecoveryFixture) => Promise<void>, artifactChecksums = artifactsFor(baseArtifactNames)): Promise<void> {
  await requireSupabase();
  const sql = postgres(getTestDbUrl(), { max: 1, connect_timeout: 5 });
  const rollback = new Error('rollback recovery evidence fixture');
  const guild = `recovery-${randomUUID()}`;
  const owner = '900000000000000123';
  try {
    await expect(sql.begin(async (tx) => {
      await tx`INSERT INTO public.guild(id,name,owner_discord_id) VALUES (${guild},'Recovery fixture',${owner})`;
      await tx`SET LOCAL ROLE service_role`;
      await tx`INSERT INTO public.guild_config(guild_id) VALUES (${guild})`;
      const [migration] = await tx<{ filename: string }[]>`SELECT filename FROM public.schema_migrations WHERE success IS TRUE ORDER BY applied_at DESC,filename DESC LIMIT 1`;
      if (!migration) throw new TypeError('Recovery fixture requires applied migrations');
      const deployedIdentity = {
        lifecycle: 'ready', version: 'test', exactSha: 'a'.repeat(40), bootId: randomUUID(),
        migrationHead: migration.filename, configurationGeneration: 7, deploymentProfile: 'vps-single-guild',
      };
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp,details)
        VALUES (${guild},'system','system','bot.started',true,clock_timestamp(),${JSON.stringify({ bootId: deployedIdentity.bootId, runtimeIdentity: deployedIdentity })}::jsonb)`;
      await tx`INSERT INTO public.bot_diagnostics(guild_id,type,boot_id,uptime_seconds,valkey_connected,discord_ws_ping,snapshot_at)
        VALUES (${guild},'health',${deployedIdentity.bootId},0,true,10,clock_timestamp())`;
      const [identity] = await tx<{ identity: Record<string, unknown>; captured_at: string }[]>`SELECT public.adoption_recovery_identity() AS identity,clock_timestamp()::text AS captured_at`;
      if (!identity) throw new TypeError('Recovery fixture identity unavailable');
      const details = { ...identity.identity, backupId: randomUUID(), capturedAt: identity.captured_at, sourceProjectRef: 'sourcefixture', checksumSha256: 'b'.repeat(64), configurationHash: 'c'.repeat(32),
        artifactChecksums, storageObjectsIncluded: false, deployedIdentity };
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp,details)
        VALUES (${guild},'system','launcher','launcher.backup.database_succeeded',true,clock_timestamp(),${JSON.stringify(details)}::jsonb)`;
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp,details)
        VALUES (${guild},'system','launcher','launcher.backup.valkey_succeeded',true,clock_timestamp(),${JSON.stringify({ capturedAt: identity.captured_at, checksumSha256: 'e'.repeat(64) })}::jsonb)`;
      const [time] = await tx<{ value: string }[]>`SELECT clock_timestamp()::text AS value`;
      if (!time) throw new TypeError('Recovery fixture clock unavailable');
      const rehearsal = { ...details, targetProjectRef: 'isolatedfixture', validated: true, rehearsedAt: time.value };
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp,details)
        VALUES (${guild},'system','launcher','launcher.restore.rehearsal_succeeded',true,clock_timestamp(),${JSON.stringify(rehearsal)}::jsonb)`;
      await run(tx, { guild, owner, details: rehearsal, migrationHead: migration.filename, deployedIdentity });
      throw rollback;
    })).rejects.toBe(rollback);
  } finally { await sql.end(); }
}

async function proof(tx: TransactionSql, guild: string): Promise<unknown> {
  const [row] = await tx<{ value: unknown }[]>`SELECT public.adoption_recovery_proof(${guild},NULL) AS value`;
  return row?.value;
}

describe('real database current recovery adoption evidence', () => {
  it('records a complete five-artifact backup with both migration-history files', async () => {
    await withRecovery(async (tx, fixture) => {
      const [row] = await tx<{ value: { result: string; eligible: boolean } }[]>`SELECT public.check_dashboard_adoption_track(
        ${fixture.guild},${fixture.owner},'recovery',${randomUUID()}::uuid,${randomUUID()}) AS value`;
      expect(row?.value).toMatchObject({ result: 'pass', eligible: true });
    }, artifactsFor(historyArtifactNames));
  });
  it.each([
    { label: 'history schema only', names: [...baseArtifactNames, 'history-schema.sql'] },
    { label: 'history data only', names: [...baseArtifactNames, 'history-data.sql'] },
    { label: 'missing base files', names: ['roles.sql', 'history-schema.sql', 'history-data.sql'] },
    { label: 'duplicate filenames', names: [...baseArtifactNames, 'history-schema.sql', 'history-schema.sql'] },
    { label: 'unknown filename', names: [...baseArtifactNames, 'history-schema.sql', 'unexpected.sql'] },
  ])('rejects a paired manifest containing $label', async ({ names }) => {
    await withRecovery(async (tx, fixture) => {
      expect(await proof(tx, fixture.guild)).toBeNull();
    }, artifactsFor(names));
  });
  it.each([0, -1, 1.5])('rejects invalid artifact byte count %s', async (bytes) => {
    await withRecovery(async (tx, fixture) => {
      expect(await proof(tx, fixture.guild)).toBeNull();
    }, artifactsFor(historyArtifactNames).map((artifact) => ({ ...artifact, bytes })));
  });
  it('rejects malformed artifact hashes in an otherwise complete history set', async () => {
    await withRecovery(async (tx, fixture) => {
      expect(await proof(tx, fixture.guild)).toBeNull();
    }, artifactsFor(historyArtifactNames).map((artifact) => ({ ...artifact, sha256: 'invalid' })));
  });
  it('records paired database rehearsal and independent Valkey snapshot without claiming their full restore', async () => {
    await withRecovery(async (tx, fixture) => {
      expect(await proof(tx, fixture.guild)).toMatchObject({
        scope: 'database_rehearsal_and_valkey_snapshot',
        deployedExactSha: fixture.deployedIdentity.exactSha,
        deployedBootId: fixture.deployedIdentity.bootId,
        deployedMigrationHead: fixture.deployedIdentity.migrationHead,
        deployedConfigurationGeneration: fixture.deployedIdentity.configurationGeneration,
      });
      const [row] = await tx<{ value: { result: string; eligible: boolean } }[]>`SELECT public.check_dashboard_adoption_track(
        ${fixture.guild},${fixture.owner},'recovery',${randomUUID()}::uuid,${randomUUID()}) AS value`;
      expect(row?.value).toMatchObject({ result: 'pass', eligible: true });
    });
  });
  it('rejects a rehearsal for a different backup checksum despite a previous matching rehearsal', async () => {
    await withRecovery(async (tx, fixture) => {
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp,details)
        VALUES (${fixture.guild},'system','launcher','launcher.restore.rehearsal_succeeded',true,clock_timestamp(),${JSON.stringify({ ...fixture.details, checksumSha256: 'f'.repeat(64) })}::jsonb)`;
      expect(await proof(tx, fixture.guild)).toBeNull();
    });
  });
  it('rejects latest backup failure instead of selecting an older success', async () => {
    await withRecovery(async (tx, fixture) => {
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp)
        VALUES (${fixture.guild},'system','launcher','launcher.backup.database_failed',false,clock_timestamp())`;
      expect(await proof(tx, fixture.guild)).toBeNull();
    });
  });
  it.each([false, null])('lets a rehearsal with success=%s beat success at the same timestamp', async (success) => {
    await withRecovery(async (tx, fixture) => {
      const [time] = await tx<{ value: string }[]>`SELECT clock_timestamp()::text AS value`;
      if (!time) throw new TypeError('Recovery fixture clock unavailable');
      await tx`INSERT INTO public.audit_logs(id,guild_id,actor_type,actor_id,action,success,timestamp,details)
        VALUES (${'0' + randomUUID().slice(1)}::uuid,${fixture.guild},'system','launcher','launcher.restore.rehearsal_failed',${success},${time.value}::timestamptz,${JSON.stringify(fixture.details)}::jsonb),
          (${'f' + randomUUID().slice(1)}::uuid,${fixture.guild},'system','launcher','launcher.restore.rehearsal_succeeded',true,${time.value}::timestamptz,${JSON.stringify(fixture.details)}::jsonb)`;
      expect(await proof(tx, fixture.guild)).toBeNull();
    });
  });
  it('invalidates backup identity after real configuration changes', async () => {
    await withRecovery(async (tx, fixture) => {
      await tx`UPDATE public.guild_config SET welcome_message='Changed after backup' WHERE guild_id=${fixture.guild}`;
      expect(await proof(tx, fixture.guild)).toBeNull();
    });
  });
  it('does not ignore a future-dated latest failure in favor of earlier good proof', async () => {
    await withRecovery(async (tx, fixture) => {
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp)
        VALUES (${fixture.guild},'system','launcher','launcher.restore.rehearsal_failed',false,clock_timestamp()+interval '1 hour')`;
      expect(await proof(tx, fixture.guild)).toBeNull();
    });
  });
  it.each([
    { label: 'drifted exact SHA', changes: { exactSha: 'f'.repeat(40) } },
    { label: 'drifted boot ID', changes: { bootId: '22222222-2222-4222-8222-222222222222' } },
    { label: 'drifted migration head', changes: { migrationHead: '20260831135600_drift.sql' } },
    { label: 'drifted configuration generation', changes: { configurationGeneration: 8 } },
    { label: 'unknown exact SHA', changes: { exactSha: null } },
    { label: 'unknown boot ID', changes: { bootId: null } },
    { label: 'unknown migration head', changes: { migrationHead: null } },
    { label: 'unknown configuration generation', changes: { configurationGeneration: null } },
  ])('rejects $label in the current runtime identity', async ({ changes }) => {
    await withRecovery(async (tx, fixture) => {
      const currentIdentity = { ...fixture.deployedIdentity, ...changes };
      const currentBootId = typeof currentIdentity.bootId === 'string'
        ? currentIdentity.bootId
        : fixture.deployedIdentity.bootId;
      await tx`UPDATE public.audit_logs
        SET details=${JSON.stringify({ bootId: currentBootId, runtimeIdentity: currentIdentity })}::jsonb,
          timestamp=clock_timestamp()
        WHERE guild_id=${fixture.guild} AND action='bot.started'`;
      await tx`UPDATE public.bot_diagnostics SET boot_id=${currentBootId},snapshot_at=clock_timestamp()
        WHERE guild_id=${fixture.guild}`;

      expect(await proof(tx, fixture.guild)).toBeNull();
    });
  });
});
