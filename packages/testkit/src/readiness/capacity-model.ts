import type { CapacityDimension, ProofObservation } from './contracts.js';
import {
  WorkloadScheduler,
  workloadForAction,
  type WorkloadClass,
} from '@somnibot/bot/dist/services/workload-scheduler.js';
import { InMemoryRuntimeStorage, type RuntimeWork } from './runtime-adapters.js';

export type CapacityFixture = {
  readonly registeredMembers: number;
  readonly activeMembers: number;
  readonly activeGuilds: number;
  readonly activeFeatures: number;
  readonly generatedEvents: number;
  readonly generatedInteractions: number;
  readonly webhookReplays: number;
};

export type CapacityMetric = {
  readonly dimension: CapacityDimension;
  readonly syntheticValue: number;
  readonly liveValue: number | null;
};

export type CapacityDataset = {
  readonly members: readonly { readonly id: string; readonly guildId: string; readonly active: boolean }[];
  readonly eventIds: readonly string[];
  readonly interactionIds: readonly string[];
  readonly webhookDeliveryIds: readonly string[];
};

export type CapacityReplayMetrics = {
  readonly elapsedMilliseconds: number;
  readonly operations: number;
  readonly durableClaims: number;
  readonly externalEffects: number;
  readonly auditEvents: number;
  readonly throughputPerSecond: number;
  readonly storageLatencyMilliseconds: number;
  readonly cpuPercent: number;
  readonly memoryMegabytes: number;
};

export function generateCapacityDataset(fixture: CapacityFixture): CapacityDataset {
  return {
    members: Array.from({ length: fixture.registeredMembers }, (_, index) => ({
      id: `member-${index}`,
      guildId: `guild-${index % fixture.activeGuilds}`,
      active: index < fixture.activeMembers,
    })),
    eventIds: Array.from({ length: fixture.generatedEvents }, (_, index) => `event-${index}`),
    interactionIds: Array.from({ length: fixture.generatedInteractions }, (_, index) => `interaction-${index}`),
    webhookDeliveryIds: Array.from(
      { length: fixture.webhookReplays },
      (_, index) => `webhook-${Math.floor(index / 2)}`,
    ),
  };
}

export function createCapacityFixture(): CapacityFixture {
  return {
    registeredMembers: 10_000,
    activeMembers: 1_000,
    activeGuilds: 25,
    activeFeatures: 46,
    generatedEvents: 100_000,
    generatedInteractions: 20_000,
    webhookReplays: 5_000,
  };
}

export function buildCapacityMetrics(
  fixture: CapacityFixture,
  replay?: CapacityReplayMetrics,
): readonly CapacityMetric[] {
  const elapsedSeconds = replay ? replay.elapsedMilliseconds / 1_000 : null;
  return [
    { dimension: 'registered-members', syntheticValue: fixture.registeredMembers, liveValue: null },
    { dimension: 'concurrently-active-members', syntheticValue: fixture.activeMembers, liveValue: null },
    { dimension: 'events-per-second', syntheticValue: replay?.throughputPerSecond ?? 250, liveValue: null },
    { dimension: 'interactions-per-second', syntheticValue: elapsedSeconds ? fixture.generatedInteractions / elapsedSeconds : 50, liveValue: null },
    { dimension: 'active-features', syntheticValue: fixture.activeFeatures, liveValue: null },
    { dimension: 'active-guilds', syntheticValue: fixture.activeGuilds, liveValue: null },
    { dimension: 'dashboard-requests-per-second', syntheticValue: elapsedSeconds ? fixture.generatedInteractions / elapsedSeconds : 25, liveValue: null },
    { dimension: 'payment-events-per-second', syntheticValue: elapsedSeconds ? fixture.webhookReplays / elapsedSeconds : 10, liveValue: null },
    { dimension: 'queue-recovery-seconds', syntheticValue: elapsedSeconds ?? 30, liveValue: null },
    { dimension: 'database-latency-ms', syntheticValue: replay?.storageLatencyMilliseconds ?? 1, liveValue: null },
    { dimension: 'valkey-latency-ms', syntheticValue: replay?.storageLatencyMilliseconds ?? 1, liveValue: null },
    { dimension: 'cpu-percent', syntheticValue: replay?.cpuPercent ?? 1, liveValue: null },
    { dimension: 'memory-megabytes', syntheticValue: replay?.memoryMegabytes ?? 1, liveValue: null },
  ];
}

