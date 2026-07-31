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
    expect(roleAssignmentIssue({ editableByBot: true }, true, false)).toContain('cannot be verified');
    expect(roleAssignmentIssue({ editableByBot: false }, true, false)).toContain('cannot be verified');
  });

  it('names the hierarchy/permission repair under an authoritative snapshot', async () => {
    const { roleAssignmentIssue } = await import('@/components/shared/role-picker');
    expect(roleAssignmentIssue({ editableByBot: false }, true, true)).toContain('Manage Roles');
    expect(roleAssignmentIssue({ editableByBot: true }, true, true)).toBeNull();
  });

  it('never blocks pickers that do not require assignability', async () => {
    const { roleAssignmentIssue } = await import('@/components/shared/role-picker');
    expect(roleAssignmentIssue({ editableByBot: false }, false, false)).toBeNull();
    expect(roleAssignmentIssue({ editableByBot: false }, false, true)).toBeNull();
  });
});
