/**
 * V5 Audit §13.P2b — Shared diff engine unit tests.
 *
 * Covers: computeStateDiff, classifyDrift.
 */

import { describe, it, expect } from 'vitest';
import {
  computeStateDiff,
  classifyDrift,
  type DesiredState,
  type ActualState,
  type DesiredRole,
  type ActualRole,
  type DesiredChannel,
  type DesiredCategory,
  type ActualChannel,
} from '../engine/diff.js';

// ── Helpers ──────────────────────────────────────────────────

function baseDesiredState(overrides?: Partial<DesiredState>): DesiredState {
  return {
    everyonePermissions: '0',
    roles: [],
    categories: [],
    channels: [],
    ...overrides,
  };
}

function baseActualState(overrides?: Partial<ActualState>): ActualState {
  return {
    everyonePermissions: '0',
    roles: [{ id: 'guild-id', name: '@everyone', permissions: '0', color: 0, hoist: false, mentionable: false, position: 0, managed: false }],
    channels: [],
    ...overrides,
  };
}

function makeDesiredRole(key: string, overrides?: Partial<DesiredRole>): DesiredRole {
  return {
    key,
    name: key,
    tier: 'default',
    permissions: '0',
    color: 0,
    hoist: false,
    mentionable: false,
    position: 0,
    ...overrides,
  };
}

function makeActualRole(id: string, overrides?: Partial<ActualRole>): ActualRole {
  return {
    id,
    name: id,
    permissions: '0',
    color: 0,
    hoist: false,
    mentionable: false,
    position: 0,
    managed: false,
    ...overrides,
  };
}

// ── computeStateDiff ─────────────────────────────────────────

