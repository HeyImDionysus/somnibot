import { describe, expect, it } from 'vitest';
import {
  isAuthoritativeRoleSnapshot,
  missingRoleIds,
} from '@/components/shared/role-picker';

const NOW = Date.parse('2026-07-31T04:00:00.000Z');
const role = {
  id: 'role-1',
  name: 'Member',
  color: 0,
  position: 1,
  managed: false,
  editableByBot: true,
};

describe('RolePicker authoritative deletion state', () => {
  it('preserves configured IDs when the live role lookup is not authoritative', () => {
    expect(missingRoleIds(['role-1'], [], false)).toEqual([]);
  });

  it('marks a configured ID missing only after an authoritative role read', () => {
    expect(missingRoleIds(['role-1'], [], true)).toEqual(['role-1']);
    expect(missingRoleIds(
      ['role-1'],
      [role],
      true,
    )).toEqual([]);
  });

  it('accepts only a fresh, complete v2 role snapshot as authoritative', () => {
    expect(isAuthoritativeRoleSnapshot({
      awaitingSnapshot: false,
      snapshotVersion: 2,
      snapshotAt: new Date(NOW - 60_000).toISOString(),
      data: [role],
    }, NOW)).toBe(true);
  });

  it.each([
    ['pending', { awaitingSnapshot: true, snapshotVersion: 2, snapshotAt: new Date(NOW).toISOString(), data: [role] }],
    ['legacy', { awaitingSnapshot: false, snapshotVersion: 1, snapshotAt: new Date(NOW).toISOString(), data: [role] }],
    ['stale', { awaitingSnapshot: false, snapshotVersion: 2, snapshotAt: new Date(NOW - 10 * 60_000 - 1).toISOString(), data: [role] }],
    ['future-dated', { awaitingSnapshot: false, snapshotVersion: 2, snapshotAt: new Date(NOW + 60_001).toISOString(), data: [role] }],
    ['malformed', { awaitingSnapshot: false, snapshotVersion: 2, snapshotAt: new Date(NOW).toISOString(), data: [{ id: 'role-1' }] }],
  ])('treats a %s snapshot as non-authoritative', (_name, payload) => {
    expect(isAuthoritativeRoleSnapshot(payload, NOW)).toBe(false);
  });
});

describe('roleAssignmentIssue — requireAssignable fails closed without authority (round 12)', () => {
  it('blocks selection when the snapshot is not authoritative, regardless of stale bits', async () => {
    const { roleAssignmentIssue } = await import('@/components/shared/role-picker');
    // Stale editableByBot=true is exactly the dangerous case: the bot may
    // have lost Manage Roles since, and submission only fails later at
    // server validation.
    expect(roleAssignmentIssue({ editableByBot: true, managed: false }, true, false)).toContain('cannot be verified');
    expect(roleAssignmentIssue({ editableByBot: false, managed: false }, true, false)).toContain('cannot be verified');
  });

  it('names the hierarchy/permission repair under an authoritative snapshot', async () => {
    const { roleAssignmentIssue } = await import('@/components/shared/role-picker');
    expect(roleAssignmentIssue({ editableByBot: false, managed: false }, true, true)).toContain('Manage Roles');
    expect(roleAssignmentIssue({ editableByBot: true, managed: false }, true, true)).toBeNull();
    expect(roleAssignmentIssue({ editableByBot: false, managed: true }, true, true)).toContain('managed by Discord');
  });

  it('never blocks pickers that do not require assignability', async () => {
    const { roleAssignmentIssue } = await import('@/components/shared/role-picker');
    expect(roleAssignmentIssue({ editableByBot: false, managed: false }, false, false)).toBeNull();
    expect(roleAssignmentIssue({ editableByBot: false, managed: false }, false, true)).toBeNull();
  });
});

describe('roleSnapshotTimestampMs — mounted expiry anchors to the SNAPSHOT time (round 13)', () => {
  // Storing only the boolean verdict froze authority at fetch time: a page
  // left open past the snapshot's ten-minute validity kept enabling stale
  // editableByBot bits. The component seeds its expiry state from this parse
  // of the server snapshotAt, mirroring the channel picker.
  it('returns the parsed server timestamp', async () => {
    const { roleSnapshotTimestampMs } = await import('@/components/shared/role-picker');
    expect(roleSnapshotTimestampMs({ snapshotAt: '2026-07-31T03:51:00.000Z' }))
      .toBe(Date.parse('2026-07-31T03:51:00.000Z'));
  });

  it('returns null when snapshotAt is missing or unparseable', async () => {
    const { roleSnapshotTimestampMs } = await import('@/components/shared/role-picker');
    expect(roleSnapshotTimestampMs({})).toBeNull();
    expect(roleSnapshotTimestampMs({ snapshotAt: 'not-a-date' })).toBeNull();
    expect(roleSnapshotTimestampMs(null)).toBeNull();
  });

  it('an almost-expired snapshot is authoritative at fetch but expires on ITS clock', async () => {
    const { isAuthoritativeRoleSnapshot, roleSnapshotTimestampMs } =
      await import('@/components/shared/role-picker');
    const NOW = Date.parse('2026-07-31T04:00:00.000Z');
    const payload = {
      snapshotVersion: 2,
      snapshotAt: new Date(NOW - (10 * 60_000 - 1_000)).toISOString(),
      data: [{
        id: 'role-1', name: 'Mod', color: 0, position: 3, managed: false, editableByBot: true,
      }],
    };
    expect(isAuthoritativeRoleSnapshot(payload, NOW)).toBe(true);
    const anchor = roleSnapshotTimestampMs(payload);
    expect(anchor).not.toBeNull();
    // The same age math flips authority two seconds later, not in ten minutes.
    expect(NOW + 2_000 - (anchor as number) > 10 * 60_000).toBe(true);
  });
});

