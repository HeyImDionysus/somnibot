/**
 * Permission Safety Checks
 *
 * Pre-deployment validation to prevent dangerous configurations.
 * Used by both dashboard (preview warnings) and bot (pre-deploy gate).
 */

import { DISCORD_PERMISSIONS, type DiscordPermission } from '../constants/permissions.js';
import type { RoleTemplateTier } from '../constants/templates.js';

// ============================================================
// Types
// ============================================================

export type SafetyLevel = 'error' | 'warning' | 'info';

export interface SafetyCheck {
  level: SafetyLevel;
  code: string;
  message: string;
  details?: string;
}

export interface RoleConfig {
  id: string;
  name: string;
  tier: RoleTemplateTier;
  permissions: bigint;
  position: number;
}

export interface DeploymentValidation {
  valid: boolean;
  checks: SafetyCheck[];
  errors: SafetyCheck[];
  warnings: SafetyCheck[];
}

// ============================================================
// Dangerous Permission Sets
// ============================================================

/** Permissions that should NEVER be granted via templates */
const PROHIBITED_PERMISSIONS: DiscordPermission[] = ['ADMINISTRATOR'];

/** Permissions that should only exist on Admin tier */
const ADMIN_ONLY_PERMISSIONS: DiscordPermission[] = [
  'MANAGE_GUILD', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'MANAGE_WEBHOOKS',
  'MANAGE_GUILD_EXPRESSIONS', 'VIEW_GUILD_INSIGHTS',
  'VIEW_CREATOR_MONETIZATION_ANALYTICS',
];

/** Permissions that should only exist on Moderator+ tier */
const MOD_ONLY_PERMISSIONS: DiscordPermission[] = [
  'MANAGE_MESSAGES', 'MANAGE_THREADS', 'MODERATE_MEMBERS',
  'KICK_MEMBERS', 'BAN_MEMBERS', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS',
  'MOVE_MEMBERS', 'MENTION_EVERYONE',
];

// ============================================================
// Validators
// ============================================================

/**
 * Validate a full deployment configuration before execution.
 */
