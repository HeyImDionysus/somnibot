declare module '@somnibot/bot/dist/services/workload-scheduler.js' {
  export const WORKLOAD_CLASSES: readonly [
    'moderation',
    'commerce',
    'music',
    'administration',
    'automation',
    'economy',
  ];

  export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];

  export function workloadForAction(action: string): WorkloadClass;

  export class WorkloadScheduler {
    constructor(budgets?: Readonly<Record<WorkloadClass, number>>);
    activeCount(workload: WorkloadClass): number;
    queuedCount(workload: WorkloadClass): number;
    run<T>(workload: WorkloadClass, guildId: string, task: () => Promise<T>): Promise<T>;
    close(): void;
    drain(): Promise<void>;
  }
}