describe('computeStateDiff', () => {
  it('returns zero changes for matching empty states', () => {
    const diff = computeStateDiff(baseDesiredState(), baseActualState(), new Map());
    expect(diff.summary.totalChanges).toBe(0);
    expect(diff.everyoneDrift).toBe(false);
  });

  it('detects @everyone drift when permissions are non-zero', () => {
    const diff = computeStateDiff(
      baseDesiredState(),
      baseActualState({ everyonePermissions: '1024' }),
      new Map(),
    );
    expect(diff.everyoneDrift).toBe(true);
    expect(diff.summary.totalChanges).toBe(1);
  });

  it('flags role creation when no ID mapping exists', () => {
    const desired = baseDesiredState({
      roles: [makeDesiredRole('moderator', { name: 'Moderator' })],
    });
    const diff = computeStateDiff(desired, baseActualState(), new Map());
    expect(diff.roles).toHaveLength(1);
    expect(diff.roles[0].action).toBe('create');
    expect(diff.roles[0].name).toBe('Moderator');
    expect(diff.summary.rolesToCreate).toBe(1);
  });

  it('detects role name change as update', () => {
    const idMap = new Map([['role:mod', 'discord-role-1']]);
    const desired = baseDesiredState({
      roles: [makeDesiredRole('mod', { name: 'Moderator-v2' })],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone', managed: false }),
        makeActualRole('discord-role-1', { name: 'Moderator' }),
      ],
    });
    const diff = computeStateDiff(desired, actual, idMap);
    expect(diff.roles).toHaveLength(1);
    expect(diff.roles[0].action).toBe('update');
    expect(diff.roles[0].changes?.['name']).toEqual({ from: 'Moderator', to: 'Moderator-v2' });
  });

  it('preserves the old Discord ID when a mapped role is missing', () => {
    const idMap = new Map([['role:mod', 'deleted-role-1']]);
    const desired = baseDesiredState({
      roles: [makeDesiredRole('mod', { name: 'Moderator' })],
    });
    const diff = computeStateDiff(desired, baseActualState(), idMap);

    expect(diff.roles).toHaveLength(1);
    expect(diff.roles[0]).toMatchObject({
      action: 'create',
      key: 'mod',
      discordId: 'deleted-role-1',
    });
  });

  it('flags extra (unmanaged, non-everyone) roles for deletion', () => {
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('rogue-role', { name: 'Rogue', managed: false }),
      ],
    });
    const diff = computeStateDiff(baseDesiredState(), actual, new Map());
    expect(diff.roles).toHaveLength(1);
    expect(diff.roles[0].action).toBe('delete');
    expect(diff.summary.rolesToDelete).toBe(1);
  });

  it('does NOT flag managed (bot) roles for deletion', () => {
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('bot-role', { name: 'BotRole', managed: true }),
      ],
    });
    const diff = computeStateDiff(baseDesiredState(), actual, new Map());
    expect(diff.roles).toHaveLength(0);
  });

  it('detects channel creation, update, and deletion', () => {
    const idMap = new Map([['channel:general', 'ch-1']]);
    const desired = baseDesiredState({
      channels: [
        {
          key: 'general',
          name: 'general-renamed',
          type: 0,
          categoryKey: null,
          position: 0,
          topic: 'new topic',
          slowmode: 5,
          nsfw: false,
          templateId: 't1',
          overrides: [],
        } as DesiredChannel,
        {
          key: 'new-chan',
          name: 'new-channel',
          type: 0,
          categoryKey: null,
          position: 1,
          topic: null,
          slowmode: 0,
          nsfw: false,
          templateId: 't2',
          overrides: [],
        } as DesiredChannel,
      ],
    });
    const actual = baseActualState({
      channels: [
        {
          id: 'ch-1',
          name: 'general',
          type: 0,
          parentId: null,
          position: 0,
          topic: 'old topic',
          rateLimitPerUser: 0,
          nsfw: false,
          overwrites: [],
        } as ActualChannel,
        {
          id: 'ch-extra',
          name: 'extra',
          type: 0,
          parentId: null,
          position: 2,
          topic: null,
          rateLimitPerUser: 0,
          nsfw: false,
          overwrites: [],
        } as ActualChannel,
      ],
    });
    const diff = computeStateDiff(desired, actual, idMap);

    // general → update (name + topic + slowmode changed)
    const update = diff.channels.find(d => d.key === 'general');
    expect(update?.action).toBe('update');
    expect(update?.changes?.['name']).toEqual({ from: 'general', to: 'general-renamed' });

    // new-channel → create
    const create = diff.channels.find(d => d.key === 'new-chan');
    expect(create?.action).toBe('create');

    // extra → delete (not in desired)
    const del = diff.channels.find(d => d.name === 'extra');
    expect(del?.action).toBe('delete');

    expect(diff.summary.hasBreakingChanges).toBe(true);
  });

  it('detects permission override drift on channels', () => {
    const idMap = new Map([
      ['channel:general', 'ch-1'],
      ['role:mod', 'role-1'],
    ]);
    const desired = baseDesiredState({
      channels: [{
        key: 'general',
        name: 'general',
        type: 0,
        categoryKey: null,
        position: 0,
        topic: null,
        slowmode: 0,
        nsfw: false,
        templateId: 't1',
        overrides: [{ roleKey: 'mod', allow: '2048', deny: '0' }],
      }],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('role-1', { name: 'mod' }),
      ],
      channels: [{
        id: 'ch-1',
        name: 'general',
        type: 0,
        parentId: null,
        position: 0,
        topic: null,
        rateLimitPerUser: 0,
        nsfw: false,
        overwrites: [{ id: 'role-1', type: 'role' as const, allow: '1024', deny: '0' }],
      }],
    });
    const diff = computeStateDiff(desired, actual, idMap);
    expect(diff.overrides).toHaveLength(1);
    expect(diff.overrides[0].action).toBe('update');
  });
});

// ── classifyDrift ────────────────────────────────────────────

