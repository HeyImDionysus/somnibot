import { describe, expect, it } from 'vitest';
import {
  ConfigurationBlueprintSchema,
  DEPLOYMENT_PROFILES,
  InternalContractHeaderSchema,
  NotificationPolicySchema,
  OperatorErrorEnvelopeSchema,
  PRODUCT_TERMINOLOGY,
  STATUS_LANGUAGE,
  ServiceLifecycleController,
  evaluateDeploymentProfile,
  evaluateRollout,
  planNotificationDelivery,
  previewBlueprintApplication,
  selectDeploymentProfile,
} from '../experience/index.js';

const operationId = '11111111-1111-4111-8111-111111111111';

describe('experience engineering contracts', () => {
  it('parses the complete safe operator error envelope', () => {
    const error = OperatorErrorEnvelopeSchema.parse({
      schemaVersion: 1,
      code: 'provider_unavailable',
      safeMessage: 'PayPal is temporarily unavailable.',
      operatorDetail: 'The sandbox provider health check timed out.',
      retryable: true,
      operationId,
      requiredAction: 'Retry after provider health recovers.',
      fieldErrors: [],
      dependencies: [{ key: 'paypal', state: 'unavailable' }],
    });

    expect(error.dependencies).toEqual([{ key: 'paypal', state: 'unavailable' }]);
  });

  it('rejects unsupported internal event contract versions', () => {
    expect(InternalContractHeaderSchema.safeParse({
      schemaVersion: 2,
      operationId: null,
      producer: 'bot',
    }).success).toBe(false);
  });

  it('enforces service lifecycle transitions and recovery', () => {
    const lifecycle = new ServiceLifecycleController('uninitialized');
    lifecycle.transition('initializing');
    lifecycle.transition('ready');
    lifecycle.transition('degraded');
    lifecycle.transition('recovering');
    lifecycle.transition('ready');

    expect(lifecycle.state).toBe('ready');
    expect(() => lifecycle.transition('destroyed')).toThrow('Invalid service lifecycle transition');
  });

  it('gates selected-guild rollouts and emergency disablement', () => {
    expect(evaluateRollout({
      state: 'selected_guild',
      guildIds: ['guild-1'],
      deploymentIds: [],
    }, { guildId: 'guild-1', deploymentId: 'deployment-1' })).toEqual({
      enabled: true,
      reason: 'selected_guild',
    });
    expect(evaluateRollout({
      state: 'emergency_disabled',
      guildIds: ['guild-1'],
      deploymentIds: [],
    }, { guildId: 'guild-1', deploymentId: 'deployment-1' })).toEqual({
      enabled: false,
      reason: 'emergency_disabled',
    });
  });

  it('applies notification audience, cooldown, quiet-hours, and escalation policy', () => {
    const policy = NotificationPolicySchema.parse({
      schemaVersion: 1,
      enabled: true,
      minimumSeverity: 'warning',
      audiences: ['owner', 'support'],
      channels: ['dashboard', 'discord_dm'],
      cooldownSeconds: 300,
      quietHours: { startHourUtc: 22, endHourUtc: 7, bypass: ['critical'] },
      acknowledgementRequired: ['critical'],
      escalation: { afterSeconds: 900, audiences: ['owner'] },
    });

    const plan = planNotificationDelivery(policy, {
      severity: 'critical',
      audience: 'support',
      occurredAt: '2026-08-23T23:00:00.000Z',
      lastDeliveredAt: null,
    });

    expect(plan).toEqual({
      kind: 'deliver',
      channels: ['dashboard', 'discord_dm'],
      acknowledgementRequired: true,
      escalation: { afterSeconds: 900, audiences: ['owner'] },
    });
  });

  it('previews blueprint changes and dependency conflicts before application', () => {
    const blueprint = ConfigurationBlueprintSchema.parse({
      schemaVersion: 1,
      id: 'moderation-strict',
      name: 'Strict moderation',
      domain: 'moderation',
      revision: 3,
      configuration: { enabled: true, threshold: 4 },
      rules: [{
        kind: 'requires_permission',
        feature: 'moderation',
        permission: 'manage_messages',
      }],
      impacts: [{
        resource: { kind: 'discord_channel', id: 'general' },
        effect: 'update',
        reversible: true,
        downstream: [],
      }],
    });

    const preview = previewBlueprintApplication({
      blueprint,
      currentConfiguration: { enabled: false, threshold: 4 },
      operationId,
      environment: {
        activeFeatures: ['moderation'],
        grantedPermissions: [],
        readyProviders: ['discord'],
        activeClaims: [],
      },
    });

    expect(preview.changes).toEqual([{ key: 'enabled', before: false, after: true }]);
    expect(preview.impact.conflicts).toEqual([{
      kind: 'missing_permission',
      blocking: true,
      subject: 'manage_messages',
    }]);
  });

  it('defines and evaluates every supported deployment profile', () => {
    expect(DEPLOYMENT_PROFILES.map((profile) => profile.id)).toEqual([
      'local-single-guild',
      'local-multi-guild',
      'vps-single-guild',
      'vps-multi-guild',
      'higher-load-vps',
    ]);

    expect(evaluateDeploymentProfile('vps-multi-guild', {
      guildCount: 4,
      registeredMembersPerGuild: 10_000,
      cpuCores: 2,
      memoryGiB: 4,
      backupConfigured: false,
    })).toEqual({
      compatible: false,
      blockers: ['cpu_cores', 'memory_gib', 'backup_required'],
      warnings: [],
    });
  });

  it('selects the higher-load profile at 26 guilds and requires fairness evidence', () => {
    const profile = selectDeploymentProfile('vps', 26);
    const compatibility = evaluateDeploymentProfile(profile, {
      guildCount: 26,
      registeredMembersPerGuild: 10_000,
      cpuCores: 8,
      memoryGiB: 16,
      backupConfigured: true,
      fairnessVerified: false,
    });

    expect(profile).toBe('higher-load-vps');
    expect(compatibility.blockers).toEqual(['fairness_verification_required']);
  });

  it('keeps product terms and status language canonical across surfaces', () => {
    expect(PRODUCT_TERMINOLOGY.guild).toEqual({ operator: 'server', diagnostic: 'guild' });
    expect(PRODUCT_TERMINOLOGY.realMoneyStore).toEqual({
      operator: 'real-money store',
      diagnostic: 'commerce',
    });
    expect(STATUS_LANGUAGE.degraded).toEqual({
      label: 'Degraded',
      severity: 'warning',
      actionRequired: true,
    });
    expect(new Set(Object.values(STATUS_LANGUAGE).map((status) => status.label)).size)
      .toBe(Object.keys(STATUS_LANGUAGE).length);
  });
});
