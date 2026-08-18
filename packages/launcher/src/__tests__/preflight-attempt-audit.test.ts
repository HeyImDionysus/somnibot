import { describe, expect, it } from 'vitest';
import type { LauncherAuditEntry } from '../main/audit-log';
import { createPreflightAttemptAudit } from '../main/preflight-attempt-audit';

describe('preflight attempt runtime', () => {
  it('persists two retry failures then success as one ordered preflight operation', () => {
    // Given: a VPS preflight observer that writes to the durable launcher audit sink.
    const entries: LauncherAuditEntry[] = [];
    const attempts = createPreflightAttemptAudit({
      createOperationId: () => 'preflight-operation-1',
      now: () => '2026-08-18T12:00:00.000Z',
      recordAudit: (entry) => entries.push(entry),
    });

    // When: the same preflight operation has two retryable failures before success.
    attempts.record('retry', 'vps_preflight_retryable_failure');
    attempts.record('retry', 'vps_preflight_retryable_failure');
    attempts.record('success', 'vps_preflight_succeeded');

    // Then: all three rows retain one operation id and ordered replay fences.
    expect(entries.map((entry) => entry.occurrenceKey)).toEqual([
      'launcher.attempt:preflight-operation-1:vps-preflight:1',
      'launcher.attempt:preflight-operation-1:vps-preflight:2',
      'launcher.attempt:preflight-operation-1:vps-preflight:3',
    ]);
    expect(entries.map((entry) => entry.correlationId)).toEqual([
      'preflight-operation-1',
      'preflight-operation-1',
      'preflight-operation-1',
    ]);
    expect(entries.map((entry) => entry.success)).toEqual([false, false, true]);
  });
});
