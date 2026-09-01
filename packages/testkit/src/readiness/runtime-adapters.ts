import {
  WorkloadScheduler,
  workloadForAction,
  type WorkloadClass,
} from '@somnibot/bot/dist/services/workload-scheduler.js';

export type RuntimeWork = {
  readonly id: string;
  readonly guildId: string;
  readonly action: string;
  readonly operationId: string;
};

export type RuntimeExecution = {
  readonly work: RuntimeWork;
  readonly replayed: boolean;
  readonly durableMutations: number;
  readonly externalEffects: number;
  readonly auditEvents: number;
  readonly pendingRecovery: boolean;
  readonly conflictDetected: boolean;
};

export type InjectedFailure =
  | 'none'
  | 'timeout-before-commit'
  | 'provider-rate-limit'
  | 'partial-fulfillment'
  | 'shutdown-after-commit'
  | 'optimistic-conflict';

export interface RuntimeStorageAdapter {
  claim(work: RuntimeWork): Promise<'claimed' | 'replay' | 'conflict'>;
  markEffect(operationId: string): Promise<boolean>;
  appendAudit(operationId: string): Promise<void>;
  markPending(operationId: string): Promise<void>;
  snapshot(): RuntimeStorageSnapshot;
}

export type RuntimeStorageSnapshot = {
  readonly claims: number;
  readonly effects: number;
  readonly audits: number;
  readonly pending: number;
  readonly conflicts: number;
};

export class InMemoryRuntimeStorage implements RuntimeStorageAdapter {
  private readonly claims = new Set<string>();
  private readonly effects = new Set<string>();
  private readonly audits = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly conflictKeys = new Set<string>();
  private conflicts = 0;

  async claim(work: RuntimeWork): Promise<'claimed' | 'replay' | 'conflict'> {
    if (this.claims.has(work.operationId)) return 'replay';
    if (this.conflictKeys.has(work.operationId)) {
      this.conflicts += 1;
      return 'conflict';
    }
    this.claims.add(work.operationId);
    return 'claimed';
  }

  async markEffect(operationId: string): Promise<boolean> {
    const existed = this.effects.has(operationId);
    this.effects.add(operationId);
    return !existed;
  }

  async appendAudit(operationId: string): Promise<void> {
    this.audits.add(operationId);
  }

  async markPending(operationId: string): Promise<void> {
    this.pending.add(operationId);
  }

  seedConflict(operationId: string): void {
    this.conflictKeys.add(operationId);
  }

  snapshot(): RuntimeStorageSnapshot {
    return {
      claims: this.claims.size,
      effects: this.effects.size,
      audits: this.audits.size,
      pending: this.pending.size,
      conflicts: this.conflicts,
    };
  }
}

export class RuntimeWorkflowExecutor {
  constructor(
    private readonly storage: RuntimeStorageAdapter,
    private readonly scheduler: WorkloadScheduler = new WorkloadScheduler(),
  ) {}

  execute(work: RuntimeWork, failure: InjectedFailure = 'none'): Promise<RuntimeExecution> {
    return this.scheduler.run(
      workloadForAction(work.action),
      work.guildId,
      async () => this.executeClaimed(work, failure),
    );
  }

  close(): Promise<void> {
    this.scheduler.close();
    return this.scheduler.drain();
  }

  activeCount(workload: WorkloadClass): number {
    return this.scheduler.activeCount(workload);
  }

  queuedCount(workload: WorkloadClass): number {
    return this.scheduler.queuedCount(workload);
  }

  private async executeClaimed(
    work: RuntimeWork,
    failure: InjectedFailure,
  ): Promise<RuntimeExecution> {
    if (failure === 'timeout-before-commit') {
      await this.storage.markPending(work.operationId);
      return this.result(work, false, true, false);
    }
    const claim = await this.storage.claim(work);
    if (claim === 'replay') return this.result(work, true, false, false);
    if (claim === 'conflict' || failure === 'optimistic-conflict') {
      await this.storage.appendAudit(work.operationId);
      return this.result(work, false, false, true);
    }
    if (failure === 'provider-rate-limit') {
      await this.storage.appendAudit(work.operationId);
      await this.storage.markPending(work.operationId);
      return this.result(work, false, true, false);
    }
    const effectApplied = await this.storage.markEffect(work.operationId);
    await this.storage.appendAudit(work.operationId);
    if (failure === 'partial-fulfillment' || failure === 'shutdown-after-commit') {
      await this.storage.markPending(work.operationId);
    }
    const snapshot = this.storage.snapshot();
    return {
      work,
      replayed: false,
      durableMutations: 1,
      externalEffects: effectApplied ? 1 : 0,
      auditEvents: snapshot.audits > 0 ? 1 : 0,
      pendingRecovery: failure === 'partial-fulfillment' || failure === 'shutdown-after-commit',
      conflictDetected: false,
    };
  }

  private result(
    work: RuntimeWork,
    replayed: boolean,
    pendingRecovery: boolean,
    conflictDetected: boolean,
  ): RuntimeExecution {
    const snapshot = this.storage.snapshot();
    return {
      work,
      replayed,
      durableMutations: replayed ? 0 : snapshot.claims > 0 ? 1 : 0,
      externalEffects: 0,
      auditEvents: snapshot.audits > 0 ? 1 : 0,
      pendingRecovery,
      conflictDetected,
    };
  }
}
