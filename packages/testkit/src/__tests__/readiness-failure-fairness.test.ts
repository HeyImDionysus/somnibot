import { describe, expect, it } from 'vitest';

import { FAILURE_CASES, runExecutableFailureMatrix } from '../readiness/failure-injection.js';
import { WORKLOAD_CLASSES, runFairScheduling } from '../readiness/fairness-model.js';

describe('reliability failure and fairness models', () => {
  it('executes every required concurrency and failure-injection class', async () => {
    // Given
    const required = [
      'duplicate-command', 'concurrent-interactions', 'replayed-webhook', 'bot-restart',
      'database-timeout', 'valkey-outage', 'discord-rate-limit', 'paypal-retry',
      'partial-fulfillment', 'simultaneous-config-change', 'shutdown-during-work',
    ];

    // When
    const results = await runExecutableFailureMatrix();

    // Then
    expect(FAILURE_CASES.map(([id]) => id)).toEqual(required);
    expect(results).toHaveLength(required.length);
    expect(results.every((result) => result.status === 'SYNTHETIC_PASS')).toBe(true);
    expect(results.every((result) => result.requiredLiveEvidence !== null)).toBe(true);
  });

  it('admits critical work during an economy flood and bounds each guild', async () => {
    // Given
    const flood = Array.from({ length: 500 }, (_, index) => ({
      id: `economy-${index}`,
      workload: 'economy' as const,
      guildId: `guild-${index % 3}`,
    }));
    const critical = [
      { id: 'moderation-critical', workload: 'moderation' as const, guildId: 'guild-4' },
      { id: 'commerce-critical', workload: 'commerce' as const, guildId: 'guild-5' },
    ];

    // When
    const result = await runFairScheduling([...flood, ...critical], 30);

    // Then
    expect(result.admitted.map((item) => item.id)).toEqual(
      expect.arrayContaining(['moderation-critical', 'commerce-critical']),
    );
    expect(result.maximumCriticalWait).toBeLessThan(8);
    expect(Object.keys(result.perGuildAdmissions).length).toBeGreaterThan(3);
    expect(WORKLOAD_CLASSES).toContain('music');
    expect(result.elapsedMilliseconds).toBeGreaterThan(0);
    expect(result.peakActive.economy).toBe(1);
  });
});
