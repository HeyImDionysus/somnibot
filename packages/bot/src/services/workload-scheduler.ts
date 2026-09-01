export const WORKLOAD_CLASSES = [
  'moderation',
  'commerce',
  'music',
  'administration',
  'automation',
  'economy',
] as const;

export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];

export const WORKLOAD_CONCURRENCY: Readonly<Record<WorkloadClass, number>> = {
  moderation: 4,
  commerce: 4,
  music: 3,
  administration: 4,
  automation: 1,
  economy: 1,
};

const ACTION_WORKLOAD_PREFIXES: Readonly<Record<WorkloadClass, readonly string[]>> = {
  moderation: ['automod_', 'moderation_', 'infraction_', 'appeal_'],
  commerce: [
    'fulfill_',
    'deliver_receipt',
    'revoke_roles',
    'reconcile_entitlement_roles',
    'notify_giveaway_winner',
  ],
  music: ['music_'],
  administration: [],
  automation: ['automation_'],
  economy: [
    'market_',
    'economy_',
    'crafting_',
    'farming_',
    'fishing_',
    'gathering_',
    'adventure_',
    'quest_',
    'achievement_',
  ],
};

export class WorkloadSchedulerClosedError extends Error {
  constructor() {
    super('WorkloadScheduler is closed');
    this.name = 'WorkloadSchedulerClosedError';
  }
}

type WorkItem = {
  readonly guildId: string;
  readonly execute: () => Promise<void>;
};

export function workloadForAction(action: string): WorkloadClass {
  for (const workload of WORKLOAD_CLASSES) {
    if (workload === 'administration') continue;
    const prefixes = ACTION_WORKLOAD_PREFIXES[workload];
    if (prefixes.some((prefix) => action === prefix || action.startsWith(prefix))) {
      return workload;
    }
  }
  return 'administration';
}

export class WorkloadScheduler {
  private readonly budgets: Readonly<Record<WorkloadClass, number>>;
  private readonly active = new Map<WorkloadClass, number>();
  private readonly waiters = new Map<WorkloadClass, WorkItem[]>();
  private readonly lastGuild = new Map<WorkloadClass, string>();
  private readonly drainWaiters: Array<() => void> = [];
  private closed = false;

  constructor(budgets: Readonly<Record<WorkloadClass, number>> = WORKLOAD_CONCURRENCY) {
    this.budgets = budgets;
    for (const workload of WORKLOAD_CLASSES) {
      this.active.set(workload, 0);
      this.waiters.set(workload, []);
    }
  }

  activeCount(workload: WorkloadClass): number {
    return this.active.get(workload) ?? 0;
  }

  queuedCount(workload: WorkloadClass): number {
    return this.waiters.get(workload)?.length ?? 0;
  }

  run<T>(workload: WorkloadClass, guildId: string, task: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new WorkloadSchedulerClosedError());
    return new Promise<T>((resolve, reject) => {
      const queue = this.waiters.get(workload);
      if (!queue) {
        reject(new WorkloadSchedulerClosedError());
        return;
      }
      queue.push({
        guildId,
        execute: async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          }
        },
      });
      this.dispatch(workload);
    });
  }

  close(): void {
    this.closed = true;
  }

  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  private dispatch(workload: WorkloadClass): void {
    const queue = this.waiters.get(workload);
    if (!queue) return;
    const budget = this.budgets[workload];
    while ((this.active.get(workload) ?? 0) < budget && queue.length > 0) {
      const index = this.nextGuildIndex(workload, queue);
      const next = queue.splice(index, 1)[0];
      if (!next) return;
      this.lastGuild.set(workload, next.guildId);
      this.active.set(workload, (this.active.get(workload) ?? 0) + 1);
      void next.execute().finally(() => {
        this.active.set(workload, (this.active.get(workload) ?? 1) - 1);
        this.dispatch(workload);
        this.resolveDrainIfIdle();
      });
    }
  }

  private nextGuildIndex(workload: WorkloadClass, queue: readonly WorkItem[]): number {
    const previousGuild = this.lastGuild.get(workload);
    if (!previousGuild) return 0;
    const alternative = queue.findIndex((item) => item.guildId !== previousGuild);
    return alternative >= 0 ? alternative : 0;
  }

  private isIdle(): boolean {
    return WORKLOAD_CLASSES.every(
      (workload) => this.activeCount(workload) === 0 && this.queuedCount(workload) === 0,
    );
  }

  private resolveDrainIfIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
