/**
 * V5 Audit §13.P2b — Shared permission engine unit tests.
 *
 * Covers: computeServerPermissions, computeChannelPermissions,
 *         decomposePermissions, buildChannelOverwrites, safePermissionBigInt.
 */

import { describe, it, expect } from 'vitest';
import {
  computeServerPermissions,
  computeChannelPermissions,
  decomposePermissions,
  buildChannelOverwrites,
  safePermissionBigInt,
  ALL_PERMISSIONS,
  type RolePermissionData,
  type PermissionOverwrite,
} from '../engine/permissions.js';
import { DISCORD_PERMISSIONS } from '../constants/permissions.js';

// ── Helpers ──────────────────────────────────────────────────

const ADMIN = DISCORD_PERMISSIONS.ADMINISTRATOR;
const SEND = DISCORD_PERMISSIONS.SEND_MESSAGES;
const VIEW = DISCORD_PERMISSIONS.VIEW_CHANNEL;
const MANAGE_ROLES = DISCORD_PERMISSIONS.MANAGE_ROLES;
const EMBED = DISCORD_PERMISSIONS.EMBED_LINKS;

function makeRole(overrides: Partial<RolePermissionData> & { id: string }): RolePermissionData {
  return { permissions: 0n, position: 0, isEveryone: false, ...overrides };
}

// ── computeServerPermissions ─────────────────────────────────

describe('computeServerPermissions', () => {
  it('grants ALL_PERMISSIONS to server owner', () => {
    const perms = computeServerPermissions([], 0n, true);
    expect(perms).toBe(ALL_PERMISSIONS);
  });

  it('starts with @everyone permissions', () => {
    const perms = computeServerPermissions([], VIEW | SEND, false);
    expect(perms & VIEW).toBe(VIEW);
    expect(perms & SEND).toBe(SEND);
  });

  it('ORs role permissions onto @everyone base', () => {
    const roles: RolePermissionData[] = [
      makeRole({ id: '1', permissions: EMBED }),
      makeRole({ id: '2', permissions: MANAGE_ROLES }),
    ];
    const perms = computeServerPermissions(roles, VIEW, false);
    expect(perms & VIEW).toBe(VIEW);
    expect(perms & EMBED).toBe(EMBED);
    expect(perms & MANAGE_ROLES).toBe(MANAGE_ROLES);
  });

  it('escalates ADMINISTRATOR to ALL_PERMISSIONS', () => {
    const roles: RolePermissionData[] = [makeRole({ id: '1', permissions: ADMIN })];
    const perms = computeServerPermissions(roles, 0n, false);
    expect(perms).toBe(ALL_PERMISSIONS);
  });

  it('skips @everyone-tagged roles in the role loop', () => {
    const roles: RolePermissionData[] = [
      makeRole({ id: 'everyone', permissions: EMBED, isEveryone: true }),
    ];
    // EMBED should NOT be added because isEveryone is true — only the base param counts
    const perms = computeServerPermissions(roles, VIEW, false);
    expect(perms & EMBED).toBe(0n);
  });
});

// ── computeChannelPermissions ────────────────────────────────

