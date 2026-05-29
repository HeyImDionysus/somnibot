/**
 * Tests for safety module — V5 Audit P2-3
 *
 * Covers isLockoutSafe, validateDeployment, and validateRolePermissions
 * with edge cases for the security-critical lockout prevention logic.
 */
import { describe, it, expect } from 'vitest';
import {
  isLockoutSafe,
  validateDeployment,
  validateRolePermissions,
  type RoleConfig,
} from '../engine/safety.js';
import { DISCORD_PERMISSIONS } from '../constants/permissions.js';

function makeRole(overrides: Partial<RoleConfig> & { id: string; name: string }): RoleConfig {
  return {
    tier: 'admin',
    permissions: 0n,
    position: 1,
    ...overrides,
  };
}

const ADMIN_PERMS = DISCORD_PERMISSIONS.MANAGE_GUILD |
  DISCORD_PERMISSIONS.MANAGE_ROLES |
  DISCORD_PERMISSIONS.MANAGE_CHANNELS;

// ── isLockoutSafe ──────────────────────────────────────────

describe('isLockoutSafe', () => {
  it('returns true when another admin role exists', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Head Admin', permissions: ADMIN_PERMS }),
    ];
    expect(isLockoutSafe([], roles, '1', 0n)).toBe(true);
  });

  it('returns false when removing perms from the only admin role', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Member', tier: 'member', permissions: 0n }),
    ];
    expect(isLockoutSafe([], roles, '1', 0n)).toBe(false);
  });

  it('returns true when role has ADMINISTRATOR permission', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: DISCORD_PERMISSIONS.ADMINISTRATOR }),
    ];
    expect(isLockoutSafe([], roles, '999', 0n)).toBe(true);
  });

  it('returns false when removing ADMINISTRATOR from only admin role', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: DISCORD_PERMISSIONS.ADMINISTRATOR }),
    ];
    expect(isLockoutSafe([], roles, '1', 0n)).toBe(false);
  });

  it('ignores cosmetic and everyone roles', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'VIP', tier: 'cosmetic', permissions: ADMIN_PERMS }),
    ];
    expect(isLockoutSafe([], roles, '1', 0n)).toBe(false);
  });

  it('excludes owner-only roles from admin capability check', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Owner Only', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Member', tier: 'member', permissions: 0n }),
    ];
    expect(isLockoutSafe(['1'], roles, '2', 0n)).toBe(false);
  });

  it('allows change when a non-owner admin role exists', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Owner Only', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Delegate Admin', permissions: ADMIN_PERMS }),
    ];
    expect(isLockoutSafe(['1'], roles, '999', 0n)).toBe(true);
  });

  // ── V5 Audit P2-3: Additional edge cases ────────────────

  it('returns false with empty role list', () => {
    expect(isLockoutSafe([], [], '1', 0n)).toBe(false);
  });

  it('returns false when all roles are cosmetic', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'VIP', tier: 'cosmetic', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Booster', tier: 'cosmetic', permissions: ADMIN_PERMS }),
    ];
    expect(isLockoutSafe([], roles, '999', 0n)).toBe(false);
  });

  it('returns false when all roles are everyone tier', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: '@everyone', tier: 'everyone', permissions: ADMIN_PERMS }),
    ];
    expect(isLockoutSafe([], roles, '999', 0n)).toBe(false);
  });

  it('is safe when changing a member role and admin role exists', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Member', tier: 'member', permissions: DISCORD_PERMISSIONS.SEND_MESSAGES }),
    ];
    // Changing the member role perms should be fine
    expect(isLockoutSafe([], roles, '2', 0n)).toBe(true);
  });

  it('is safe when reducing but not removing admin perms', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
    ];
    // Keeping all three admin perms but removing something else
    const newPerms = ADMIN_PERMS | DISCORD_PERMISSIONS.SEND_MESSAGES;
    expect(isLockoutSafe([], roles, '1', ADMIN_PERMS)).toBe(true);
  });

  it('is unsafe when removing one of the three required admin perms', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
    ];
    // Only keeping MANAGE_GUILD and MANAGE_ROLES, missing MANAGE_CHANNELS
    const partialPerms = DISCORD_PERMISSIONS.MANAGE_GUILD | DISCORD_PERMISSIONS.MANAGE_ROLES;
    expect(isLockoutSafe([], roles, '1', partialPerms)).toBe(false);
  });

  it('handles moderator-tier role with admin perms', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Mod', tier: 'moderator', permissions: ADMIN_PERMS }),
    ];
    // Moderator tier counts — not cosmetic or everyone
    expect(isLockoutSafe([], roles, '999', 0n)).toBe(true);
  });

  it('is safe with custom-tier role having admin perms', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Custom', tier: 'custom', permissions: ADMIN_PERMS }),
    ];
    expect(isLockoutSafe([], roles, '999', 0n)).toBe(true);
  });

  it('all owner roles plus a single admin — removing admin perms is unsafe', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: 'o1', name: 'Owner 1', permissions: ADMIN_PERMS }),
      makeRole({ id: 'o2', name: 'Owner 2', permissions: ADMIN_PERMS }),
      makeRole({ id: 'a1', name: 'Admin', permissions: ADMIN_PERMS }),
    ];
    // Both owner roles excluded, a1 is the only delegate admin
    expect(isLockoutSafe(['o1', 'o2'], roles, 'a1', 0n)).toBe(false);
  });

  it('does not crash with empty ownerRoleIds', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
    ];
    // Empty owner array means all roles are evaluated
    expect(isLockoutSafe([], roles, '999', 0n)).toBe(true);
  });

  it('changing a role not in the list still evaluates correctly', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
    ];
    // changingRoleId '999' doesn't match any existing role
    expect(isLockoutSafe([], roles, '999', 0n)).toBe(true);
  });
});