describe('classifyDrift', () => {
  it('classifies @everyone drift as critical', () => {
    const diff = computeStateDiff(
      baseDesiredState(),
      baseActualState({ everyonePermissions: '8' }),
      new Map(),
    );
    const items = classifyDrift(diff);
    const evDrift = items.find(i => i.type === 'EVERYONE_DRIFT');
    expect(evDrift).toBeDefined();
    expect(evDrift!.severity).toBe('critical');
    expect(evDrift!.suggestedAction).toBe('repair');
  });

  it('classifies role update with permission change as warning', () => {
    const idMap = new Map([['role:mod', 'role-1']]);
    const diff = computeStateDiff(
      baseDesiredState({ roles: [makeDesiredRole('mod', { name: 'Mod', permissions: '2048' })] }),
      baseActualState({
        roles: [
          makeActualRole('guild-id', { name: '@everyone' }),
          makeActualRole('role-1', { name: 'Mod', permissions: '1024' }),
        ],
      }),
      idMap,
    );
    const items = classifyDrift(diff);
    const roleDrift = items.find(i => i.entityType === 'role');
    expect(roleDrift).toBeDefined();
    expect(roleDrift!.type).toBe('PERMISSION_DRIFT');
    expect(roleDrift!.severity).toBe('warning');
    expect(roleDrift!.templateKey).toBe('mod');
  });

  it('classifies a mapped deleted role with the old ID and template key', () => {
    const idMap = new Map([['role:mod', 'deleted-role-1']]);
    const diff = computeStateDiff(
      baseDesiredState({ roles: [makeDesiredRole('mod', { name: 'Moderator' })] }),
      baseActualState(),
      idMap,
    );
    const items = classifyDrift(diff);
    const missing = items.find(i => i.type === 'MISSING_RESOURCE');

    expect(missing).toMatchObject({
      entityType: 'role',
      entityName: 'Moderator',
      entityDiscordId: 'deleted-role-1',
      templateKey: 'mod',
    });
  });

  it('classifies a mapped deleted channel with the old ID and template key', () => {
    const idMap = new Map([['channel:rules', 'deleted-channel-1']]);
    const diff = computeStateDiff(
      baseDesiredState({
        channels: [{
          key: 'rules',
          name: 'rules',
          type: 0,
          categoryKey: null,
          position: 0,
          topic: null,
          slowmode: 0,
          nsfw: false,
          templateId: 't-rules',
          overrides: [],
        } as DesiredChannel],
      }),
      baseActualState(),
      idMap,
    );
    const items = classifyDrift(diff);
    const missing = items.find(i => i.type === 'MISSING_RESOURCE' && i.entityType === 'channel');

    expect(missing).toMatchObject({
      entityType: 'channel',
      entityName: 'rules',
      entityDiscordId: 'deleted-channel-1',
      templateKey: 'rules',
    });
  });

  it('classifies a mapped deleted category with the old ID and template key', () => {
    const idMap = new Map([['category:onboarding', 'deleted-category-1']]);
    const diff = computeStateDiff(
      baseDesiredState({
        categories: [{
          key: 'onboarding',
          name: 'Onboarding',
          position: 0,
        } as DesiredCategory],
      }),
      baseActualState(),
      idMap,
    );
    const items = classifyDrift(diff);
    const missing = items.find(i => i.type === 'MISSING_RESOURCE' && i.entityType === 'category');

    expect(missing).toMatchObject({
      entityType: 'category',
      entityName: 'Onboarding',
      entityDiscordId: 'deleted-category-1',
      templateKey: 'onboarding',
    });
  });

  it('classifies extra roles as info-level EXTRA_RESOURCE', () => {
    const diff = computeStateDiff(
      baseDesiredState(),
      baseActualState({
        roles: [
          makeActualRole('guild-id', { name: '@everyone' }),
          makeActualRole('orphan', { name: 'Orphan' }),
        ],
      }),
      new Map(),
    );
    const items = classifyDrift(diff);
    const extra = items.find(i => i.type === 'EXTRA_RESOURCE');
    expect(extra).toBeDefined();
    expect(extra!.severity).toBe('info');
    expect(extra!.suggestedAction).toBe('accept');
  });

  it('classifies override drift as PERMISSION_DRIFT warning', () => {
    const idMap = new Map([['channel:gen', 'ch-1'], ['role:mod', 'role-1']]);
    const diff = computeStateDiff(
      baseDesiredState({
        channels: [{
          key: 'gen', name: 'gen', type: 0, categoryKey: null, position: 0,
          topic: null, slowmode: 0, nsfw: false, templateId: 't', overrides: [{ roleKey: 'mod', allow: '2048', deny: '0' }],
        }],
      }),
      baseActualState({
        roles: [makeActualRole('guild-id', { name: '@everyone' }), makeActualRole('role-1', { name: 'mod' })],
        channels: [{
          id: 'ch-1', name: 'gen', type: 0, parentId: null, position: 0,
          topic: null, rateLimitPerUser: 0, nsfw: false,
          overwrites: [{ id: 'role-1', type: 'role' as const, allow: '0', deny: '0' }],
        }],
      }),
      idMap,
    );
    const items = classifyDrift(diff);
    const overDrift = items.find(i => i.type === 'PERMISSION_DRIFT');
    expect(overDrift).toBeDefined();
    expect(overDrift!.severity).toBe('warning');
    expect(overDrift).toMatchObject({
      entityType: 'channel',
      entityName: 'gen → mod',
      entityDiscordId: 'ch-1',
      templateKey: 'gen',
      details: {
        overrideChannelKey: { expected: 'gen', actual: 'gen' },
        overrideRoleKey: { expected: 'mod', actual: 'mod' },
        overrideRoleId: { expected: 'role-1', actual: 'role-1' },
        overrideAction: { expected: 'update', actual: 'update' },
        allow: { expected: '2048', actual: '0' },
        deny: { expected: '0', actual: '0' },
      },
    });
  });
});

