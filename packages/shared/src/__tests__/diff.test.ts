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
  });
});
