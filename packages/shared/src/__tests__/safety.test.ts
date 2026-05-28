/**
 * Tests for isLockoutSafe — V6 Audit §11.4
 */
import { describe, it, expect } from 'vitest';
import { isLockoutSafe, type RoleConfig } from '../engine/safety.js';
import { DISCORD_PERMISSIONS } from '../constants/permissions.js';

function makeRole(overrides: Partial<RoleConfig> & { id: string; name: string }): RoleConfig {
  return {
    tier: 'admin',
    permissions: 0n,
    position: 1,
    ...overrides,
  };
}

describe('isLockoutSafe', () => {
  const ADMIN_PERMS = DISCORD_PERMISSIONS.MANAGE_GUILD |
    DISCORD_PERMISSIONS.MANAGE_ROLES |
    DISCORD_PERMISSIONS.MANAGE_CHANNELS;

  it('returns true when another admin role exists', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Head Admin', permissions: ADMIN_PERMS }),
    ];

    // Stripping all perms from role 1 is safe because role 2 still has admin
    expect(isLockoutSafe([], roles, '1', 0n)).toBe(true);
  });

  it('returns false when removing perms from the only admin role', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Member', tier: 'member', permissions: 0n }),
    ];

    // Stripping all perms from the only admin role is unsafe
    expect(isLockoutSafe([], roles, '1', 0n)).toBe(false);
  });

  it('returns true when role has ADMINISTRATOR permission', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: DISCORD_PERMISSIONS.ADMINISTRATOR }),
    ];

    // Even though we only have one role, it has ADMINISTRATOR after the "change"
    expect(isLockoutSafe([], roles, '999', 0n)).toBe(true);
  });

  it('returns false when removing ADMINISTRATOR from only admin role', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: DISCORD_PERMISSIONS.ADMINISTRATOR }),
    ];

    // Removing ADMINISTRATOR from the only role that has it
    expect(isLockoutSafe([], roles, '1', 0n)).toBe(false);
  });

  it('ignores cosmetic and everyone roles', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'VIP', tier: 'cosmetic', permissions: ADMIN_PERMS }),
    ];

    // Role 2 has admin perms but is cosmetic — shouldn't count
    expect(isLockoutSafe([], roles, '1', 0n)).toBe(false);
  });

  // V5 Audit §11.1: ownerRoleIds are now excluded from the lockout check
  it('excludes owner-only roles from admin capability check', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Owner Only', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Member', tier: 'member', permissions: 0n }),
    ];

    // Role 1 has admin perms but belongs to owner — no delegate admin exists
    expect(isLockoutSafe(['1'], roles, '2', 0n)).toBe(false);
  });

  it('allows change when a non-owner admin role exists', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Owner Only', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Delegate Admin', permissions: ADMIN_PERMS }),
    ];

    // Role 1 is owner-only, but role 2 is a delegate admin
    expect(isLockoutSafe(['1'], roles, '999', 0n)).toBe(true);
  });
});
