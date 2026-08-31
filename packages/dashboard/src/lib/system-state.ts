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
  timestamp: z.string().datetime({ offset: true }),
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

const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const timestampSchema = z.string().datetime({ offset: true });
const checksumSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const recoveryProofSchema = z.object({
  identity: z.string().regex(/^[0-9a-f]{32}$/),
  backupId: z.string().uuid(),
  databaseChecksumSha256: checksumSchema,
  valkeyChecksumSha256: checksumSchema,
  rehearsedAt: timestampSchema,
  deployedExactSha: z.string().regex(/^[0-9a-f]{40}$/i),
  scope: z.literal('database_rehearsal_and_valkey_snapshot'),
  expiresAt: timestampSchema,
  evidenceIds: z.array(z.string().uuid()).min(1).max(20),
});

export const RECOVERY_EVIDENCE_ACTIONS = [
  'launcher.backup.database_succeeded', 'launcher.backup.database_failed',
  'launcher.backup.valkey_succeeded', 'launcher.backup.valkey_failed',
  'launcher.restore.rehearsal_succeeded', 'launcher.restore.rehearsal_failed',
] as const;

type DashboardSystemStateInput = {
  readonly observedAt: string;
  readonly guildId: string;
  readonly runtime: RuntimeSystemState | null;
  readonly valkeyConnected: boolean;
  readonly supabaseConnected: boolean;
  readonly dlqDepth: number | null;
  readonly evidence: readonly SystemStateEvidence[];
  readonly credentials: readonly CredentialPresence[];
  readonly recoveryProof?: unknown;
};

const unknownBackup: BackupState = {
  status: 'unknown',
  capturedAt: null,
  checksumSha256: null,
  lastRestoreRehearsalAt: null,
};

function latestEvidence(
  evidence: readonly SystemStateEvidence[],
  actionPrefix: string,
): SystemStateEvidence | null {
  return evidence
    .filter((entry) => entry.action === `${actionPrefix}_succeeded` || entry.action === `${actionPrefix}_failed`)
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)
      || Number(left.success) - Number(right.success))[0] ?? null;
}

function timestampOrNull(value: unknown): string | null {
  const parsed = timestampSchema.safeParse(value);
  return parsed.success ? new Date(parsed.data).toISOString() : null;
}

function backupState(
  evidence: readonly SystemStateEvidence[],
  actionPrefix: string,
  nowMs: number,
): BackupState {
  const entry = latestEvidence(evidence, actionPrefix);
  if (!entry) return { ...unknownBackup };
  const parsedChecksum = checksumSchema.safeParse(entry.details.checksumSha256);
  const checksum = parsedChecksum.success ? parsedChecksum.data.toLowerCase() : null;
  const capturedAt = timestampOrNull(entry.details.capturedAt);
  const captureMs = capturedAt ? Date.parse(capturedAt) : NaN;
  const recordedMs = Date.parse(entry.timestamp);
  const invalid = !entry.success || entry.action !== `${actionPrefix}_succeeded`
    || !checksum || !Number.isFinite(captureMs) || !Number.isFinite(recordedMs)
    || captureMs > recordedMs || recordedMs > nowMs;
  return {
    status: invalid ? 'failed' : nowMs - captureMs >= EVIDENCE_MAX_AGE_MS ? 'stale' : 'current',
    capturedAt,
    checksumSha256: checksum,
    lastRestoreRehearsalAt: null,
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
  const nowMs = Date.parse(input.observedAt);
  const rehearsal = latestEvidence(input.evidence, 'launcher.restore.rehearsal');
  const databaseEntry = latestEvidence(input.evidence, 'launcher.backup.database');
  const databaseBackup = backupState(input.evidence, 'launcher.backup.database', nowMs);
  const valkeyBackup = backupState(input.evidence, 'launcher.backup.valkey', nowMs);
  const parsedProof = recoveryProofSchema.safeParse(input.recoveryProof);
  const proof = parsedProof.success ? parsedProof.data : null;
  const proofMatches = proof !== null && rehearsal !== null && rehearsal.success
    && rehearsal.action === 'launcher.restore.rehearsal_succeeded'
    && databaseBackup.status === 'current' && valkeyBackup.status === 'current'
    && proof.backupId === databaseEntry?.details.backupId && proof.backupId === rehearsal.details.backupId
    && proof.databaseChecksumSha256.toLowerCase() === databaseBackup.checksumSha256
    && proof.valkeyChecksumSha256.toLowerCase() === valkeyBackup.checksumSha256
    && rehearsal.details.checksumSha256 === databaseEntry?.details.checksumSha256
    && rehearsal.details.validated === true
    && timestampOrNull(proof.rehearsedAt) === timestampOrNull(rehearsal.details.rehearsedAt)
    && Date.parse(proof.rehearsedAt) >= Date.parse(databaseBackup.capturedAt ?? '')
    && Date.parse(proof.rehearsedAt) <= Date.parse(rehearsal.timestamp)
    && Date.parse(rehearsal.timestamp) <= nowMs && Date.parse(proof.expiresAt) > nowMs;
  const rehearsalAt = proofMatches && proof ? timestampOrNull(proof.rehearsedAt) : null;
  databaseBackup.lastRestoreRehearsalAt = rehearsalAt;
  const recoveryFailed = databaseBackup.status === 'failed' || valkeyBackup.status === 'failed'
    || (rehearsal !== null && (!rehearsal.success || rehearsal.action.endsWith('_failed')));
  const dependenciesReady = input.valkeyConnected && input.supabaseConnected;
  const mode = runtime?.mode === 'normal' && dependenciesReady ? 'normal' : 'degraded';
  const selectedGuildConditions = runtime?.guildConditions.filter(
    (condition) => condition.guildId === input.guildId,
  );
  const hasSelectedGuildCondition = selectedGuildConditions?.length === 1;
  const fallbackGuildCondition: SystemState['guildConditions'][number] = {
    guildId: input.guildId,
    status: hasSelectedGuildCondition || runtime !== null || dependenciesReady ? 'unknown' : 'degraded',
    conditions: hasSelectedGuildCondition || runtime !== null || dependenciesReady
      ? ['Bot runtime state has not been observed']
      : ['Required runtime provider is unavailable'],
  };

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
      status: recoveryFailed ? 'failed' : proofMatches ? 'ready' : 'unverified',
      lastRehearsalAt: rehearsalAt,
      rehearsalScope: proofMatches ? 'database' : undefined,
      recoveryPointObjectiveMinutes: null,
      recoveryTimeObjectiveMinutes: null,
      evidenceRef: proofMatches && proof ? `recovery:${proof.identity}` : null,
    },
    credentials: input.credentials.map((credential) => credentialMetadata(credential, input.observedAt)),
    guildConditions: hasSelectedGuildCondition ? selectedGuildConditions : [fallbackGuildCondition],
  });
}