// ── validateDeployment ─────────────────────────────────────

describe('validateDeployment', () => {
  it('returns valid for a well-formed config', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS, position: 3 }),
      makeRole({ id: '2', name: 'Moderator', tier: 'moderator', permissions: DISCORD_PERMISSIONS.MODERATE_MEMBERS, position: 2 }),
      makeRole({ id: '3', name: 'Member', tier: 'member', permissions: DISCORD_PERMISSIONS.SEND_MESSAGES, position: 1 }),
    ];
    const result = validateDeployment(roles, 0n, 5);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('errors when @everyone has non-zero permissions', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Member', tier: 'member', permissions: 0n }),
    ];
    const result = validateDeployment(roles, DISCORD_PERMISSIONS.SEND_MESSAGES, 10);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'EVERYONE_NOT_ZERO')).toBe(true);
  });

  it('errors when a role has ADMINISTRATOR', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Bad Admin', permissions: DISCORD_PERMISSIONS.ADMINISTRATOR }),
      makeRole({ id: '2', name: 'Member', tier: 'member', permissions: 0n }),
    ];
    const result = validateDeployment(roles, 0n, 10);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'ADMINISTRATOR_PROHIBITED')).toBe(true);
  });

  it('warns when admin perms are on a member-tier role', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Super Member', tier: 'member', permissions: DISCORD_PERMISSIONS.MANAGE_GUILD }),
    ];
    const result = validateDeployment(roles, 0n, 10);
    expect(result.warnings.some(w => w.code === 'ADMIN_PERM_ON_NON_ADMIN')).toBe(true);
  });

  it('errors when a role is at or above bot position', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS, position: 10 }),
      makeRole({ id: '2', name: 'Member', tier: 'member', permissions: 0n, position: 1 }),
    ];
    const result = validateDeployment(roles, 0n, 10);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'HIERARCHY_CONFLICT')).toBe(true);
  });

  it('errors when no member role is defined', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
    ];
    const result = validateDeployment(roles, 0n, 10);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'NO_MEMBER_ROLE')).toBe(true);
  });

  it('warns when no admin role is defined', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Member', tier: 'member', permissions: 0n }),
    ];
    const result = validateDeployment(roles, 0n, 10);
    expect(result.warnings.some(w => w.code === 'NO_ADMIN_ROLE')).toBe(true);
  });

  it('warns when mod perms are on cosmetic role', () => {
    const roles: RoleConfig[] = [
      makeRole({ id: '1', name: 'Admin', permissions: ADMIN_PERMS }),
      makeRole({ id: '2', name: 'Member', tier: 'member', permissions: 0n }),
      makeRole({ id: '3', name: 'VIP', tier: 'cosmetic', permissions: DISCORD_PERMISSIONS.BAN_MEMBERS }),
    ];
    const result = validateDeployment(roles, 0n, 10);
    expect(result.warnings.some(w => w.code === 'MOD_PERM_ON_MEMBER')).toBe(true);
  });
});

// ── validateRolePermissions ────────────────────────────────

describe('validateRolePermissions', () => {
  it('returns empty for a valid admin role', () => {
    const checks = validateRolePermissions(ADMIN_PERMS, 'admin');
    expect(checks).toHaveLength(0);
  });

  it('errors when ADMINISTRATOR is set', () => {
    const checks = validateRolePermissions(DISCORD_PERMISSIONS.ADMINISTRATOR, 'admin');
    expect(checks.some(c => c.code === 'PROHIBITED_PERMISSION')).toBe(true);
  });

  it('warns when cosmetic role has permissions', () => {
    const checks = validateRolePermissions(DISCORD_PERMISSIONS.SEND_MESSAGES, 'cosmetic');
    expect(checks.some(c => c.code === 'COSMETIC_HAS_PERMISSIONS')).toBe(true);
  });

  it('errors when everyone role has permissions', () => {
    const checks = validateRolePermissions(DISCORD_PERMISSIONS.SEND_MESSAGES, 'everyone');
    expect(checks.some(c => c.code === 'EVERYONE_HAS_PERMISSIONS')).toBe(true);
  });

  it('returns empty for a zero-permission cosmetic role', () => {
    const checks = validateRolePermissions(0n, 'cosmetic');
    expect(checks).toHaveLength(0);
  });

  it('returns empty for a zero-permission everyone role', () => {
    const checks = validateRolePermissions(0n, 'everyone');
    expect(checks).toHaveLength(0);
  });

  it('returns empty for a moderator role with mod perms', () => {
    const checks = validateRolePermissions(
      DISCORD_PERMISSIONS.MODERATE_MEMBERS | DISCORD_PERMISSIONS.KICK_MEMBERS,
      'moderator',
    );
    expect(checks).toHaveLength(0);
  });
});
