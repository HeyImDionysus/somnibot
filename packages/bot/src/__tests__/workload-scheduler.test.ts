import { describe, expect, it } from 'vitest';

import {
  WorkloadScheduler,
  workloadForAction,
} from '../services/workload-scheduler.js';

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    release: () => resolvePromise?.(),
  };
}

describe('production workload scheduler', () => {
  it('classifies queue actions into operational workload classes', () => {
    expect(workloadForAction('fulfill_purchase')).toBe('commerce');
    expect(workloadForAction('automod_recheck')).toBe('moderation');
    expect(workloadForAction('music_queue_reconcile')).toBe('music');
    expect(workloadForAction('automation_dispatch')).toBe('automation');
    expect(workloadForAction('market_item_reconcile')).toBe('economy');
    expect(workloadForAction('config_reload')).toBe('administration');
  });

  it('admits critical work while economy work is backpressured', async () => {
    const scheduler = new WorkloadScheduler({
      moderation: 1,
      commerce: 1,
      music: 1,
      administration: 1,
      automation: 1,
      economy: 1,
    });
    const economyGate = deferred();
    const economy = Array.from({ length: 8 }, (_, index) =>
      scheduler.run('economy', `guild-${index % 2}`, async () => economyGate.promise),
    );

    await Promise.resolve();
    expect(scheduler.activeCount('economy')).toBe(1);
    expect(scheduler.queuedCount('economy')).toBe(7);

    const admitted: string[] = [];
    await Promise.all([
      scheduler.run('moderation', 'guild-moderation', async () => {
        admitted.push('moderation');
      }),
      scheduler.run('commerce', 'guild-commerce', async () => {
        admitted.push('commerce');
      }),
    ]);

    expect(admitted).toEqual(['moderation', 'commerce']);
    economyGate.release();
    await Promise.all(economy);
  });

  it('round-robins guilds inside a saturated workload', async () => {
    const scheduler = new WorkloadScheduler({
      moderation: 1,
      commerce: 1,
      music: 1,
      administration: 1,
      automation: 1,
      economy: 1,
    });
    const firstGate = deferred();
    const order: string[] = [];
    const first = scheduler.run('economy', 'noisy', async () => {
      order.push('noisy-1');
      await firstGate.promise;
    });
    const queued = [
      scheduler.run('economy', 'noisy', async () => { order.push('noisy-2'); }),
      scheduler.run('economy', 'noisy', async () => { order.push('noisy-3'); }),
      scheduler.run('economy', 'quiet', async () => { order.push('quiet-1'); }),
    ];

    await Promise.resolve();
    firstGate.release();
    await Promise.all([first, ...queued]);

    expect(order).toEqual(['noisy-1', 'quiet-1', 'noisy-2', 'noisy-3']);
  });
});
