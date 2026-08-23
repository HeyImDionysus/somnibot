import { COMMERCE_MANIFESTS } from './catalog/commerce.js';
import { COMMUNITY_MANIFESTS } from './catalog/community.js';
import { ECONOMY_MANIFESTS } from './catalog/economy.js';
import { INFRASTRUCTURE_MANIFESTS, MUSIC_MANIFESTS } from './catalog/infrastructure.js';
import { MODERATION_MANIFESTS } from './catalog/moderation.js';
import { OPERATIONS_MANIFESTS } from './catalog/operations.js';
import { FEATURE_COMMANDS } from './command-ownership.js';
import { FeatureManifestCatalogSchema } from './schema.js';

export {
  DataGovernanceSchema,
  FeatureDefinitionOfDoneSchema,
  FeatureDomainSchema,
  FeatureManifestCatalogSchema,
  FeatureManifestSchema,
  IntendedUserSchema,
  OperationalModeSchema,
} from './schema.js';
export type {
  FeatureDomain,
  FeatureManifest,
  IntendedUser,
} from './schema.js';

const MANIFEST_SEEDS = [
  ...COMMUNITY_MANIFESTS,
  ...ECONOMY_MANIFESTS,
  ...MODERATION_MANIFESTS,
  ...OPERATIONS_MANIFESTS,
  ...COMMERCE_MANIFESTS,
  ...INFRASTRUCTURE_MANIFESTS,
  ...MUSIC_MANIFESTS,
];

export const FEATURE_MANIFESTS = FeatureManifestCatalogSchema.parse(
  MANIFEST_SEEDS.map((manifest) => ({
    ...manifest,
    surfaces: {
      ...manifest.surfaces,
      discordCommands: FEATURE_COMMANDS[manifest.identity.id] ?? [],
    },
  })),
);

export type ManifestSurfaceKind = 'dashboardRoutes' | 'portalRoutes' | 'botFeatures' | 'scenarioProofs' | 'discordCommands';

export function findManifestOwners(kind: ManifestSurfaceKind, surface: string): readonly string[] {
  return FEATURE_MANIFESTS
    .filter((manifest) => manifest.surfaces[kind].includes(surface))
    .map((manifest) => manifest.identity.id);
}
