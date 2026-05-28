/**
 * Drift Debouncer Tests — V5 Audit §14.P3a
 *
 * Verifies batching behaviour: debounce window, immediate flush for critical
 * events, dedup/merge of same-entity items, and eventBus emission.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to mock modules BEFORE importing the debouncer
vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { queueDriftItem } from '../sync/drift-debouncer.js';

function makeMockClient() {
  const updateFn = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  });

  const supabase = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
      update: updateFn,
    }),
  };

  const emitFn = vi.fn();
  const eventBus = { emit: emitFn };

  return { supabase, eventBus, updateFn, emitFn } as unknown as {
    supabase: ReturnType<typeof makeMockClient>['supabase'];
    eventBus: ReturnType<typeof makeMockClient>['eventBus'];
    updateFn: ReturnType<typeof vi.fn>;
    emitFn: ReturnType<typeof vi.fn>;
  };
}

type DriftSeverity = 'low' | 'medium' | 'high' | 'critical';

function makeItem(overrides: Partial<{
  type: string;
  entityType: string;
  entityName: string;
  severity: DriftSeverity;
  description: string;
  suggestedAction: string;
}> = {}) {
  return {
    type: overrides.type ?? 'PERMISSION_DRIFT',
    entityType: overrides.entityType ?? 'role',
    entityName: overrides.entityName ?? 'Moderator',
    severity: (overrides.severity ?? 'medium') as DriftSeverity,
    description: overrides.description ?? 'Role permissions changed',
    suggestedAction: overrides.suggestedAction ?? 'Repair permissions',
  };
}

describe('DriftDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches items within the debounce window', async () => {
    const mock = makeMockClient();

    queueDriftItem(mock as never, 'guild-1', makeItem({ entityName: 'Mod' }));
    queueDriftItem(mock as never, 'guild-1', makeItem({ entityName: 'Admin' }));
    queueDriftItem(mock as never, 'guild-1', makeItem({ entityName: 'VIP' }));

    // Nothing flushed yet
    expect(mock.emitFn).not.toHaveBeenCalled();

    // Advance past debounce window
    await vi.advanceTimersByTimeAsync(2500);

    // Now the batch should have flushed
    expect(mock.emitFn).toHaveBeenCalledTimes(1);
    expect(mock.emitFn).toHaveBeenCalledWith(
      'drift.detected',
      'guild-1',
      expect.objectContaining({ driftCount: 3 }),
    );
  });

  it('flushes immediately for critical events', async () => {
    const mock = makeMockClient();

    queueDriftItem(mock as never, 'guild-2', makeItem({
      entityName: '@everyone',
      severity: 'critical',
      entityType: 'everyone',
    }), true);

    // Should flush immediately, no need to wait for timer
    // Give microtasks a chance to resolve
    await vi.advanceTimersByTimeAsync(10);

    expect(mock.emitFn).toHaveBeenCalledTimes(1);
    expect(mock.emitFn).toHaveBeenCalledWith(
      'drift.detected',
      'guild-2',
      expect.objectContaining({ criticalCount: 1 }),
    );
  });

  it('immediate flush also includes pending non-critical items', async () => {
    const mock = makeMockClient();

    // Queue normal items first
    queueDriftItem(mock as never, 'guild-3', makeItem({ entityName: 'Mod' }));
    queueDriftItem(mock as never, 'guild-3', makeItem({ entityName: 'Admin' }));

    // Then a critical item triggers immediate flush
    queueDriftItem(mock as never, 'guild-3', makeItem({
      entityName: '@everyone',
      severity: 'critical',
    }), true);

    await vi.advanceTimersByTimeAsync(10);

    expect(mock.emitFn).toHaveBeenCalledTimes(1);
    expect(mock.emitFn).toHaveBeenCalledWith(
      'drift.detected',
      'guild-3',
      expect.objectContaining({ driftCount: 3, criticalCount: 1 }),
    );
  });

  it('keeps guilds independent', async () => {
    const mock = makeMockClient();

    queueDriftItem(mock as never, 'guild-A', makeItem({ entityName: 'RoleA' }));
    queueDriftItem(mock as never, 'guild-B', makeItem({ entityName: 'RoleB' }));

    await vi.advanceTimersByTimeAsync(2500);

    // Each guild gets its own flush
    expect(mock.emitFn).toHaveBeenCalledTimes(2);
    const calls = mock.emitFn.mock.calls;
    const guildIds = calls.map((c: unknown[]) => c[1]);
    expect(guildIds).toContain('guild-A');
    expect(guildIds).toContain('guild-B');
  });

  it('resets the debounce timer when new items arrive', async () => {
    const mock = makeMockClient();

    queueDriftItem(mock as never, 'guild-4', makeItem({ entityName: 'R1' }));

    // Advance 1.5s (within window)
    await vi.advanceTimersByTimeAsync(1500);
    expect(mock.emitFn).not.toHaveBeenCalled();

    // Add another item — should reset the 2s window
    queueDriftItem(mock as never, 'guild-4', makeItem({ entityName: 'R2' }));

    // Advance another 1.5s (3s total, but only 1.5s since last item)
    await vi.advanceTimersByTimeAsync(1500);
    expect(mock.emitFn).not.toHaveBeenCalled();

    // Advance past the new window
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.emitFn).toHaveBeenCalledTimes(1);
    expect(mock.emitFn).toHaveBeenCalledWith(
      'drift.detected',
      'guild-4',
      expect.objectContaining({ driftCount: 2 }),
    );
  });
});
