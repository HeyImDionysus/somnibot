import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_MANIFESTS, findManifestOwners } from '@somnibot/shared';
import { describe, expect, it } from 'vitest';
import { discoverCapabilitySurfaces } from '../capability-manifests/discover-surfaces.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, '../../../..');
const discovered = discoverCapabilitySurfaces(REPOSITORY_ROOT);

describe('capability manifest surface coverage', () => {
  it.each([
    ['dashboardRoutes', discovered.dashboardRoutes],
    ['portalRoutes', discovered.portalRoutes],
    ['botFeatures', discovered.botFeatures],
    ['scenarioProofs', discovered.scenarioProofs],
    ['discordCommands', discovered.discordCommands],
  ] as const)('assigns every discovered %s surface to exactly one manifest', (kind, surfaces) => {
    for (const surface of surfaces) {
      expect(findManifestOwners(kind, surface), `Missing or duplicate owner for ${surface}`).toHaveLength(1);
    }
  });

  it('contains no stale surface declarations', () => {
    const declared = {
      dashboardRoutes: FEATURE_MANIFESTS.flatMap((manifest) => manifest.surfaces.dashboardRoutes).sort(),
      portalRoutes: FEATURE_MANIFESTS.flatMap((manifest) => manifest.surfaces.portalRoutes).sort(),
      botFeatures: FEATURE_MANIFESTS.flatMap((manifest) => manifest.surfaces.botFeatures).sort(),
      scenarioProofs: FEATURE_MANIFESTS.flatMap((manifest) => manifest.surfaces.scenarioProofs).sort(),
      discordCommands: FEATURE_MANIFESTS.flatMap((manifest) => manifest.surfaces.discordCommands).sort(),
    };

    expect(declared).toEqual({
      dashboardRoutes: discovered.dashboardRoutes,
      portalRoutes: discovered.portalRoutes,
      botFeatures: discovered.botFeatures,
      scenarioProofs: discovered.scenarioProofs,
      discordCommands: discovered.discordCommands,
    });
  });

  it('rejects fabricated database ownership', () => {
    const declaredTables = FEATURE_MANIFESTS.flatMap((manifest) => manifest.databaseOwnership.tables);
    const staleTables = declaredTables.filter((table) => !discovered.databaseTables.includes(table));

    expect(staleTables).toEqual([]);
  });

  it('binds every authoritative source reference to a discovered owned surface', () => {
    for (const manifest of FEATURE_MANIFESTS) {
      const expected = [
        ...manifest.surfaces.dashboardRoutes.map((surface) => `surface:dashboard:${surface}`),
        ...manifest.surfaces.portalRoutes.map((surface) => `surface:portal:${surface}`),
        ...manifest.surfaces.botFeatures.map((surface) => `surface:bot-feature:${surface}`),
        ...manifest.surfaces.scenarioProofs.map((surface) => `surface:scenario-proof:${surface}`),
      ];

      expect(manifest.authority.sourceReferences).toEqual(expected);
    }
  });
});
