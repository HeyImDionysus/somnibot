import { describe, expect, it } from 'vitest';

import {
  buildCapacityMetrics,
  createCapacityFixture,
  generateCapacityDataset,
  runCapacityReplay,
} from '../readiness/capacity-model.js';
import { CAPACITY_DIMENSIONS, SERVICE_OBJECTIVES } from '../readiness/contracts.js';
import { buildReliabilityProof } from '../readiness/proof.js';

describe('reliability capacity contract', () => {
  it('models the 10,000-member target across independent dimensions', () => {
    // Given
    const fixture = createCapacityFixture();

    // When
    const metrics = buildCapacityMetrics(fixture);
    const dataset = generateCapacityDataset(fixture);

    // Then
    expect(fixture.registeredMembers).toBe(10_000);
    expect(dataset.members).toHaveLength(10_000);
    expect(new Set(dataset.members.map((member) => member.id)).size).toBe(10_000);
    expect(dataset.members.filter((member) => member.active)).toHaveLength(1_000);
    expect(new Set(dataset.members.map((member) => member.guildId)).size).toBe(25);
    expect(dataset.eventIds).toHaveLength(100_000);
    expect(dataset.interactionIds).toHaveLength(20_000);
    expect(new Set(dataset.webhookDeliveryIds).size).toBe(2_500);
    expect(metrics.map((metric) => metric.dimension)).toEqual(CAPACITY_DIMENSIONS);
    expect(metrics.every((metric) => metric.liveValue === null)).toBe(true);
  });

  it('keeps feature-specific service objectives instead of one universal target', () => {
    // Given
    const targetPairs = SERVICE_OBJECTIVES.map((objective) => `${objective.feature}:${objective.target}:${objective.unit}`);

    // When
    const uniqueTargets = new Set(targetPairs);

    // Then
    expect(uniqueTargets.size).toBeGreaterThan(5);
    expect(SERVICE_OBJECTIVES.find((objective) => objective.feature === 'music')?.target).toBe(1_500);
    expect(SERVICE_OBJECTIVES.find((objective) => objective.metric === 'backup-age')?.unit).toBe('hours');
  });

  it('replays the full synthetic workload through production queue and storage adapters', async () => {
    const fixture = createCapacityFixture();

    const replay = await runCapacityReplay(fixture);
    const metrics = buildCapacityMetrics(fixture, replay);

    expect(replay.operations).toBe(125_000);
    expect(replay.durableClaims).toBe(122_500);
    expect(replay.externalEffects).toBe(122_500);
    expect(replay.auditEvents).toBe(122_500);
    expect(replay.elapsedMilliseconds).toBeGreaterThan(0);
    expect(replay.throughputPerSecond).toBeGreaterThan(0);
    expect(replay.storageLatencyMilliseconds).toBeGreaterThan(0);
    expect(replay.cpuPercent).toBeGreaterThan(0);
    expect(replay.memoryMegabytes).toBeGreaterThan(0);
    expect(metrics.every((metric) => metric.syntheticValue > 0)).toBe(true);
  });

  it('never presents synthetic host metrics or storage audits as live passes', async () => {
    // Given
    const proof = await buildReliabilityProof();

    // When
    const liveObservations = proof.observations.filter((observation) => observation.evidenceMode === 'live');

    // Then
    expect(liveObservations.length).toBeGreaterThan(0);
    expect(liveObservations.every((observation) => observation.status === 'LIVE_GATED')).toBe(true);
    expect(proof.observations.every((observation) => observation.requiredLiveEvidence !== '')).toBe(true);
  });
});
