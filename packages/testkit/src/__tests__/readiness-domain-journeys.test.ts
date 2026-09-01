import { loadDefaultCatalog } from '@somnibot/e2e';
import { describe, expect, it } from 'vitest';

import { buildDomainAcceptanceContracts } from '../readiness/domain-acceptance.js';
import {
  CROSS_DOMAIN_JOURNEYS,
  crossDomainJourneyObservations,
} from '../readiness/cross-domain-journeys.js';

describe('domain-specific acceptance and cross-domain journeys', () => {
  it('derives a distinct acceptance contract from every authoritative domain', async () => {
    // Given
    const catalog = await loadDefaultCatalog();

    // When
    const contracts = buildDomainAcceptanceContracts(catalog);

    // Then
    expect(contracts).toHaveLength(46);
    expect(new Set(contracts.map((contract) => contract.domainId)).size).toBe(46);
    expect(contracts.every((contract) => contract.validStates.length > 0)).toBe(true);
    expect(contracts.every((contract) => contract.invalidAndFailurePaths.length > 0)).toBe(true);
    expect(contracts.every((contract) => contract.permissionBoundaries.length > 0)).toBe(true);
    expect(contracts.every((contract) => contract.cleanupBehavior.length > 0)).toBe(true);
  });

  it('executes the required cross-domain journeys and keeps their live gates explicit', async () => {
    // Given
    const required = [
      'onboarding-to-progression', 'community-to-economy', 'moderation-to-appeal',
      'automation-with-moderation', 'purchase-to-revocation',
      'provider-failure-during-fulfillment', 'restore-to-member-and-commerce',
    ];

    // When
    const observations = await crossDomainJourneyObservations();

    // Then
    expect(CROSS_DOMAIN_JOURNEYS.map((journey) => journey.id)).toEqual(required);
    expect(observations.every((observation) => observation.status === 'SYNTHETIC_PASS')).toBe(true);
    expect(observations.every((observation) => observation.requiredLiveEvidence !== null)).toBe(true);
    expect(observations.every((observation) => observation.observation.includes('operation audits'))).toBe(true);
  });
});