describe('computeChannelPermissions', () => {
  const everyoneId = 'guild-id';

  it('returns ALL_PERMISSIONS for owner', () => {
    const perms = computeChannelPermissions(VIEW, [], [], 'user', everyoneId, true);
    expect(perms).toBe(ALL_PERMISSIONS);
  });

  it('returns ALL_PERMISSIONS for administrator', () => {
    const perms = computeChannelPermissions(ALL_PERMISSIONS, [], [], 'user', everyoneId, false);
    expect(perms).toBe(ALL_PERMISSIONS);
  });

  it('applies @everyone deny override', () => {
    const overwrites: PermissionOverwrite[] = [
      { id: everyoneId, type: 'role', allow: 0n, deny: SEND },
    ];
    const perms = computeChannelPermissions(VIEW | SEND, overwrites, [], 'user', everyoneId, false);
    expect(perms & SEND).toBe(0n);
    expect(perms & VIEW).toBe(VIEW);
  });

  it('applies role overrides (deny then allow across all roles)', () => {
    const overwrites: PermissionOverwrite[] = [
      { id: 'role-a', type: 'role', allow: 0n, deny: SEND },
      { id: 'role-b', type: 'role', allow: EMBED, deny: 0n },
    ];
    const perms = computeChannelPermissions(
      VIEW | SEND,
      overwrites,
      ['role-a', 'role-b'],
      'user',
      everyoneId,
      false,
    );
    // SEND denied by role-a, EMBED allowed by role-b
    expect(perms & SEND).toBe(0n);
    expect(perms & EMBED).toBe(EMBED);
  });

  it('applies member-specific override (overrides role deny)', () => {
    const overwrites: PermissionOverwrite[] = [
      { id: 'role-a', type: 'role', allow: 0n, deny: SEND },
      { id: 'user', type: 'member', allow: SEND, deny: 0n },
    ];
    const perms = computeChannelPermissions(VIEW | SEND, overwrites, ['role-a'], 'user', everyoneId, false);
    // Member override re-allows SEND
    expect(perms & SEND).toBe(SEND);
  });

  it('returns 0n when VIEW_CHANNEL is denied', () => {
    const overwrites: PermissionOverwrite[] = [
      { id: everyoneId, type: 'role', allow: 0n, deny: VIEW },
    ];
    const perms = computeChannelPermissions(VIEW | SEND, overwrites, [], 'user', everyoneId, false);
    expect(perms).toBe(0n);
  });
});

// ── decomposePermissions ─────────────────────────────────────

describe('decomposePermissions', () => {
  it('lists granted permissions', () => {
    const result = decomposePermissions(VIEW | SEND);
    expect(result.granted).toContain('VIEW_CHANNEL');
    expect(result.granted).toContain('SEND_MESSAGES');
    expect(result.isAdministrator).toBe(false);
  });

  it('detects administrator flag', () => {
    const result = decomposePermissions(ADMIN);
    expect(result.isAdministrator).toBe(true);
    expect(result.granted).toContain('ADMINISTRATOR');
  });

  it('puts missing bits in denied', () => {
    const result = decomposePermissions(VIEW);
    expect(result.denied).toContain('ADMINISTRATOR');
    expect(result.denied).toContain('SEND_MESSAGES');
  });
});

// ── buildChannelOverwrites ───────────────────────────────────

describe('buildChannelOverwrites', () => {
  const everyoneId = 'guild-id';

  it('maps "everyone" tier to @everyone role', () => {
    const result = buildChannelOverwrites(
      [{ role_tier: 'everyone', allow: ['VIEW_CHANNEL'], deny: ['SEND_MESSAGES'] }],
      {},
      everyoneId,
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(everyoneId);
    expect(result[0].type).toBe('role');
    expect(result[0].allow).toBe(VIEW);
    expect(result[0].deny).toBe(SEND);
  });

  it('maps tier to multiple role IDs', () => {
    const result = buildChannelOverwrites(
      [{ role_tier: 'vip', allow: ['EMBED_LINKS'], deny: [] }],
      { vip: ['role-1', 'role-2'] },
      everyoneId,
    );
    expect(result).toHaveLength(2);
    expect(result.every((o) => o.allow === EMBED)).toBe(true);
  });

  it('returns empty array for unknown tier', () => {
    const result = buildChannelOverwrites(
      [{ role_tier: 'nonexistent', allow: ['VIEW_CHANNEL'], deny: [] }],
      {},
      everyoneId,
    );
    expect(result).toHaveLength(0);
  });
});

// ── safePermissionBigInt ─────────────────────────────────────

describe('safePermissionBigInt', () => {
  it('converts string to bigint', () => {
    expect(safePermissionBigInt('8')).toBe(8n);
  });

  it('passes through bigint', () => {
    expect(safePermissionBigInt(1024n)).toBe(1024n);
  });

  it('converts number to bigint', () => {
    expect(safePermissionBigInt(32)).toBe(32n);
  });

  it('returns 0n for negative values', () => {
    expect(safePermissionBigInt(-1)).toBe(0n);
  });

  it('returns 0n for malformed strings', () => {
    expect(safePermissionBigInt('not-a-number')).toBe(0n);
  });

  it('returns 0n for values exceeding 64-bit range', () => {
    expect(safePermissionBigInt((1n << 64n))).toBe(0n);
  });
});
