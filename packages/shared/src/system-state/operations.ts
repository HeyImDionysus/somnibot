import { randomUUID } from 'node:crypto';
import {
  UpgradeGateInputSchema,
  UpgradeGateResultSchema,
  type UpgradeGateInput,
  type UpgradeGateResult,
} from './contract.js';
import { evaluateDeploymentProfile } from '../experience/deployment-profiles.js';

type UpgradeBlocker = UpgradeGateResult['blockers'][number];

const SECRET_KEY = /(?:authorization|cookie|password|secret|token|key|credential)/i;
const SECRET_ASSIGNMENT = /((?:PASSWORD|SECRET|TOKEN|API_KEY|WEBHOOK_ID|PRIVATE_KEY)\s*[=:]\s*)([^\s,;]+)/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const SUPABASE_SECRET = /sb_secret_[A-Za-z0-9._-]+/g;
const REDIS_PASSWORD = /(redis(?:s)?:\/\/:)[^@/]+(@)/gi;

function redactString(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, '$1[redacted]')
    .replace(BEARER, '$1[redacted]')
    .replace(SUPABASE_SECRET, '[redacted-supabase-secret]')
    .replace(REDIS_PASSWORD, '$1[redacted]$2');
}

export function redactDiagnosticValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactDiagnosticValue(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactDiagnosticValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function backupBlocker(
  backup: UpgradeGateInput['databaseBackup'],
  code: Extract<UpgradeBlocker['code'], 'database_backup_not_current' | 'valkey_backup_not_current'>,
  label: string,
): UpgradeBlocker | null {
  if (backup.status === 'current' && backup.checksumSha256 !== null && backup.lastRestoreRehearsalAt !== null) {
    return null;
  }
  return {
    code,
    requiredAction: `${label} must have a current checksum-verified snapshot and restore rehearsal before upgrade.`,
  };
}

export function evaluateUpgradeGate(rawInput: UpgradeGateInput): UpgradeGateResult {
  const input = UpgradeGateInputSchema.parse(rawInput);
  const blockers: UpgradeBlocker[] = [];
  if (!input.migrationPrerequisitesMet) {
    blockers.push({
      code: 'migration_prerequisites_missing',
      requiredAction: 'Apply and verify required database migrations before upgrade.',
    });
  }
  if (!input.sdkProtocolCompatible) {
    blockers.push({
      code: 'sdk_protocol_incompatible',
      requiredAction: 'Reintegrate stale SDK products or use a protocol-compatible release.',
    });
  }
  if (!input.providersConfigured) {
    blockers.push({
      code: 'provider_configuration_incomplete',
      requiredAction: 'Complete required provider configuration and reachability checks.',
    });
  }
  if (!input.resourcesAvailable) {
    blockers.push({
      code: 'resources_unavailable',
      requiredAction: 'Provision the CPU, memory, disk, and queue capacity required by the selected profile.',
    });
  }
  if (input.deploymentProfile !== undefined && input.deploymentCapacity !== undefined) {
    const compatibility = evaluateDeploymentProfile(input.deploymentProfile, input.deploymentCapacity);
    if (!compatibility.compatible) {
      blockers.push({
        code: 'deployment_profile_incompatible',
        requiredAction: `Resolve deployment profile blockers: ${compatibility.blockers.join(', ')}.`,
      });
    }
  }
  const databaseBackup = backupBlocker(input.databaseBackup, 'database_backup_not_current', 'Database backup');
  if (databaseBackup) blockers.push(databaseBackup);
  const valkeyBackup = backupBlocker(input.valkeyBackup, 'valkey_backup_not_current', 'Valkey backup');
  if (valkeyBackup) blockers.push(valkeyBackup);

  return UpgradeGateResultSchema.parse({
    schemaVersion: 1,
    operationId: randomUUID(),
    status: blockers.length === 0 ? 'ready' : 'blocked',
    blockers,
    expectedDowntimeSeconds: input.expectedDowntimeSeconds,
    postUpgradeChecks: input.postUpgradeChecks,
  });
}
