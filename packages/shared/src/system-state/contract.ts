import { z } from 'zod';
import { OperationalModeSchema } from '../capability-manifests/schema.js';
import { DeploymentProfileIdSchema } from '../experience/deployment-profiles.js';

export type OperationalMode = z.infer<typeof OperationalModeSchema>;

export const RuntimeIdentitySchema = z.object({
  lifecycle: z.enum(['starting', 'awaiting_setup', 'ready', 'degraded', 'stopping', 'stopped', 'failed']),
  version: z.string().trim().min(1).max(80),
  exactSha: z.string().regex(/^[0-9a-f]{40}$/i).nullable(),
  bootId: z.string().uuid().nullable(),
  migrationHead: z.string().trim().min(1).max(255).nullable(),
  configurationGeneration: z.number().int().nonnegative().nullable(),
  deploymentProfile: z.union([DeploymentProfileIdSchema, z.literal('unknown')]),
});
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;

export const ProviderStateSchema = z.object({
  key: z.string().trim().min(1).max(80),
  status: z.enum(['ready', 'degraded', 'unavailable', 'not_configured', 'unknown']),
  checkedAt: z.string().datetime().nullable(),
  detail: z.string().trim().max(500).optional(),
});

export const QueueStateSchema = z.object({
  key: z.string().trim().min(1).max(80),
  status: z.enum(['ready', 'backlogged', 'paused', 'unavailable', 'unknown']),
  depth: z.number().int().nonnegative().nullable(),
  oldestAgeMs: z.number().int().nonnegative().nullable(),
});

export const FeatureReadinessSchema = z.object({
  key: z.string().trim().min(1).max(120),
  status: z.enum(['ready', 'degraded', 'blocked', 'disabled', 'unknown']),
  reason: z.string().trim().max(500).optional(),
});

export const BackupStateSchema = z.object({
  status: z.enum(['current', 'stale', 'missing', 'failed', 'unknown']),
  capturedAt: z.string().datetime().nullable(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable(),
  lastRestoreRehearsalAt: z.string().datetime().nullable(),
});
export type BackupState = z.infer<typeof BackupStateSchema>;

export const RecoveryStateSchema = z.object({
  status: z.enum(['ready', 'rehearsal_due', 'recovering', 'failed', 'unverified']),
  lastRehearsalAt: z.string().datetime().nullable(),
  rehearsalScope: z.enum(['database', 'valkey', 'database_and_valkey']).optional(),
  recoveryPointObjectiveMinutes: z.number().int().positive().nullable(),
  recoveryTimeObjectiveMinutes: z.number().int().positive().nullable(),
  evidenceRef: z.string().trim().min(1).max(500).nullable(),
});

export const CredentialMetadataSchema = z.object({
  key: z.string().trim().min(1).max(120),
  present: z.boolean(),
  source: z.enum(['environment', 'os_keychain', 'cloud_vault', 'managed_external', 'none', 'unknown']),
  validity: z.enum(['valid', 'invalid', 'not_checked', 'unknown']),
  observedAt: z.string().datetime(),
  rotatedAt: z.string().datetime().nullable(),
  ageDays: z.number().int().nonnegative().nullable(),
  rotationDueAt: z.string().datetime().nullable(),
});
export type CredentialMetadata = z.infer<typeof CredentialMetadataSchema>;

export const GuildConditionSchema = z.object({
  guildId: z.string().regex(/^\d{17,20}$/),
  status: z.enum(['ready', 'degraded', 'blocked', 'unknown']),
  conditions: z.array(z.string().trim().min(1).max(300)).max(100),
});

export const SystemStateSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.string().datetime(),
  mode: OperationalModeSchema,
  identity: RuntimeIdentitySchema,
  providers: z.array(ProviderStateSchema).max(100),
  queues: z.array(QueueStateSchema).max(100),
  features: z.array(FeatureReadinessSchema).max(500),
  backups: z.object({ database: BackupStateSchema, valkey: BackupStateSchema }),
  recovery: RecoveryStateSchema,
  credentials: z.array(CredentialMetadataSchema).max(100),
  guildConditions: z.array(GuildConditionSchema).max(500),
});
export type SystemState = z.infer<typeof SystemStateSchema>;

export const RuntimeSystemStateSchema = SystemStateSchema.pick({
  schemaVersion: true,
  observedAt: true,
  mode: true,
  identity: true,
  providers: true,
  queues: true,
  features: true,
  guildConditions: true,
});
export type RuntimeSystemState = z.infer<typeof RuntimeSystemStateSchema>;

export const UpgradeGateInputSchema = z.object({
  currentVersion: z.string().trim().min(1).max(80),
  candidateVersion: z.string().trim().min(1).max(80),
  currentSha: z.string().regex(/^[0-9a-f]{40}$/i),
  candidateSha: z.string().regex(/^[0-9a-f]{40}$/i),
  lastKnownGoodSha: z.string().regex(/^[0-9a-f]{40}$/i),
  migrationPrerequisitesMet: z.boolean(),
  sdkProtocolCompatible: z.boolean(),
  providersConfigured: z.boolean(),
  resourcesAvailable: z.boolean(),
  deploymentProfile: DeploymentProfileIdSchema.optional(),
  deploymentCapacity: z.object({
    guildCount: z.number().int().nonnegative(),
    registeredMembersPerGuild: z.number().int().nonnegative(),
    cpuCores: z.number().int().positive(),
    memoryGiB: z.number().int().positive(),
    backupConfigured: z.boolean(),
  }).strict().optional(),
  databaseBackup: BackupStateSchema,
  valkeyBackup: BackupStateSchema,
  expectedDowntimeSeconds: z.number().int().nonnegative(),
  postUpgradeChecks: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
}).superRefine((input, context) => {
  if ((input.deploymentProfile === undefined) !== (input.deploymentCapacity === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Deployment profile and capacity evidence must be supplied together',
      path: ['deploymentProfile'],
    });
  }
});
export type UpgradeGateInput = z.infer<typeof UpgradeGateInputSchema>;

export const UpgradeGateResultSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  status: z.enum(['ready', 'blocked']),
  blockers: z.array(z.object({
    code: z.enum([
      'migration_prerequisites_missing',
      'sdk_protocol_incompatible',
      'provider_configuration_incomplete',
      'resources_unavailable',
      'deployment_profile_incompatible',
      'database_backup_not_current',
      'valkey_backup_not_current',
    ]),
    requiredAction: z.string().trim().min(1).max(500),
  })),
  expectedDowntimeSeconds: z.number().int().nonnegative(),
  postUpgradeChecks: z.array(z.string()),
});
export type UpgradeGateResult = z.infer<typeof UpgradeGateResultSchema>;
