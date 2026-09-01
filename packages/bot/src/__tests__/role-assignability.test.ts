import { describe, expect, it, vi } from 'vitest';
import { mockGuild } from './helpers/discord-mocks.js';
import { roleAssignmentIssue, requireAssignableRole } from '../services/role-assignability.js';

function guild(role: { readonly id: string; readonly name: string; readonly managed: boolean; readonly editable: boolean } | null) {
  const fixture = mockGuild();
  fixture.roles.cache.clear();
  if (role) fixture.roles.cache.set(role.id, role);
  fixture.members.me = {
    permissions: { has: vi.fn((permission: string) => permission === 'ManageRoles') },
  };
  return fixture;
}

describe('runtime role assignability', () => {
  it('returns remediation when the configured role was deleted', () => {
    expect(roleAssignmentIssue(guild(null), 'role-1')).toEqual({
      kind: 'missing',
      message: 'Configured role role-1 no longer exists. Select a current role in the dashboard.',
    });
  });

  it('returns remediation when Discord manages the configured role', () => {
    expect(roleAssignmentIssue(guild({ id: 'role-1', name: 'Integration', managed: true, editable: false }), 'role-1')).toEqual({
      kind: 'managed',
      message: 'The configured role "Integration" is managed by Discord and cannot be changed by SomniBot.',
    });
  });

  it('throws a typed error before a role mutation can execute', () => {
    expect(() => requireAssignableRole(guild({ id: 'role-1', name: 'Admin', managed: false, editable: false }), 'role-1'))
      .toThrow('Move SomniBot above the "Admin" role and grant Manage Roles, then retry.');
  });

  it('returns the live role only when Discord currently marks it editable', () => {
    const role = { id: 'role-1', name: 'Member', managed: false, editable: true };
    expect(requireAssignableRole(guild(role), 'role-1')).toBe(role);
  });
});
