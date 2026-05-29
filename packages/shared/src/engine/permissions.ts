/**
 * Discord Permission Engine
 *
 * Computes effective permissions following Discord's exact algorithm.
 * Used by both bot (validation) and dashboard (preview).
 */

import { DISCORD_PERMISSIONS, type DiscordPermission } from '../constants/permissions.js';

// All permission bits OR'd together
const ALL_PERMISSIONS = Object.values(DISCORD_PERMISSIONS).reduce((acc, v) => acc | v, 0n);

// ============================================================
// Types
// ============================================================

export interface RolePermissionData {
  id: string;
  permissions: bigint;
  position: number;
  isEveryone?: boolean;
}

export interface PermissionOverwrite {
  id: string; // Role ID or User ID
  type: 'role' | 'member';
  allow: bigint;
  deny: bigint;
}

export interface EffectivePermissionResult {
  permissions: bigint;
  granted: DiscordPermission[];
  denied: DiscordPermission[];
  isAdministrator: boolean;
  isOwner: boolean;
}

// ============================================================
// Core Engine
// ============================================================

/**
 * Compute effective server-level permissions for a member.
 * Follows Discord's algorithm exactly:
 * 1. Owner → all permissions
 * 2. Start with @everyone permissions
 * 3. OR all role permissions
 * 4. ADMINISTRATOR → all permissions
 *
 * V5-Audit §11.1: Validates all incoming permission bigints at the boundary
 * via safePermissionBigInt(). Malformed or out-of-range values are clamped
 * to 0n rather than propagating garbage through bitwise operations.
 */
export function computeServerPermissions(
  memberRoles: RolePermissionData[],
  everyonePermissions: bigint,
  isOwner: boolean,
): bigint {
  if (isOwner) return ALL_PERMISSIONS;

  let permissions = safePermissionBigInt(everyonePermissions) ?? 0n;

  for (const role of memberRoles) {
    if (!role.isEveryone) {
      permissions |= safePermissionBigInt(role.permissions) ?? 0n;
    }
  }

  if ((permissions & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n) {
    return ALL_PERMISSIONS;
  }

  return permissions;
}

/**
 * Compute effective channel-level permissions for a member.
 * Follows Discord's override algorithm:
 * 1. Start with server-level permissions
 * 2. Apply @everyone channel overrides
 * 3. Apply role overrides (deny all first, then allow all)
 * 4. Apply member-specific overrides
 * 5. If VIEW_CHANNEL denied → return 0
 */
/**
 * V5-Audit §11.1: All overwrite allow/deny bigints are validated at the
 * boundary via safePermissionBigInt() before being used in bitwise ops.
 */
export function computeChannelPermissions(
  serverPermissions: bigint,
  overwrites: PermissionOverwrite[],
  memberRoleIds: string[],
  memberId: string,
  everyoneRoleId: string,
  isOwner: boolean,
): bigint {
  // Owner bypasses everything
  if (isOwner) return ALL_PERMISSIONS;

  const validServerPerms = safePermissionBigInt(serverPermissions) ?? 0n;

  // Administrator bypasses channel overrides
  if ((validServerPerms & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n) {
    return ALL_PERMISSIONS;
  }

  let permissions = validServerPerms;

  // 1. @everyone override
  const everyoneOverwrite = overwrites.find(o => o.id === everyoneRoleId && o.type === 'role');
  if (everyoneOverwrite) {
    permissions &= ~(safePermissionBigInt(everyoneOverwrite.deny) ?? 0n);
    permissions |= safePermissionBigInt(everyoneOverwrite.allow) ?? 0n;
  }

  // 2. Role overrides (deny first, then allow — across ALL roles)
  let roleDeny = 0n;
  let roleAllow = 0n;
  const roleIdSet = new Set(memberRoleIds);

  for (const overwrite of overwrites) {
    if (overwrite.type === 'role' && overwrite.id !== everyoneRoleId && roleIdSet.has(overwrite.id)) {
      roleDeny |= safePermissionBigInt(overwrite.deny) ?? 0n;
      roleAllow |= safePermissionBigInt(overwrite.allow) ?? 0n;
    }
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  // 3. Member-specific override
  const memberOverwrite = overwrites.find(o => o.id === memberId && o.type === 'member');
  if (memberOverwrite) {
    permissions &= ~(safePermissionBigInt(memberOverwrite.deny) ?? 0n);
    permissions |= safePermissionBigInt(memberOverwrite.allow) ?? 0n;
  }

  // 4. VIEW_CHANNEL check — if denied, deny everything channel-level
  if ((permissions & DISCORD_PERMISSIONS.VIEW_CHANNEL) === 0n) {
    return 0n;
  }

  return permissions;
}

/**
 * Decompose a permission bitfield into granted and denied permission names.
 */
export function decomposePermissions(permissions: bigint): EffectivePermissionResult {
  const granted: DiscordPermission[] = [];
  const denied: DiscordPermission[] = [];
  const isAdministrator = (permissions & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n;

  for (const [name, bit] of Object.entries(DISCORD_PERMISSIONS)) {
    if ((permissions & bit) !== 0n) {
      granted.push(name as DiscordPermission);
    } else {
      denied.push(name as DiscordPermission);
    }
  }

  return { permissions, granted, denied, isAdministrator, isOwner: false };
}

/**
 * Build permission overwrites from channel template overrides.
 * Maps tier-based overrides to actual role IDs.
 */
export function buildChannelOverwrites(
  templateOverrides: { role_tier: string; allow: DiscordPermission[]; deny: DiscordPermission[] }[],
  tierToRoleIds: Record<string, string[]>,
  everyoneRoleId: string,
): PermissionOverwrite[] {
  const overwrites: PermissionOverwrite[] = [];

  for (const override of templateOverrides) {
    const allow = override.allow.reduce((acc, p) => acc | DISCORD_PERMISSIONS[p], 0n);
    const deny = override.deny.reduce((acc, p) => acc | DISCORD_PERMISSIONS[p], 0n);

    if (override.role_tier === 'everyone') {
      overwrites.push({
        id: everyoneRoleId,
        type: 'role',
        allow,
        deny,
      });
    } else {
      const roleIds = tierToRoleIds[override.role_tier] ?? [];
      for (const roleId of roleIds) {
        overwrites.push({
          id: roleId,
          type: 'role',
          allow,
          deny,
        });
      }
    }
  }

  return overwrites;
}

// ============================================================
// Helpers
// ============================================================

/**
 * V8 Audit §11.P3a — Safely coerce a permission value to bigint.
 * Discord sends permissions as string-encoded integers. If the value
 * is malformed or exceeds the expected range, returns null instead of
 * throwing or producing an unpredictable result.
 *
 * V5 Audit §11.2: Returns null on parse failure instead of 0n,
 * so callers can distinguish "no permissions" (0n) from "bad input" (null).
 *
 * V5 Audit §11.P3a: Widened cap from 64 bits to 128 bits. Discord currently
 * uses ~50 bits but BigInt has no overflow, so we allow headroom for future
 * permission flags without needing a code change.
 */
export function safePermissionBigInt(value: string | number | bigint): bigint | null {
  try {
    const n = BigInt(value);
    if (n < 0n || n > (1n << 128n) - 1n) return null;
    return n;
  } catch {
    return null;
  }
}

// ============================================================
// Exports
// ============================================================

export { ALL_PERMISSIONS };