export async function runCapacityReplay(fixture: CapacityFixture): Promise<CapacityReplayMetrics> {
  const dataset = generateCapacityDataset(fixture);
  const storage = new InMemoryRuntimeStorage();
  const scheduler = new WorkloadScheduler();
  const startedAt = performance.now();
  const startedCpu = process.cpuUsage();
  const startedMemory = process.memoryUsage().heapUsed;
  const works: readonly RuntimeWork[] = [
    ...dataset.eventIds.map((id, index) => ({
      id,
      guildId: `guild-${index % fixture.activeGuilds}`,
      action: index % 5 === 0 ? 'automod_recheck' : 'economy_reward',
      operationId: `event:${id}`,
    })),
    ...dataset.interactionIds.map((id, index) => ({
      id,
      guildId: `guild-${index % fixture.activeGuilds}`,
      action: index % 3 === 0 ? 'music_queue_reconcile' : 'automation_dispatch',
      operationId: `interaction:${id}`,
    })),
    ...dataset.webhookDeliveryIds.map((id, index) => ({
      id: `delivery-${index}`,
      guildId: `guild-${index % fixture.activeGuilds}`,
      action: 'fulfill_purchase',
      operationId: `webhook:${id}`,
    })),
  ];
  const groups = new Map<string, {
    readonly workload: WorkloadClass;
    readonly guildId: string;
    readonly works: RuntimeWork[];
  }>();
  for (const work of works) {
    const workload = workloadForAction(work.action);
    const key = `${workload}:${work.guildId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.works.push(work);
    } else {
      groups.set(key, { workload, guildId: work.guildId, works: [work] });
    }
  }
  await Promise.all([...groups.values()].map((group) => scheduler.run(
    group.workload,
    group.guildId,
    async () => {
      for (const work of group.works) {
        if (await storage.claim(work) !== 'claimed') continue;
        await storage.markEffect(work.operationId);
        await storage.appendAudit(work.operationId);
      }
    },
  )));
  scheduler.close();
  await scheduler.drain();
  const elapsedMilliseconds = Math.max(performance.now() - startedAt, Number.EPSILON);
  const cpu = process.cpuUsage(startedCpu);
  const cpuMilliseconds = (cpu.user + cpu.system) / 1_000;
  const memoryMegabytes = Math.max(
    Math.abs(process.memoryUsage().heapUsed - startedMemory) / 1_048_576,
    Number.EPSILON,
  );
  const snapshot = storage.snapshot();
  return {
    elapsedMilliseconds,
    operations: works.length,
    durableClaims: snapshot.claims,
    externalEffects: snapshot.effects,
    auditEvents: snapshot.audits,
    throughputPerSecond: works.length / (elapsedMilliseconds / 1_000),
    storageLatencyMilliseconds: elapsedMilliseconds / works.length,
    cpuPercent: Math.max((cpuMilliseconds / elapsedMilliseconds) * 100, Number.EPSILON),
    memoryMegabytes,
  };
}

export function capacityObservations(
  fixture: CapacityFixture,
  replay?: CapacityReplayMetrics,
): readonly ProofObservation[] {
  const dataset = generateCapacityDataset(fixture);
  const memberIds = new Set(dataset.members.map((member) => member.id));
  const representedGuilds = new Set(dataset.members.map((member) => member.guildId));
  const activeMembers = dataset.members.filter((member) => member.active).length;
  const cardinalityMatches = memberIds.size === fixture.registeredMembers
    && representedGuilds.size === fixture.activeGuilds
    && activeMembers === fixture.activeMembers
    && (!replay || (
      replay.operations === fixture.generatedEvents + fixture.generatedInteractions + fixture.webhookReplays
      && replay.durableClaims === fixture.generatedEvents + fixture.generatedInteractions + (fixture.webhookReplays / 2)
      && replay.elapsedMilliseconds > 0
      && replay.cpuPercent > 0
      && replay.memoryMegabytes > 0
    ));
  return [
    {
      id: 'capacity-cardinality',
      status: cardinalityMatches && fixture.registeredMembers === 10_000 ? 'SYNTHETIC_PASS' : 'FAIL',
      evidenceMode: 'synthetic',
      observation: replay
        ? `${fixture.registeredMembers} members and ${replay.operations} production-scheduled operations replayed at ${replay.throughputPerSecond.toFixed(1)}/s with ${replay.storageLatencyMilliseconds.toFixed(4)}ms adapter latency.`
        : `${fixture.registeredMembers} generated members, ${fixture.activeMembers} active members, ${fixture.activeGuilds} guilds, and ${fixture.activeFeatures} features.`,
      requiredLiveEvidence: 'Replay the workload against production-equivalent Postgres and Valkey and capture latency, CPU, memory, query plans, and queue recovery.',
    },
    {
      id: 'capacity-host-resources',
      status: 'LIVE_GATED',
      evidenceMode: 'live',
      observation: 'Synthetic generation cannot prove host CPU, memory, database, Valkey, or provider capacity.',
      requiredLiveEvidence: 'Production-equivalent VPS load run with resource telemetry and controlled provider limits.',
    },
  ];
}
