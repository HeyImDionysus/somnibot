import type { FeatureDomain, FeatureManifest, IntendedUser } from './schema.js';
import { getFeatureContract } from './feature-contracts.js';
import { FeatureManifestSchema } from './schema.js';

type FeatureSurfaces = {
  readonly dashboardRoutes?: readonly string[];
  readonly portalRoutes?: readonly string[];
  readonly botFeatures?: readonly string[];
  readonly scenarioProofs?: readonly string[];
  readonly commands?: readonly string[];
  readonly events?: readonly string[];
  readonly interactions?: readonly string[];
};

export type FeatureSeed = {
  readonly id: string;
  readonly name: string;
  readonly domain: FeatureDomain;
  readonly summary: string;
  readonly users: readonly IntendedUser[];
  readonly surfaces: FeatureSurfaces;
  readonly journey: string;
  readonly invalidState: string;
  readonly discordBehavior: string;
  readonly dashboardBehavior: string;
  readonly syntheticEvidence: string;
  readonly liveEvidence: string;
  readonly crossFeature: string;
  readonly dependencies?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly permissions?: readonly string[];
  readonly services?: readonly string[];
  readonly tables?: readonly string[];
  readonly auditEvents?: readonly string[];
  readonly healthSignals?: readonly string[];
  readonly slo?: {
    readonly signal: string;
    readonly target: string;
    readonly measurement: string;
  };
};

type PermissionProfile = {
  readonly dashboardPermission: string;
  readonly discordPermission: string;
  readonly retention: string;
};

const PERMISSION_PROFILES: Readonly<Record<FeatureDomain, PermissionProfile>> = {
  administration: {
    dashboardPermission: 'Authorized operator role for the affected guild',
    discordPermission: 'ManageGuild where Discord state changes',
    retention: 'Operational records follow the configured audit-retention policy.',
  },
  automation: {
    dashboardPermission: 'Administrator automation-management scope',
    discordPermission: 'Permissions required by each configured action',
    retention: 'Execution history is retained according to automation audit policy.',
  },
  commerce: {
    dashboardPermission: 'Owner or finance commerce-management scope',
    discordPermission: 'ManageRoles only for Discord fulfillment',
    retention: 'Financial records follow merchant and legal retention requirements.',
  },
  community: {
    dashboardPermission: 'Administrator community-configuration scope',
    discordPermission: 'Feature-specific channel and role permissions',
    retention: 'Community data follows guild retention and member-erasure policy.',
  },
  economy: {
    dashboardPermission: 'Administrator economy-configuration scope',
    discordPermission: 'SendMessages and UseApplicationCommands',
    retention: 'Economy ledgers persist while the guild uses the economy feature.',
  },
  infrastructure: {
    dashboardPermission: 'Owner deployment and recovery scope',
    discordPermission: 'Application-owner authority where Discord is involved',
    retention: 'Operational state is retained through the configured recovery window.',
  },
  moderation: {
    dashboardPermission: 'Moderator or administrator moderation scope',
    discordPermission: 'ModerateMembers and feature-specific enforcement permissions',
    retention: 'Moderation records follow guild policy and legal erasure constraints.',
  },
  music: {
    dashboardPermission: 'Administrator music-configuration scope',
    discordPermission: 'Connect, Speak, and UseApplicationCommands',
    retention: 'Queue history is short-lived unless audit policy requires retention.',
  },
};

