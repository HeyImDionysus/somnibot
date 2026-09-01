import {
  WORKLOAD_CLASSES,
  WorkloadScheduler,
  type WorkloadClass,
} from '@somnibot/bot/dist/services/workload-scheduler.js';

import type { ProofObservation } from './contracts.js';

export { WORKLOAD_CLASSES, type WorkloadClass };

export type WorkItem = {
  readonly id: string;
  readonly workload: WorkloadClass;
  readonly guildId: string;
};

export type FairnessResult = {
  readonly admitted: readonly WorkItem[];
  readonly rejected: readonly WorkItem[];
  readonly maximumCriticalWait: number;
  readonly perGuildAdmissions: Readonly<Record<string, number>>;
  readonly peakActive: Readonly<Record<WorkloadClass, number>>;
  readonly elapsedMilliseconds: number;
};

export async function runFairScheduling(
  items: readonly WorkItem[],
  capacity: number,
): Promise<FairnessResult> {
  const scheduler = new WorkloadScheduler({
    moderation: 1,
    commerce: 1,
    music: 1,
    administration: 1,
    automation: 1,
    economy: 1,
  });
  const started: WorkItem[] = [];
  const peakActive: Record<WorkloadClass, number> = {
    moderation: 0,
    commerce: 0,
    music: 0,
    administration: 0,
    automation: 0,
    economy: 0,
  };
  const startedAt = performance.now();
  await Promise.all(items.map((item) => scheduler.run(item.workload, item.guildId, async () => {
    started.push(item);
    peakActive[item.workload] = Math.max(
      peakActive[item.workload],
      scheduler.activeCount(item.workload),
    );
    await Promise.resolve();
  })));
  scheduler.close();
  await scheduler.drain();
  const admitted = started.slice(0, capacity);
  const admittedIds = new Set(admitted.map((item) => item.id));
  const rejected = items.filter((item) => !admittedIds.has(item.id));
  const perGuildAdmissions: Record<string, number> = {};
  for (const item of admitted) {
    perGuildAdmissions[item.guildId] = (perGuildAdmissions[item.guildId] ?? 0) + 1;
  }
  const criticalPositions = admitted.flatMap((item, index) =>
    item.workload === 'moderation' || item.workload === 'commerce' ? [index] : []
  );
  return {
    admitted,
    rejected,
    maximumCriticalWait: criticalPositions.length > 0 ? Math.max(...criticalPositions) : 0,
    perGuildAdmissions,
    peakActive,
    elapsedMilliseconds: Math.max(performance.now() - startedAt, Number.EPSILON),
  };
}

export function fairnessObservation(result: FairnessResult): ProofObservation {
  const criticalAdmitted = result.admitted.some(
    (item) => item.workload === 'moderation' || item.workload === 'commerce',
  );
  return {
    id: 'fairness-noisy-neighbor',
    status: criticalAdmitted && result.maximumCriticalWait < 8 ? 'SYNTHETIC_PASS' : 'FAIL',
    evidenceMode: 'synthetic',
    observation: `Production scheduler admitted ${result.admitted.length} items in ${result.elapsedMilliseconds.toFixed(3)}ms; maximum critical position ${result.maximumCriticalWait}.`,
    requiredLiveEvidence: 'Load the deployed queues across multiple guilds and confirm moderation and commerce latency while economy and automation are saturated.',
  };
}
