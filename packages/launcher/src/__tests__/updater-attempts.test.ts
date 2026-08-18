import { describe, expect, it } from 'vitest';
import { LauncherAttemptTracker, type LauncherAuditEntry } from '../main/audit-log';
import {
  recordUnavailableUpdaterAttempt,
  runUpdaterOperation,
  type UpdaterAttemptRuntime,
} from '../main/updater';

function createRuntime(entries: LauncherAuditEntry[]): UpdaterAttemptRuntime {
  let operationNumber = 0;
  return {
    tracker: new LauncherAttemptTracker(() => `updater-operation-${++operationNumber}`),
    now: () => '2026-08-18T12:00:00.000Z',
    recordAudit: (entry) => entries.push(entry),
  };
}

describe('updater attempt runtime', () => {
  it('persists two retry failures then success as one ordered updater operation', async () => {
    // Given: one updater observer and an update check that fails twice before succeeding.
    const entries: LauncherAuditEntry[] = [];
    const runtime = createRuntime(entries);
    const failingCheck = () => Promise.reject(new Error('private updater diagnostic'));

    // When: the same runtime operation is retried twice and then completes.
    await runUpdaterOperation({
      phase: 'updater-check',
      execute: failingCheck,
      successCode: 'updater_check_completed',
      retryCode: 'updater_check_failed',
    }, runtime);
    await runUpdaterOperation({
      phase: 'updater-check',
      execute: failingCheck,
      successCode: 'updater_check_completed',
      retryCode: 'updater_check_failed',
    }, runtime);
    await runUpdaterOperation({
      phase: 'updater-check',
      execute: () => Promise.resolve(),
      successCode: 'updater_check_completed',
      retryCode: 'updater_check_failed',
    }, runtime);

    // Then: durable records are ordered, correlated, and contain no raw failure output.
    expect(entries.map((entry) => entry.occurrenceKey)).toEqual([
      'launcher.attempt:updater-operation-1:updater-check:1',
      'launcher.attempt:updater-operation-1:updater-check:2',
      'launcher.attempt:updater-operation-1:updater-check:3',
    ]);
    expect(entries.map((entry) => entry.correlationId)).toEqual([
      'updater-operation-1',
      'updater-operation-1',
      'updater-operation-1',
    ]);
    expect(entries.map((entry) => entry.success)).toEqual([false, false, true]);
    expect(JSON.stringify(entries)).not.toContain('private updater diagnostic');
  });

  it('persists a terminal updater-unavailable event through the runtime seam', () => {
    // Given: updater module loading is unavailable in a development launch.
    const entries: LauncherAuditEntry[] = [];

    // When: the noop updater handler records the unavailable check operation.
    const result = recordUnavailableUpdaterAttempt('updater-check', createRuntime(entries));

    // Then: the terminal failure is durable and does not retain diagnostics.
    expect(result).toEqual({ ok: false, error: 'Updater not available in dev mode.' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      correlationId: 'updater-operation-1',
      occurrenceKey: 'launcher.attempt:updater-operation-1:updater-check:1',
      success: false,
      details: { result: 'failure', code: 'updater_unavailable' },
    });
  });
});