export function buildFeatureManifest(seed: FeatureSeed): FeatureManifest {
  const profile = PERMISSION_PROFILES[seed.domain];
  const featureContract = getFeatureContract(seed.id);
  const routes = seed.surfaces.dashboardRoutes ?? [];
  const portalRoutes = seed.surfaces.portalRoutes ?? [];
  const botFeatures = seed.surfaces.botFeatures ?? [];
  const scenarioProofs = seed.surfaces.scenarioProofs ?? [];
  const sourceReferences = [
    ...routes.map((route) => `surface:dashboard:${route}`),
    ...portalRoutes.map((route) => `surface:portal:${route}`),
    ...botFeatures.map((feature) => `surface:bot-feature:${feature}`),
    ...scenarioProofs.map((proof) => `surface:scenario-proof:${proof}`),
  ];
  const ownedRuntimeServices = [
    ...botFeatures.map((feature) => `bot feature ${feature}`),
    ...routes.map((route) => `dashboard route ${route}`),
    ...portalRoutes.map((route) => `portal route ${route}`),
  ];
  const auditEvents = seed.auditEvents ?? [];
  const healthSignals = seed.healthSignals ?? [seed.syntheticEvidence, seed.liveEvidence];

  return FeatureManifestSchema.parse({
    schemaVersion: 1,
    authority: {
      sourceReferences,
      factPolicy: 'Only facts represented by owned repository surfaces are authoritative; absent facts are not inferred.',
    },
    identity: {
      id: seed.id,
      name: seed.name,
      domain: seed.domain,
      summary: seed.summary,
    },
    intendedUsers: seed.users,
    surfaces: {
      dashboardRoutes: routes,
      portalRoutes,
      botFeatures,
      scenarioProofs,
      discordCommands: seed.surfaces.commands ?? [],
      discordEvents: seed.surfaces.events ?? [],
      discordInteractions: seed.surfaces.interactions ?? [],
    },
    configuration: {
      schemaOwner: sourceReferences[0],
      fields: featureContract.configurationFields,
    },
    relationships: {
      dependencies: seed.dependencies ?? [],
      conflicts: seed.conflicts ?? [seed.invalidState],
    },
    permissions: {
      dashboard: seed.permissions ?? [profile.dashboardPermission],
      discord: [profile.discordPermission],
      providers: seed.domain === 'commerce' ? ['PayPal permission only for payment-bearing operations'] : [],
    },
    runtimeServices: seed.services ?? ownedRuntimeServices,
    databaseOwnership: {
      tables: seed.tables ?? [],
      writeAuthority: seed.tables
        ? `${seed.name} owns writes to the declared tables within the selected guild or customer scope.`
        : `${seed.name} declares no dedicated table ownership; shared persistence remains owned by the feature that declares it.`,
    },
    observability: {
      auditEvents,
      healthSignals,
    },
    recovery: {
      behavior: featureContract.restartAndRecovery.join(' '),
      compensation: featureContract.cleanupBehavior.join(' '),
    },
    definitionOfDone: {
      primaryJourneys: [seed.journey],
      validStates: featureContract.validStates,
      invalidStates: [seed.invalidState],
      permissionBoundaries: [`Authorized roles: ${seed.users.join(', ')}. Dashboard: ${(seed.permissions ?? [profile.dashboardPermission]).join('; ')}. Discord: ${profile.discordPermission}.`],
      discordBehavior: [seed.discordBehavior],
      dashboardBehavior: [seed.dashboardBehavior],
      persistenceRequirements: featureContract.persistenceRequirements,
      restartAndRecovery: featureContract.restartAndRecovery,
      errorPaths: [seed.invalidState],
      cleanupBehavior: featureContract.cleanupBehavior,
      requiredSyntheticEvidence: [seed.syntheticEvidence],
      requiredLiveEvidence: [seed.liveEvidence],
      crossFeatureInteractions: [seed.crossFeature],
    },
    serviceObjectives: [seed.slo ?? {
      signal: seed.liveEvidence,
      target: seed.discordBehavior,
      measurement: seed.syntheticEvidence,
    }],
    operationalModes: [
      { mode: 'normal', behavior: seed.journey },
      { mode: 'degraded', behavior: seed.invalidState },
      { mode: 'maintenance', behavior: seed.liveEvidence },
    ],
    dataGovernance: {
      personalData: seed.domain === 'infrastructure' ? [] : ['Guild-scoped Discord identifiers used by the feature'],
      purpose: `Operate and verify ${seed.name} for the selected guild.`,
      retention: profile.retention,
      exportBehavior: `${seed.name} owned data is included in authorized guild exports.`,
      erasureBehavior: `Member-linked ${seed.name} data is erased or anonymized unless retention law overrides erasure.`,
      anonymization: `Analytics remove direct identifiers when ${seed.name} no longer needs attribution.`,
      auditRetention: `${seed.name} audit evidence follows the configured tamper-evident audit policy.`,
      commerceRetention: seed.domain === 'commerce'
        ? 'Merchant records remain separate from entitlement state and follow commerce retention policy.'
        : 'This feature does not create payment records.',
      cleanup: `${seed.name} cleanup is guild-scoped, idempotent, and recorded.`,
      backupImplications: `${seed.name} configuration and durable state are included in backup and restore rehearsal coverage.`,
    },
  });
}
