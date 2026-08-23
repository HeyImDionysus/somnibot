import {
  RuntimeSystemStateSchema,
  SystemStateSchema,
  type BackupState,
  type RuntimeSystemState,
  type SystemState,
} from '@somnibot/shared';
import { z } from 'zod';

export const SystemStateEvidenceSchema = z.object({
  action: z.string().trim().min(1).max(160),
  timestamp: z.string().datetime(),
  success: z.boolean(),
  details: z.record(z.unknown()),
});
export type SystemStateEvidence = z.infer<typeof SystemStateEvidenceSchema>;

export const CredentialPresenceSchema = z.object({
  key: z.string().trim().min(1).max(160),
  present: z.boolean(),
  updatedAt: z.string().datetime(),
});
export type CredentialPresence = z.infer<typeof CredentialPresenceSchema>;

type DashboardSystemStateInput = {
  readonly observedAt: string;
  readonly guildId: string;
  readonly runtime: RuntimeSystemState | null;
  readonly valkeyConnected: boolean;
  readonly supabaseConnected: boolean;
  readonly dlqDepth: number | null;
  readonly evidence: readonly SystemStateEvidence[];
  readonly credentials: readonly CredentialPresence[];
};

const unknownBackup: BackupState = {
  status: 'unknown',
  capturedAt: null,
  checksumSha256: null,
  lastRestoreRehearsalAt: null,
};

function latestEvidence(
  evidence: readonly SystemStateEvidence[],
  action: string,
): SystemStateEvidence | null {
  return evidence
    .filter((entry) => entry.action === action && entry.success)
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0] ?? null;
}

function backupState(
  evidence: readonly SystemStateEvidence[],
  action: string,
  rehearsalAt: string | null,
): BackupState {
  const entry = latestEvidence(evidence, action);
  if (!entry) return { ...unknownBackup, lastRestoreRehearsalAt: rehearsalAt };
  const checksum = typeof entry.details.checksumSha256 === 'string'
    && /^[0-9a-f]{64}$/i.test(entry.details.checksumSha256)
    ? entry.details.checksumSha256
    : null;
  const capturedAt = typeof entry.details.capturedAt === 'string'
    && Number.isFinite(Date.parse(entry.details.capturedAt))
    ? entry.details.capturedAt
    : entry.timestamp;
  return {
    status: checksum ? 'current' : 'failed',
    capturedAt,
    checksumSha256: checksum,
    lastRestoreRehearsalAt: rehearsalAt,
  };
}

function credentialMetadata(
  credential: CredentialPresence,
  observedAt: string,
): SystemState['credentials'][number] {
  const ageDays = Math.max(0, Math.floor(
    (Date.parse(observedAt) - Date.parse(credential.updatedAt)) / 86_400_000,
  ));
  return {
    key: credential.key.replace(/_encrypted$/, ''),
    present: credential.present,
    source: credential.present ? 'cloud_vault' : 'none',
    validity: credential.present ? 'not_checked' : 'unknown',
    observedAt,
    rotatedAt: credential.present ? credential.updatedAt : null,
    ageDays: credential.present ? ageDays : null,
    rotationDueAt: null,
  };
}

export function buildDashboardSystemState(input: DashboardSystemStateInput): SystemState {
  const runtime = input.runtime ? RuntimeSystemStateSchema.parse(input.runtime) : null;
  const rehearsal = latestEvidence(input.evidence, 'launcher.restore.rehearsal_succeeded');
  const rehearsalAt = rehearsal?.timestamp ?? null;
  const databaseBackup = backupState(input.evidence, 'launcher.backup.database_succeeded', rehearsalAt);
  const valkeyBackup = backupState(input.evidence, 'launcher.backup.valkey_succeeded', rehearsalAt);
  const dependenciesReady = input.valkeyConnected && input.supabaseConnected;
  const mode = runtime?.mode === 'normal' && dependenciesReady ? 'normal' : 'degraded';

  return SystemStateSchema.parse({
    schemaVersion: 1,
    observedAt: input.observedAt,
    mode,
    identity: runtime?.identity ?? {
      lifecycle: 'degraded',
      version: process.env.npm_package_version ?? 'unknown',
      exactSha: /^[0-9a-f]{40}$/i.test(process.env.SOMNIBOT_GIT_SHA ?? '')
        ? process.env.SOMNIBOT_GIT_SHA
        : null,
      bootId: null,
      migrationHead: null,
      configurationGeneration: null,
      deploymentProfile: 'unknown',
    },
    providers: [
      ...(runtime?.providers ?? []),
      { key: 'supabase', status: input.supabaseConnected ? 'ready' : 'unavailable', checkedAt: input.observedAt },
      { key: 'valkey', status: input.valkeyConnected ? 'ready' : 'unavailable', checkedAt: input.observedAt },
    ],
    queues: [
      ...(runtime?.queues ?? []),
      {
        key: 'action_queue_dlq',
        status: input.dlqDepth === null ? 'unknown' : input.dlqDepth > 0 ? 'backlogged' : 'ready',
        depth: input.dlqDepth,
        oldestAgeMs: null,
      },
    ],
    features: runtime?.features ?? [],
    backups: { database: databaseBackup, valkey: valkeyBackup },
    recovery: {
      status: rehearsalAt && databaseBackup.status === 'current' && valkeyBackup.status === 'current'
        ? 'ready'
        : 'unverified',
      lastRehearsalAt: rehearsalAt,
      recoveryPointObjectiveMinutes: null,
      recoveryTimeObjectiveMinutes: null,
      evidenceRef: rehearsal ? `audit:${rehearsal.action}:${rehearsal.timestamp}` : null,
    },
    credentials: input.credentials.map((credential) => credentialMetadata(credential, input.observedAt)),
    guildConditions: runtime?.guildConditions ?? [{
      guildId: input.guildId,
      status: dependenciesReady ? 'unknown' : 'degraded',
      conditions: dependenciesReady ? ['Bot runtime state has not been observed'] : ['Required runtime provider is unavailable'],
    }],
  });
}
