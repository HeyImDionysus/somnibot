import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CREDENTIAL_PROVIDERS,
  CriticalAuditWriteError,
  CredentialInventoryEntrySchema,
  PRIVACY_AGGREGATION_MINIMUM,
  PrivacyMetricInputSchema,
  TRUST_BOUNDARIES,
  TrustBoundaryCatalogSchema,
  evaluateTenantAccess,
  assertCriticalAuditWriteSucceeded,
  executeTenantScoped,
  executeGovernedDataAction,
  parseTenantCacheValue,
  serializeTenantCacheValue,
  toPrivacySafeMetric,
} from '../governance/index.js';
import {
  DataGovernanceSchema,
  FEATURE_MANIFESTS,
} from '../capability-manifests/index.js';

describe('trust-boundary governance', () => {
  it('defines every external or privileged boundary exactly once', () => {
    const catalog = TrustBoundaryCatalogSchema.parse(TRUST_BOUNDARIES);

    expect(catalog.map((boundary) => boundary.id).sort()).toEqual([
      'agent-sdk',
      'dashboard-session',
      'discord',
      'downloads',
      'launcher-storage',
      'oauth',
      'paypal',
      'portal-token',
      'supabase',
      'valkey',
      'vps',
    ]);
    expect(new Set(catalog.map((boundary) => boundary.id)).size).toBe(catalog.length);
    expect(catalog.every((boundary) => boundary.failClosed)).toBe(true);
  });

  it('rejects credential inventory entries that contain secret material', () => {
    const valid = CredentialInventoryEntrySchema.safeParse({
      credentialId: 'paypal-client-secret',
      provider: 'paypal',
      presence: 'present',
      source: 'environment',
      validity: 'valid',
      ageDays: 12,
      rotationDueAt: '2026-09-01T00:00:00.000Z',
    });
    const leaked = CredentialInventoryEntrySchema.safeParse({
      credentialId: 'paypal-client-secret',
      provider: 'paypal',
      presence: 'present',
      source: 'environment',
      validity: 'valid',
      ageDays: 12,
      rotationDueAt: null,
      value: 'secret-material',
    });

    expect(valid.success).toBe(true);
    expect(leaked.success).toBe(false);
    expect(CREDENTIAL_PROVIDERS).toContain('discord');
  });
});

describe('feature data governance', () => {
  it('attaches a complete strict governance policy to every feature manifest', () => {
    for (const manifest of FEATURE_MANIFESTS) {
      const governance = DataGovernanceSchema.parse(manifest.dataGovernance);

      expect(governance.exportBehavior.length).toBeGreaterThan(0);
      expect(governance.erasureBehavior.length).toBeGreaterThan(0);
      expect(governance.anonymization.length).toBeGreaterThan(0);
      expect(governance.backupImplications.length).toBeGreaterThan(0);
    }
  });

  it('requires a matching operation receipt for export and erasure hooks', async () => {
    const policy = DataGovernanceSchema.parse(FEATURE_MANIFESTS[0]?.dataGovernance);

    await expect(executeGovernedDataAction(
      policy,
      { action: 'erasure', operationId: 'privacy-123' },
      async () => ({ operationId: 'other-operation', affectedRecords: 2, retainedRecords: 1 }),
    )).rejects.toMatchObject({ name: 'GovernanceReceiptError', operationId: 'privacy-123' });
  });
});

describe('continuous tenant isolation', () => {
  it('allows a same-guild and same-customer background-job read', () => {
    expect(evaluateTenantAccess(
      { guildId: 'guild-a', customerId: 'customer-a' },
      { guildId: 'guild-a', customerId: 'customer-a', resourceType: 'entitlement', resourceId: 'ent-a' },
    )).toEqual({ allowed: true });
  });

  it('denies cross-guild access before cache, undo, or background-job work can run', () => {
    expect(evaluateTenantAccess(
      { guildId: 'guild-a', customerId: 'customer-a' },
      { guildId: 'guild-b', customerId: 'customer-a', resourceType: 'cache-entry', resourceId: 'cache-a' },
    )).toEqual({ allowed: false, reason: 'guild_mismatch' });
    expect(evaluateTenantAccess(
      { guildId: 'guild-a', customerId: 'customer-a' },
      { guildId: 'guild-a', customerId: 'customer-b', resourceType: 'undo-record', resourceId: 'undo-a' },
    )).toEqual({ allowed: false, reason: 'customer_mismatch' });
  });

  it('does not execute background work for a foreign tenant resource', async () => {
    let executions = 0;

    const result = await executeTenantScoped(
      { guildId: 'guild-a' },
      { guildId: 'guild-b', resourceType: 'background-job', resourceId: 'job-1' },
      async () => {
        executions += 1;
        return 'ran';
      },
    );

    expect(result).toEqual({ status: 'denied', reason: 'guild_mismatch' });
    expect(executions).toBe(0);
  });

  it('rejects a cached payload whose embedded tenant differs from the reader', () => {
    const cached = serializeTenantCacheValue(
      { guildId: 'guild-b' },
      'sync-config',
      { enabled: true },
    );

    expect(parseTenantCacheValue(
      cached,
      { guildId: 'guild-a' },
      z.object({ enabled: z.boolean() }).strict(),
    )).toEqual({ status: 'denied', reason: 'guild_mismatch' });
  });
});

describe('privacy-conscious product analytics', () => {
  it('suppresses small cohorts and emits only aggregate dimensions', () => {
    const suppressed = toPrivacySafeMetric({
      metric: 'sdk-conformance-completed',
      count: PRIVACY_AGGREGATION_MINIMUM - 1,
      dimensions: { deploymentProfile: 'vps-single-guild', featureDomain: 'infrastructure' },
    });
    const visible = toPrivacySafeMetric({
      metric: 'setup-track-completed',
      count: PRIVACY_AGGREGATION_MINIMUM,
      dimensions: { deploymentProfile: 'local-single-guild', featureDomain: 'community' },
    });

    expect(suppressed).toEqual({ metric: 'sdk-conformance-completed', suppressed: true });
    expect(visible).toEqual({
      metric: 'setup-track-completed',
      suppressed: false,
      count: PRIVACY_AGGREGATION_MINIMUM,
      dimensions: { deploymentProfile: 'local-single-guild', featureDomain: 'community' },
    });
  });

  it('rejects personal identifiers and free-form analytics dimensions', () => {
    expect(PrivacyMetricInputSchema.safeParse({
      metric: 'feature-opened',
      count: 20,
      dimensions: { userId: '123' },
    }).success).toBe(false);
    expect(PrivacyMetricInputSchema.safeParse({
      metric: 'feature-opened',
      count: 20,
      dimensions: { arbitrary: 'free-form' },
    }).success).toBe(false);
  });
});

describe('critical audit enforcement', () => {
  it('preserves the operation identity when a critical audit write fails', () => {
    expect(() => assertCriticalAuditWriteSucceeded('operation-123', 'database unavailable'))
      .toThrowError(new CriticalAuditWriteError('operation-123', 'database unavailable'));
  });

  it('accepts a successful critical audit write', () => {
    expect(() => assertCriticalAuditWriteSucceeded('operation-123', null)).not.toThrow();
  });
});
