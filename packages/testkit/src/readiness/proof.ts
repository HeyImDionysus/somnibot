import { capacityObservations, createCapacityFixture, runCapacityReplay } from './capacity-model.js';
import {
  CAPACITY_DIMENSIONS,
  SERVICE_OBJECTIVES,
  type ReliabilityProof,
} from './contracts.js';
import { crossDomainJourneyObservations } from './cross-domain-journeys.js';
import { runExecutableFailureMatrix } from './failure-injection.js';
import { fairnessObservation, runFairScheduling, type WorkloadClass } from './fairness-model.js';
import { storageAuditObservations } from './storage-audit.js';

export async function buildReliabilityProof(): Promise<ReliabilityProof> {
  const flood = Array.from({ length: 240 }, (_, index) => ({
    id: `economy-${index}`,
    workload: 'economy' as WorkloadClass,
    guildId: `guild-${index % 3}`,
  }));
  const critical = [
    { id: 'moderation-1', workload: 'moderation' as WorkloadClass, guildId: 'guild-4' },
    { id: 'commerce-1', workload: 'commerce' as WorkloadClass, guildId: 'guild-5' },
  ];
  const fixture = createCapacityFixture();
  const [failures, journeys, fairness, capacityReplay] = await Promise.all([
    runExecutableFailureMatrix(),
    crossDomainJourneyObservations(),
    runFairScheduling([...flood, ...critical], 30),
    runCapacityReplay(fixture),
  ]);

  return {
    schemaVersion: '1.0.0',
    memberTarget: 10_000,
    capacityDimensions: CAPACITY_DIMENSIONS,
    serviceObjectives: SERVICE_OBJECTIVES,
    observations: [
      ...failures,
      ...journeys,
      ...capacityObservations(fixture, capacityReplay),
      fairnessObservation(fairness),
      ...storageAuditObservations(),
    ],
  };
}