export function validateDeployment(
  roles: RoleConfig[],
  everyonePermissions: bigint,
  botRolePosition: number,
): DeploymentValidation {
  const checks: SafetyCheck[] = [];

  // 1. @everyone must be zero
  if (everyonePermissions !== 0n) {
    checks.push({
      level: 'error',
      code: 'EVERYONE_NOT_ZERO',
      message: '@everyone permissions must be zero',
      details: '@everyone is the "unverified" state. All permissions must come from assigned roles.',
    });
  }

  // 2. No role should have ADMINISTRATOR
  for (const role of roles) {
    if ((role.permissions & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n) {
      checks.push({
        level: 'error',
        code: 'ADMINISTRATOR_PROHIBITED',
        message: `Role "${role.name}" has ADMINISTRATOR permission`,
        details: 'ADMINISTRATOR bypasses ALL permission checks. SomniBot never grants this.',
      });
    }
  }

  // 3. Admin-only permissions on non-admin roles
  for (const role of roles) {
    if (role.tier !== 'admin' && role.tier !== 'custom') {
      for (const perm of ADMIN_ONLY_PERMISSIONS) {
        if ((role.permissions & DISCORD_PERMISSIONS[perm]) !== 0n) {
          checks.push({
            level: 'warning',
            code: 'ADMIN_PERM_ON_NON_ADMIN',
            message: `Role "${role.name}" (${role.tier}) has ${perm}`,
            details: `${perm} is typically reserved for Admin-tier roles.`,
          });
        }
      }
    }
  }

  // 4. Mod-only permissions on member/cosmetic roles
  for (const role of roles) {
    if (role.tier === 'member' || role.tier === 'cosmetic' || role.tier === 'everyone') {
      for (const perm of MOD_ONLY_PERMISSIONS) {
        if ((role.permissions & DISCORD_PERMISSIONS[perm]) !== 0n) {
          checks.push({
            level: 'warning',
            code: 'MOD_PERM_ON_MEMBER',
            message: `Role "${role.name}" (${role.tier}) has ${perm}`,
            details: `${perm} is a moderation tool, not appropriate for ${role.tier}-tier roles.`,
          });
        }
      }
    }
  }

  // 5. Hierarchy validation — bot must be able to manage all roles
  for (const role of roles) {
    if (role.position >= botRolePosition) {
      checks.push({
        level: 'error',
        code: 'HIERARCHY_CONFLICT',
        message: `Role "${role.name}" at position ${role.position} is at or above the bot role (position ${botRolePosition})`,
        details: 'The bot cannot manage roles at or above its own position.',
      });
    }
  }

  // 6. At least one admin role
  const hasAdmin = roles.some(r => r.tier === 'admin');
  if (!hasAdmin) {
    checks.push({
      level: 'warning',
      code: 'NO_ADMIN_ROLE',
      message: 'No Admin-tier role defined',
      details: 'Without an Admin role, server management will require the owner to act directly.',
    });
  }

  // 7. At least one member role
  const hasMember = roles.some(r => r.tier === 'member');
  if (!hasMember) {
    checks.push({
      level: 'error',
      code: 'NO_MEMBER_ROLE',
      message: 'No Member-tier role defined',
      details: 'A Member role is required for onboarding. New members receive this role after completing onboarding.',
    });
  }

  const errors = checks.filter(c => c.level === 'error');
  const warnings = checks.filter(c => c.level === 'warning');

  return {
    valid: errors.length === 0,
    checks,
    errors,
    warnings,
  };
}

/**
 * Validate a single role template's permissions.
 */
export function validateRolePermissions(
  permissions: bigint,
  tier: RoleTemplateTier,
): SafetyCheck[] {
  const checks: SafetyCheck[] = [];

  // Prohibited permissions
  for (const perm of PROHIBITED_PERMISSIONS) {
    if ((permissions & DISCORD_PERMISSIONS[perm]) !== 0n) {
      checks.push({
        level: 'error',
        code: 'PROHIBITED_PERMISSION',
        message: `${perm} is never granted via templates`,
      });
    }
  }

  // Cosmetic roles should have zero permissions
  if (tier === 'cosmetic' && permissions !== 0n) {
    checks.push({
      level: 'warning',
      code: 'COSMETIC_HAS_PERMISSIONS',
      message: 'Cosmetic roles should have zero functional permissions',
    });
  }

  // @everyone should have zero permissions
  if (tier === 'everyone' && permissions !== 0n) {
    checks.push({
      level: 'error',
      code: 'EVERYONE_HAS_PERMISSIONS',
      message: '@everyone must have zero permissions',
    });
  }

  return checks;
}

/**
 * Check if a permission change would lock out the server.
 * Returns true if the change is safe.
 *
 * V6 Audit §11.4: Real implementation — verifies that after the change,
 * at least one role still has ADMINISTRATOR or the full admin permission set.
 * This prevents the scenario where the last admin role has its permissions
 * stripped, leaving no one able to manage the server when the owner is away.
 *
 * V5 Audit §11.1: ownerRoleIds are excluded from the lockout check — the
 * server owner always has implicit permissions via Discord, so roles they
 * hold don't count toward the "delegate admin" requirement.
 */
export function isLockoutSafe(
  ownerRoleIds: string[],
  allRoles: RoleConfig[],
  changingRoleId: string,
  newPermissions: bigint,
): boolean {
  // Build a simulated role set with the proposed change applied
  const simulatedRoles = allRoles.map((role) => {
    if (role.id === changingRoleId) {
      return { ...role, permissions: newPermissions };
    }
    return role;
  });

  // V10 Audit §11.P3a: If ownerRoleIds is empty (caller error or unknown owner),
  // skip the owner-exclusion filter so the check is maximally conservative —
  // every role is evaluated, making a false "safe" result less likely.
  const ownerSet = new Set(ownerRoleIds);

  const MANAGE_PERMS = DISCORD_PERMISSIONS.MANAGE_GUILD |
    DISCORD_PERMISSIONS.MANAGE_ROLES |
    DISCORD_PERMISSIONS.MANAGE_CHANNELS;

  const hasAdminCapableRole = simulatedRoles.some((role) => {
    // Skip the @everyone tier — it's not assignable
    if (role.tier === 'everyone' || role.tier === 'cosmetic') return false;
    // Skip owner-exclusive roles — owner has implicit permissions
    if (ownerSet.has(role.id)) return false;

    const perms = role.permissions;
    // Either has ADMINISTRATOR (full bypass) or all three management perms
    return (perms & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n ||
      (perms & MANAGE_PERMS) === MANAGE_PERMS;
  });

  if (!hasAdminCapableRole) {
    return false; // Unsafe: no non-owner role would have admin capability after this change
  }

  return true;
}