// ── Role hierarchy drift (reachability of HIERARCHY_DRIFT) ────
// These prove the PRODUCTION classifier emits HIERARCHY_DRIFT for real role
// position moves — the sync-engine reorder repair is only reachable because of
// this. Without a real producer, that repair branch would be dead code.
describe('computeStateDiff — role hierarchy drift', () => {
  it('detects hierarchy drift when mapped roles are out of desired order', () => {
    // Desired: member(0) < mod(1) < admin(2). Actual Discord positions scramble
    // mod above admin, so the desired order is no longer reflected.
    const desired = baseDesiredState({
      roles: [
        makeDesiredRole('admin', { position: 2 }),
        makeDesiredRole('mod', { position: 1 }),
        makeDesiredRole('member', { position: 0 }),
      ],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('r-admin', { position: 3 }),
        makeActualRole('r-mod', { position: 10 }), // drifted above admin
        makeActualRole('r-member', { position: 1 }),
      ],
    });
    const idMap = new Map<string, string>([
      ['role:admin', 'r-admin'],
      ['role:mod', 'r-mod'],
      ['role:member', 'r-member'],
    ]);

    const diff = computeStateDiff(desired, actual, idMap);
    expect(diff.roleHierarchyDrift).toBe(true);
    expect(diff.roleHierarchyDriftId).toBeDefined();
    expect(diff.roleHierarchyDriftKey).toBeDefined();
  });

  it('reports no hierarchy drift when mapped roles are in desired order', () => {
    const desired = baseDesiredState({
      roles: [
        makeDesiredRole('admin', { position: 2 }),
        makeDesiredRole('mod', { position: 1 }),
        makeDesiredRole('member', { position: 0 }),
      ],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('r-admin', { position: 12 }),
        makeActualRole('r-mod', { position: 11 }),
        makeActualRole('r-member', { position: 10 }),
      ],
    });
    const idMap = new Map<string, string>([
      ['role:admin', 'r-admin'],
      ['role:mod', 'r-mod'],
      ['role:member', 'r-member'],
    ]);

    const diff = computeStateDiff(desired, actual, idMap);
    expect(diff.roleHierarchyDrift).toBe(false);
  });

  it('resolves roles from unprefixed ID-map keys (deploy-listener shape)', () => {
    // deploy-listener persists template_key = raw key (no "role:" prefix).
    const desired = baseDesiredState({
      roles: [
        makeDesiredRole('admin', { position: 1 }),
        makeDesiredRole('member', { position: 0 }),
      ],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('r-admin', { position: 2 }),
        makeActualRole('r-member', { position: 5 }), // member above admin → drift
      ],
    });
    const idMap = new Map<string, string>([
      ['admin', 'r-admin'],
      ['member', 'r-member'],
    ]);

    const diff = computeStateDiff(desired, actual, idMap);
    expect(diff.roleHierarchyDrift).toBe(true);
  });

  it('does NOT flag drift when adjacent roles share the same actual position (tie)', () => {
    // Discord role positions are not guaranteed unique. Two desired roles that
    // legitimately resolve to the same numeric position are NOT an inversion —
    // reporting drift here would fire forever and the repair could never clear it.
    const desired = baseDesiredState({
      roles: [
        makeDesiredRole('admin', { position: 1 }),
        makeDesiredRole('member', { position: 0 }),
      ],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('r-admin', { position: 7 }),
        makeActualRole('r-member', { position: 7 }), // tie with admin
      ],
    });
    const idMap = new Map<string, string>([
      ['role:admin', 'r-admin'],
      ['role:member', 'r-member'],
    ]);

    const diff = computeStateDiff(desired, actual, idMap);
    expect(diff.roleHierarchyDrift).toBe(false);
  });

  it('flags drift on a strict inversion even when another pair ties', () => {
    // member(0) < mod(1) < admin(2) desired. Actual: member ties mod (both 5),
    // but admin sits strictly below mod → a real inversion at admin.
    const desired = baseDesiredState({
      roles: [
        makeDesiredRole('admin', { position: 2 }),
        makeDesiredRole('mod', { position: 1 }),
        makeDesiredRole('member', { position: 0 }),
      ],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('r-admin', { position: 3 }), // below mod → inversion
        makeActualRole('r-mod', { position: 5 }),
        makeActualRole('r-member', { position: 5 }), // ties mod, benign
      ],
    });
    const idMap = new Map<string, string>([
      ['role:admin', 'r-admin'],
      ['role:mod', 'r-mod'],
      ['role:member', 'r-member'],
    ]);

    const diff = computeStateDiff(desired, actual, idMap);
    expect(diff.roleHierarchyDrift).toBe(true);
  });

  it('disambiguates bare role keys by entity type so a channel mapping cannot mask a role', () => {
    // Both a role and a channel are keyed with the bare template_key "staff".
    // deploy-listener persists bare keys, and the flat idMap can only hold one
    // "staff" entry — here the CHANNEL row won (last writer), so a naive bare
    // lookup for role "staff" would resolve to the channel's Discord ID, the
    // role would be dropped from the hierarchy comparison, and a real inversion
    // would go undetected. The entity-typed map must rescue the role lookup.
    const desired = baseDesiredState({
      roles: [
        makeDesiredRole('staff', { position: 1 }),
        makeDesiredRole('member', { position: 0 }),
      ],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('r-staff', { position: 2 }),
        makeActualRole('r-member', { position: 7 }), // member above staff → inversion
      ],
    });
    // Flat map: the channel "staff" clobbered the role "staff" (bare-key collision).
    const idMap = new Map<string, string>([
      ['staff', 'c-staff-channel'], // channel id, NOT the role
      ['member', 'r-member'],
    ]);
    // Entity-typed map preserves entity_type from the real table primary key.
    const entityIdMap = new Map<string, string>([
      ['role:staff', 'r-staff'],
      ['channel:staff', 'c-staff-channel'],
      ['role:member', 'r-member'],
    ]);

    // Without the entity map the collision would hide the drift…
    const naive = computeStateDiff(desired, actual, idMap);
    expect(naive.roleHierarchyDrift).toBe(false); // role "staff" dropped → no pair

    // …but with it, the role resolves correctly and the inversion is detected.
    // The representative is the higher-desired role sitting too low: "staff".
    const diff = computeStateDiff(desired, actual, idMap, entityIdMap);
    expect(diff.roleHierarchyDrift).toBe(true);
    expect(diff.roleHierarchyDriftKey).toBe('staff');
    expect(diff.roleHierarchyDriftId).toBe('r-staff');
  });

  it('rejects a bare-key flat-map hit that belongs to another entity type', () => {
    // No prefixed and no entity-typed role entry for "staff" — only a bare
    // flat-map entry that actually points at a channel. The isForeignEntityId
    // guard must refuse it rather than resolving the role to a channel ID.
    const desired = baseDesiredState({
      roles: [
        makeDesiredRole('staff', { position: 1 }),
        makeDesiredRole('member', { position: 0 }),
      ],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('r-member', { position: 7 }),
      ],
    });
    const idMap = new Map<string, string>([
      ['staff', 'c-staff-channel'], // bare hit, but it's a channel
      ['member', 'r-member'],
    ]);
    const entityIdMap = new Map<string, string>([
      ['channel:staff', 'c-staff-channel'],
      ['role:member', 'r-member'],
    ]);

    const diff = computeStateDiff(desired, actual, idMap, entityIdMap);
    // Only "member" resolves to a live role → fewer than two → no false drift,
    // and crucially "staff" did NOT resolve to the channel id.
    expect(diff.roleHierarchyDrift).toBe(false);
  });

  it('ignores managed roles when evaluating hierarchy order', () => {
    const desired = baseDesiredState({
      roles: [
        makeDesiredRole('bot', { position: 1 }),
        makeDesiredRole('member', { position: 0 }),
      ],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('r-bot', { position: 5, managed: true }), // integration role
        makeActualRole('r-member', { position: 10 }),
      ],
    });
    const idMap = new Map<string, string>([
      ['role:bot', 'r-bot'],
      ['role:member', 'r-member'],
    ]);

    // Only one non-managed mapped role remains → cannot be "out of order".
    const diff = computeStateDiff(desired, actual, idMap);
    expect(diff.roleHierarchyDrift).toBe(false);
  });
});

