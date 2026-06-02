/**
 * Bot Role Guard — Full tests
 *
 * Tests checkBotRolePosition and checkBotPermissions.
 * Covers: bot not in guild, bot at top, roles above bot,
 * managed roles ignored, all permissions present, missing permissions,
 * Administrator bypass.
 */
import { describe, it, expect } from 'vitest';
import { checkBotRolePosition, checkBotPermissions } from '../guards/bot-role-guard.js';

class MockCollection extends Map {
  filter(fn: (v: any, k: string) => boolean): MockCollection {
    const result = new MockCollection();
    for (const [k, v] of this) if (fn(v, k)) result.set(k, v);
    return result;
  }
  sort(fn: (a: any, b: any) => number): MockCollection {
    const arr = [...this.values()].sort(fn);
    const result = new MockCollection();
    for (const v of arr) result.set(v.id, v);
    return result;
  }
  map(fn: (v: any) => any): any[] {
    return [...this.values()].map(fn);
  }
}

function makeGuild(opts: {
  botPosition?: number;
  roles?: { id: string; name: string; position: number; managed?: boolean }[];
  hasBot?: boolean;
  permissions?: Set<string> | 'admin';
} = {}) {
  const {
    botPosition = 10,
    roles = [],
    hasBot = true,
    permissions = new Set([
      'ManageRoles', 'ManageChannels', 'ManageGuild', 'ViewAuditLog',
      'KickMembers', 'BanMembers', 'ManageWebhooks', 'SendMessages',
      'EmbedLinks', 'ManageMessages', 'ViewChannel',
    ]),
  } = opts;

  const roleCache = new MockCollection();
  for (const r of roles) {
    roleCache.set(r.id, { ...r, managed: r.managed ?? false });
  }

  const permHas = (perm: string) => {
    if (permissions === 'admin') return perm === 'Administrator' ? true : true;
    return permissions.has(perm);
  };

  return {
    id: 'guild1',
    roles: { cache: roleCache },
    members: {
      me: hasBot ? {
        roles: { highest: { position: botPosition } },
        permissions: { has: permHas },
      } : null,
    },
  } as any;
}

describe('checkBotRolePosition', () => {
  it('returns false when bot is not in guild', async () => {
    const guild = makeGuild({ hasBot: false });
    const result = await checkBotRolePosition(guild);
    expect(result.isTopPosition).toBe(false);
    expect(result.botRolePosition).toBe(-1);
    expect(result.canManageAllRoles).toBe(false);
  });

  it('returns true when no roles above bot', async () => {
    const guild = makeGuild({
      botPosition: 10,
      roles: [
        { id: 'guild1', name: '@everyone', position: 0 },
        { id: 'bot-role', name: 'SomniBot', position: 10, managed: true },
        { id: 'mod', name: 'Mod', position: 5 },
      ],
    });
    const result = await checkBotRolePosition(guild);
    expect(result.isTopPosition).toBe(true);
    expect(result.canManageAllRoles).toBe(true);
    expect(result.rolesAboveBot).toHaveLength(0);
  });

  it('returns false when non-managed roles are above bot', async () => {
    const guild = makeGuild({
      botPosition: 5,
      roles: [
        { id: 'guild1', name: '@everyone', position: 0 },
        { id: 'admin', name: 'Admin', position: 10 },
        { id: 'mod', name: 'Mod', position: 3 },
      ],
    });
    const result = await checkBotRolePosition(guild);
    expect(result.isTopPosition).toBe(false);
    expect(result.rolesAboveBot).toHaveLength(1);
    expect(result.rolesAboveBot[0].name).toBe('Admin');
  });

  it('ignores managed roles above bot', async () => {
    const guild = makeGuild({
      botPosition: 5,
      roles: [
        { id: 'guild1', name: '@everyone', position: 0 },
        { id: 'booster', name: 'Server Booster', position: 10, managed: true },
      ],
    });
    const result = await checkBotRolePosition(guild);
    expect(result.isTopPosition).toBe(true);
  });

  it('ignores @everyone role (guild id) above bot', async () => {
    const guild = makeGuild({
      botPosition: 5,
      roles: [
        { id: 'guild1', name: '@everyone', position: 0 },
      ],
    });
    const result = await checkBotRolePosition(guild);
    expect(result.isTopPosition).toBe(true);
  });

  it('reports correct totalRoles', async () => {
    const guild = makeGuild({
      botPosition: 10,
      roles: [
        { id: 'guild1', name: '@everyone', position: 0 },
        { id: 'r1', name: 'Role1', position: 3 },
        { id: 'r2', name: 'Role2', position: 5 },
      ],
    });
    const result = await checkBotRolePosition(guild);
    expect(result.totalRoles).toBe(3);
  });
});

describe('checkBotPermissions', () => {
  it('returns false when bot is not in guild', () => {
    const guild = makeGuild({ hasBot: false });
    const result = checkBotPermissions(guild);
    expect(result.hasRequired).toBe(false);
    expect(result.missing).toContain('BOT_NOT_IN_GUILD');
  });

  it('returns true when all permissions present', () => {
    const guild = makeGuild();
    const result = checkBotPermissions(guild);
    expect(result.hasRequired).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('reports missing permissions', () => {
    const guild = makeGuild({
      permissions: new Set(['ManageRoles', 'ManageChannels']),
    });
    const result = checkBotPermissions(guild);
    expect(result.hasRequired).toBe(false);
    expect(result.missing).toContain('ManageGuild');
    expect(result.missing).toContain('KickMembers');
    expect(result.missing).not.toContain('ManageRoles');
  });

  it('Administrator bypasses all checks', () => {
    const guild = makeGuild({ permissions: 'admin' });
    const result = checkBotPermissions(guild);
    expect(result.hasRequired).toBe(true);
    expect(result.missing).toHaveLength(0);
  });
});
