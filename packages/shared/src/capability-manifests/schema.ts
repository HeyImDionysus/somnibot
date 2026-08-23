import { z } from 'zod';

const IdentifierSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const NonEmptyTextSchema = z.string().trim().min(1);
const NonEmptyListSchema = z.array(NonEmptyTextSchema).min(1);

export const FeatureDomainSchema = z.enum([
  'administration',
  'automation',
  'commerce',
  'community',
  'economy',
  'infrastructure',
  'moderation',
  'music',
]);

export const IntendedUserSchema = z.enum([
  'owner',
  'administrator',
  'moderator',
  'finance',
  'support',
  'member',
  'customer',
]);

export const OperationalModeSchema = z.enum([
  'normal',
  'degraded',
  'read-only',
  'commerce-paused',
  'maintenance',
  'recovering',
  'emergency-shutdown',
]);

export const DataGovernanceSchema = z.object({
  personalData: z.array(NonEmptyTextSchema),
  purpose: NonEmptyTextSchema,
  retention: NonEmptyTextSchema,
  exportBehavior: NonEmptyTextSchema,
  erasureBehavior: NonEmptyTextSchema,
  anonymization: NonEmptyTextSchema,
  auditRetention: NonEmptyTextSchema,
  commerceRetention: NonEmptyTextSchema,
  cleanup: NonEmptyTextSchema,
  backupImplications: NonEmptyTextSchema,
}).strict();

export const FeatureDefinitionOfDoneSchema = z.object({
  primaryJourneys: NonEmptyListSchema,
  validStates: NonEmptyListSchema,
  invalidStates: NonEmptyListSchema,
  permissionBoundaries: NonEmptyListSchema,
  discordBehavior: NonEmptyListSchema,
  dashboardBehavior: NonEmptyListSchema,
  persistenceRequirements: NonEmptyListSchema,
  restartAndRecovery: NonEmptyListSchema,
  errorPaths: NonEmptyListSchema,
  cleanupBehavior: NonEmptyListSchema,
  requiredSyntheticEvidence: NonEmptyListSchema,
  requiredLiveEvidence: NonEmptyListSchema,
  crossFeatureInteractions: NonEmptyListSchema,
}).strict();

export const FeatureManifestSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.object({
    sourceReferences: NonEmptyListSchema,
    factPolicy: z.literal('Only facts represented by owned repository surfaces are authoritative; absent facts are not inferred.'),
  }).strict(),
  identity: z.object({
    id: IdentifierSchema,
    name: NonEmptyTextSchema,
    domain: FeatureDomainSchema,
    summary: NonEmptyTextSchema,
  }).strict(),
  intendedUsers: z.array(IntendedUserSchema).min(1),
  surfaces: z.object({
    dashboardRoutes: z.array(NonEmptyTextSchema),
    portalRoutes: z.array(NonEmptyTextSchema),
    botFeatures: z.array(IdentifierSchema),
    scenarioProofs: z.array(IdentifierSchema),
    discordCommands: z.array(NonEmptyTextSchema),
    discordEvents: z.array(NonEmptyTextSchema),
    discordInteractions: z.array(NonEmptyTextSchema),
  }).strict(),
  configuration: z.object({
    schemaOwner: NonEmptyTextSchema,
    settings: z.array(NonEmptyTextSchema),
  }).strict(),
  relationships: z.object({
    dependencies: z.array(IdentifierSchema),
    conflicts: z.array(NonEmptyTextSchema),
  }).strict(),
  permissions: z.object({
    dashboard: NonEmptyListSchema,
    discord: NonEmptyListSchema,
    providers: z.array(NonEmptyTextSchema),
  }).strict(),
  runtimeServices: NonEmptyListSchema,
  databaseOwnership: z.object({
    tables: z.array(NonEmptyTextSchema),
    writeAuthority: NonEmptyTextSchema,
  }).strict(),
  observability: z.object({
    auditEvents: z.array(NonEmptyTextSchema),
    healthSignals: NonEmptyListSchema,
  }).strict(),
  recovery: z.object({
    behavior: NonEmptyTextSchema,
    compensation: NonEmptyTextSchema,
  }).strict(),
  definitionOfDone: FeatureDefinitionOfDoneSchema,
  serviceObjectives: z.array(z.object({
    signal: NonEmptyTextSchema,
    target: NonEmptyTextSchema,
    measurement: NonEmptyTextSchema,
  }).strict()).min(1),
  operationalModes: z.array(z.object({
    mode: OperationalModeSchema,
    behavior: NonEmptyTextSchema,
  }).strict()).min(2),
  dataGovernance: DataGovernanceSchema,
}).strict().superRefine((manifest, context) => {
  const ownedSurfaceCount = manifest.surfaces.dashboardRoutes.length
    + manifest.surfaces.portalRoutes.length
    + manifest.surfaces.botFeatures.length
    + manifest.surfaces.scenarioProofs.length;
  if (ownedSurfaceCount === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['surfaces'],
      message: 'A feature manifest must own at least one discoverable product surface.',
    });
  }
  const expectedReferences = [
    ...manifest.surfaces.dashboardRoutes.map((surface) => `surface:dashboard:${surface}`),
    ...manifest.surfaces.portalRoutes.map((surface) => `surface:portal:${surface}`),
    ...manifest.surfaces.botFeatures.map((surface) => `surface:bot-feature:${surface}`),
    ...manifest.surfaces.scenarioProofs.map((surface) => `surface:scenario-proof:${surface}`),
  ];
  if (JSON.stringify(manifest.authority.sourceReferences) !== JSON.stringify(expectedReferences)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authority', 'sourceReferences'],
      message: 'Authority references must exactly match the manifest owned repository surfaces.',
    });
  }
  if (!manifest.authority.sourceReferences.includes(manifest.configuration.schemaOwner)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['configuration', 'schemaOwner'],
      message: 'Configuration ownership must resolve to an authoritative owned repository surface.',
    });
  }
});

export const FeatureManifestCatalogSchema = z.array(FeatureManifestSchema).min(1).superRefine(
  (catalog, context) => {
    const identityOwners = new Map<string, number>();
    const surfaceOwners = new Map<string, string>();
    catalog.forEach((manifest, index) => {
      const previousIdentity = identityOwners.get(manifest.identity.id);
      if (previousIdentity !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'identity', 'id'],
          message: `Duplicate feature identity also declared at catalog index ${previousIdentity}.`,
        });
      }
      identityOwners.set(manifest.identity.id, index);

      const surfaces = [
        ...manifest.surfaces.dashboardRoutes.map((surface) => `dashboardRoutes:${surface}`),
        ...manifest.surfaces.portalRoutes.map((surface) => `portalRoutes:${surface}`),
        ...manifest.surfaces.botFeatures.map((surface) => `botFeatures:${surface}`),
        ...manifest.surfaces.scenarioProofs.map((surface) => `scenarioProofs:${surface}`),
        ...manifest.surfaces.discordCommands.map((surface) => `discordCommands:${surface}`),
      ];
      for (const surface of surfaces) {
        const previousOwner = surfaceOwners.get(surface);
        if (previousOwner) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'surfaces'],
            message: `Surface "${surface}" is already owned by "${previousOwner}".`,
          });
        } else {
          surfaceOwners.set(surface, manifest.identity.id);
        }
      }
    });
  },
);

export type FeatureManifest = z.infer<typeof FeatureManifestSchema>;
export type FeatureDomain = z.infer<typeof FeatureDomainSchema>;
export type IntendedUser = z.infer<typeof IntendedUserSchema>;
