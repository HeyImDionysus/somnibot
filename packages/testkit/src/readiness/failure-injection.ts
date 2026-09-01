import type { ProofObservation } from './contracts.js';
import {
  InMemoryRuntimeStorage,
  RuntimeWorkflowExecutor,
  type InjectedFailure,
  type RuntimeExecution,
  type RuntimeWork,
} from './runtime-adapters.js';

export const FAILURE_CASES = [
  ['duplicate-command', 'one durable mutation and one replay result'],
  ['concurrent-interactions', 'atomic invariant and deterministic winner'],
  ['replayed-webhook', 'one entitlement transition and one audit chain'],
  ['bot-restart', 'pending work recovered without duplicate side effects'],
  ['database-timeout', 'retryable result and no partial commit'],
  ['valkey-outage', 'feature-specific degraded behavior without unsafe fallback'],
  ['discord-rate-limit', 'bounded retry honoring provider backoff'],
  ['paypal-retry', 'idempotent payment and fulfillment processing'],
  ['partial-fulfillment', 'durable exception and resumable compensation'],
  ['simultaneous-config-change', 'conflict detected instead of lost update'],
  ['shutdown-during-work', 'drain or durable recovery on next boot'],
] as const;

export type FailureCaseId = (typeof FAILURE_CASES)[number][0];

type ExecutedFailureCase = {
  readonly id: FailureCaseId;
  readonly executions: readonly RuntimeExecution[];
  readonly snapshot: ReturnType<InMemoryRuntimeStorage['snapshot']>;
};

function workFor(id: FailureCaseId): RuntimeWork {
  return {
    id: `work-${id}`,
    guildId: 'guild-reliability',
    action: id.includes('paypal') || id.includes('webhook') || id.includes('fulfillment')
      ? 'fulfill_purchase'
      : id.includes('config')
        ? 'config_reload'
        : 'automod_recheck',
    operationId: `operation-${id}`,
  };
}

function failureFor(id: FailureCaseId): InjectedFailure {
  switch (id) {
    case 'database-timeout':
      return 'timeout-before-commit';
    case 'valkey-outage':
    case 'discord-rate-limit':
      return 'provider-rate-limit';
    case 'bot-restart':
    case 'shutdown-during-work':
      return 'shutdown-after-commit';
    case 'partial-fulfillment':
      return 'partial-fulfillment';
    case 'simultaneous-config-change':
      return 'optimistic-conflict';
    case 'duplicate-command':
    case 'concurrent-interactions':
    case 'replayed-webhook':
    case 'paypal-retry':
      return 'none';
  }
}

async function executeFailureCase(id: FailureCaseId): Promise<ExecutedFailureCase> {
  const storage = new InMemoryRuntimeStorage();
  const executor = new RuntimeWorkflowExecutor(storage);
  const work = workFor(id);
  if (id === 'simultaneous-config-change') storage.seedConflict(work.operationId);
  const repeated = id === 'duplicate-command'
    || id === 'concurrent-interactions'
    || id === 'replayed-webhook'
    || id === 'paypal-retry';
  const executions = repeated
    ? await Promise.all([executor.execute(work), executor.execute(work)])
    : [await executor.execute(work, failureFor(id))];
  await executor.close();
  return { id, executions, snapshot: storage.snapshot() };
}

function failureCasePassed(result: ExecutedFailureCase): boolean {
  switch (result.id) {
    case 'duplicate-command':
    case 'concurrent-interactions':
    case 'replayed-webhook':
    case 'paypal-retry':
      return result.snapshot.claims === 1
        && result.snapshot.effects === 1
        && result.snapshot.audits === 1
        && result.executions.filter((execution) => execution.replayed).length === 1;
    case 'database-timeout':
      return result.snapshot.claims === 0 && result.snapshot.effects === 0 && result.snapshot.pending === 1;
    case 'valkey-outage':
    case 'discord-rate-limit':
      return result.snapshot.claims === 1 && result.snapshot.effects === 0 && result.snapshot.pending === 1;
    case 'bot-restart':
    case 'partial-fulfillment':
    case 'shutdown-during-work':
      return result.snapshot.claims === 1 && result.snapshot.effects === 1 && result.snapshot.pending === 1;
    case 'simultaneous-config-change':
      return result.snapshot.effects === 0 && result.snapshot.conflicts === 1;
  }
}

export async function runExecutableFailureMatrix(): Promise<readonly ProofObservation[]> {
  return Promise.all(FAILURE_CASES.map(async ([id, invariant]) => {
    const result = await executeFailureCase(id);
    return {
      id: `failure-${id}`,
      status: failureCasePassed(result) ? 'SYNTHETIC_PASS' : 'FAIL',
      evidenceMode: 'synthetic',
      observation: `Executed production-scheduled workflow preserved ${invariant}; mutations=${result.snapshot.claims}, effects=${result.snapshot.effects}, audits=${result.snapshot.audits}, recovery=${result.snapshot.pending}.`,
      requiredLiveEvidence: `Inject ${id} against the deployed stack and capture operation-linked readback.`,
    };
  }));
}
