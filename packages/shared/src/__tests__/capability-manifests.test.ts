import { describe, expect, it } from 'vitest';
import {
  FEATURE_MANIFESTS,
  FeatureManifestCatalogSchema,
  findManifestOwners,
} from '../capability-manifests/index.js';

describe('authoritative capability manifests', () => {
  it('parses the complete catalog and assigns every manifest a distinct identity', () => {
    const catalog = FeatureManifestCatalogSchema.parse(FEATURE_MANIFESTS);
    const identities = catalog.map((manifest) => manifest.identity.id);

    expect(new Set(identities).size).toBe(identities.length);
    expect(catalog.length).toBeGreaterThan(40);
  });

  it('keeps each feature definition of done behavior-specific', () => {
    const signatures = FEATURE_MANIFESTS.map((manifest) => JSON.stringify(manifest.definitionOfDone));

    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it('returns exactly one owner for every declared surface', () => {
    for (const manifest of FEATURE_MANIFESTS) {
      for (const kind of ['dashboardRoutes', 'portalRoutes', 'botFeatures', 'scenarioProofs', 'discordCommands'] as const) {
        for (const surface of manifest.surfaces[kind]) {
          expect(findManifestOwners(kind, surface)).toEqual([manifest.identity.id]);
        }
      }
    }
  });

  it('rejects duplicate ownership and incomplete feature contracts at the schema boundary', () => {
    const first = FEATURE_MANIFESTS[0];

    expect(() => FeatureManifestCatalogSchema.parse([first, first])).toThrow();
    expect(() => FeatureManifestCatalogSchema.parse([{ schemaVersion: 1 }])).toThrow();
    expect(() => FeatureManifestCatalogSchema.parse([{
      ...first,
      authority: { ...first.authority, sourceReferences: ['surface:dashboard:/invented'] },
    }])).toThrow();
  });

  it('contains source-backed feature facts instead of domain template fallbacks', () => {
    const serialized = JSON.stringify(FEATURE_MANIFESTS);
    const forbiddenTemplates = [
      'enabled state and feature policy',
      '.operation.completed',
      '.last-success',
      'Feature operations complete within the feature-specific interaction budget.',
    ];

    for (const template of forbiddenTemplates) {
      expect(serialized).not.toContain(template);
    }
    for (const manifest of FEATURE_MANIFESTS) {
      expect(manifest.relationships.conflicts).not.toContain(
        `Concurrent ${manifest.identity.name} mutations targeting the same resource`,
      );
      expect(manifest.authority.sourceReferences.length).toBeGreaterThan(0);
      expect(manifest.authority.sourceReferences.every((reference) => reference.startsWith('surface:'))).toBe(true);
    }
  });
});