describe('classifyDrift — HIERARCHY_DRIFT emission', () => {
  it('emits a repairable HIERARCHY_DRIFT item from a real drifted diff', () => {
    const desired = baseDesiredState({
      roles: [
        makeDesiredRole('admin', { position: 2, name: 'Admin' }),
        makeDesiredRole('mod', { position: 1, name: 'Mod' }),
        makeDesiredRole('member', { position: 0, name: 'Member' }),
      ],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('r-admin', { name: 'Admin', position: 3 }),
        makeActualRole('r-mod', { name: 'Mod', position: 10 }),
        makeActualRole('r-member', { name: 'Member', position: 1 }),
      ],
    });
    const idMap = new Map<string, string>([
      ['role:admin', 'r-admin'],
      ['role:mod', 'r-mod'],
      ['role:member', 'r-member'],
    ]);

    const diff = computeStateDiff(desired, actual, idMap);
    const items = classifyDrift(diff);
    const hierarchy = items.find(i => i.type === 'HIERARCHY_DRIFT');
    expect(hierarchy).toBeDefined();
    expect(hierarchy).toMatchObject({
      type: 'HIERARCHY_DRIFT',
      entityType: 'role',
      suggestedAction: 'repair',
    });
    expect(hierarchy!.entityDiscordId).toBeDefined();
    expect(hierarchy!.templateKey).toBeDefined();
  });

  it('does not emit HIERARCHY_DRIFT when ordering matches', () => {
    const desired = baseDesiredState({
      roles: [
        makeDesiredRole('admin', { position: 1 }),
        makeDesiredRole('member', { position: 0 }),
      ],
    });
    const actual = baseActualState({
      roles: [
        makeActualRole('guild-id', { name: '@everyone' }),
        makeActualRole('r-admin', { position: 5 }),
        makeActualRole('r-member', { position: 2 }),
      ],
    });
    const idMap = new Map<string, string>([
      ['role:admin', 'r-admin'],
      ['role:member', 'r-member'],
    ]);

    const items = classifyDrift(computeStateDiff(desired, actual, idMap));
    expect(items.find(i => i.type === 'HIERARCHY_DRIFT')).toBeUndefined();
  });
});
