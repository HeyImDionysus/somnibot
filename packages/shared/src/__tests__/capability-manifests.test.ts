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

  it('publishes feature-owned configuration fields instead of dashboard-copy placeholders', () => {
    const music = FEATURE_MANIFESTS.find((manifest) => manifest.identity.id === 'music-playback');
    const payments = FEATURE_MANIFESTS.find((manifest) => manifest.identity.id === 'payments-fulfillment');
    const tickets = FEATURE_MANIFESTS.find((manifest) => manifest.identity.id === 'tickets-transcripts');

    expect(music?.configuration.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'lavalinkNode', valueType: 'identifier', required: true }),
      expect.objectContaining({ key: 'idleDisconnectSeconds', valueType: 'duration', required: true }),
    ]));
    expect(payments?.configuration.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'paypalWebhookId', valueType: 'identifier', required: true }),
      expect.objectContaining({ key: 'fulfillmentRetryLimit', valueType: 'integer', required: true }),
    ]));
    expect(tickets?.configuration.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'panelDefinitions', valueType: 'object-list', required: true }),
      expect.objectContaining({ key: 'transcriptRetentionDays', valueType: 'duration', required: true }),
    ]));
  });

  it('keeps acceptance categories semantically independent for every feature', () => {
    for (const manifest of FEATURE_MANIFESTS) {
      const done = manifest.definitionOfDone;

      expect(done.validStates).not.toEqual(done.primaryJourneys);
      expect(done.persistenceRequirements).not.toEqual(done.dashboardBehavior);
      expect(done.restartAndRecovery).not.toEqual(done.requiredSyntheticEvidence);
      expect(done.cleanupBehavior).not.toEqual(done.crossFeatureInteractions);
    }
  });

  it('requires domain-specific live evidence for unlike feature families', () => {
    const byId = new Map(FEATURE_MANIFESTS.map((manifest) => [manifest.identity.id, manifest]));

    expect(byId.get('music-playback')?.definitionOfDone.requiredLiveEvidence).toEqual([
      'Real Discord voice playback is audibly confirmed through play, queue advance, stop, and three disconnect cycles.',
    ]);
    expect(byId.get('payments-fulfillment')?.definitionOfDone.requiredLiveEvidence).toEqual([
      'Exact-SHA PayPal Sandbox checkout, signed webhook, delivery, reversal, and readback all succeed.',
    ]);
    expect(byId.get('server-setup-sync')?.definitionOfDone.requiredLiveEvidence).toEqual([
      'A disposable target guild is configured through dashboard and bot while source remains unchanged.',
    ]);
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
    const duplicateField = {
      key: 'duplicateKey',
      valueType: 'string' as const,
      required: true,
      purpose: 'Prove duplicate field names are rejected.',
    };

    expect(() => FeatureManifestCatalogSchema.parse([first, first])).toThrow();
    expect(() => FeatureManifestCatalogSchema.parse([{ schemaVersion: 1 }])).toThrow();
    expect(() => FeatureManifestCatalogSchema.parse([{
      ...first,
      authority: { ...first.authority, sourceReferences: ['surface:dashboard:/invented'] },
    }])).toThrow();
    expect(() => FeatureManifestCatalogSchema.parse([{
      ...first,
      configuration: {
        ...first.configuration,
        fields: [duplicateField, duplicateField],
      },
    }])).toThrow();
    expect(() => FeatureManifestCatalogSchema.parse([{
      ...first,
      definitionOfDone: {
        ...first.definitionOfDone,
        validStates: first.definitionOfDone.primaryJourneys,
      },
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
