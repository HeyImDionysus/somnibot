/**
 * Snapshot — Full tests
 *
 * Tests takeSnapshot: role extraction, channel extraction with overrides,
 * @everyone permissions, DM/thread filtering, category support.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildStageVoice: 13 },
}));

import { takeSnapshot } from '../sync/snapshot.js';

class MockCollection extends Map {
  map(fn: (v: any, k: string) => any): any[] {
    const result: any[] = [];
    for (const [k, v] of this) result.push(fn(v, k));
    return result;
  }
  filter(fn: (v: any, k: string) => boolean): MockCollection {
    const result = new MockCollection();
    for (const [k, v] of this) if (fn(v, k)) result.set(k, v);
    return result;
  }
}

function makeGuild(opts: { roles?: any[]; channels?: any[] } = {}) {
  const roleCache = new MockCollection();
  const everyone = {
    id: 'guild1',
    name: '@everyone',
    permissions: { bitfield: 0n },
    color: 0,
    hoist: false,
    mentionable: false,
    position: 0,
    managed: false,
  };
  roleCache.set('guild1', everyone);

  for (const r of opts.roles ?? []) {
    const { permissions: rawPerm, ...rest } = r;
    roleCache.set(r.id, {
      permissions: { bitfield: BigInt(rawPerm ?? '0') },
      color: r.color ?? 0,
      hoist: r.hoist ?? false,
      mentionable: r.mentionable ?? false,
      position: r.position ?? 1,
      managed: r.managed ?? false,
      ...rest,
    });
  }

  const channelCache = new MockCollection();
  for (const ch of opts.channels ?? []) {
    const overwriteCache = new MockCollection();
    for (const ow of ch.overwrites ?? []) {
      overwriteCache.set(ow.id, {
        id: ow.id,
        type: ow.type ?? 0,
        allow: { bitfield: BigInt(ow.allow ?? '0') },
        deny: { bitfield: BigInt(ow.deny ?? '0') },
      });
    }
    channelCache.set(ch.id, {
      id: ch.id,
      name: ch.name,
      type: ch.type ?? 0,
      parentId: ch.parentId ?? null,
      position: ch.position ?? 0,
      topic: ch.topic ?? null,
      rateLimitPerUser: ch.rateLimitPerUser ?? 0,
      nsfw: ch.nsfw ?? false,
      permissionOverwrites: { cache: overwriteCache },
    });
  }

  return {
    id: 'guild1',
    roles: {
      cache: roleCache,
      everyone,
      fetch: vi.fn(async () => roleCache),
    },
    channels: {
      cache: channelCache,
      fetch: vi.fn(async () => channelCache),
    },
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe('takeSnapshot', () => {
  it('fetches fresh role and channel data', async () => {
    const guild = makeGuild();
    await takeSnapshot(guild);
    expect(guild.roles.fetch).toHaveBeenCalled();
    expect(guild.channels.fetch).toHaveBeenCalled();
  });

  it('extracts @everyone permissions', async () => {
    const guild = makeGuild();
    const snapshot = await takeSnapshot(guild);
    expect(snapshot.everyonePermissions).toBe('0');
  });

  it('maps @everyone role name correctly', async () => {
    const guild = makeGuild();
    const snapshot = await takeSnapshot(guild);
    const evRole = snapshot.roles.find((r: any) => r.id === 'guild1');
    expect(evRole?.name).toBe('@everyone');
  });

  it('extracts regular roles', async () => {
    const guild = makeGuild({
      roles: [
        { id: 'r1', name: 'Mod', permissions: '8', color: 0xFF0000, hoist: true, mentionable: false, position: 5, managed: false },
      ],
    });
    const snapshot = await takeSnapshot(guild);
    const mod = snapshot.roles.find((r: any) => r.id === 'r1');
    expect(mod).toBeDefined();
    expect(mod?.name).toBe('Mod');
    expect(mod?.permissions).toBe('8');
    expect(mod?.color).toBe(0xFF0000);
    expect(mod?.hoist).toBe(true);
    expect(mod?.managed).toBe(false);
  });

  it('extracts channels with overrides', async () => {
    const guild = makeGuild({
      channels: [
        {
          id: 'ch1', name: 'general', type: 0, position: 1,
          overwrites: [
            { id: 'r1', type: 0, allow: '1', deny: '2' },
          ],
        },
      ],
    });
    const snapshot = await takeSnapshot(guild);
    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.channels[0].name).toBe('general');
    expect(snapshot.channels[0].overwrites).toHaveLength(1);
    expect(snapshot.channels[0].overwrites[0].allow).toBe('1');
    expect(snapshot.channels[0].overwrites[0].deny).toBe('2');
  });

  it('handles channels without overrides', async () => {
    const guild = makeGuild({
      channels: [
        { id: 'ch1', name: 'empty-channel', type: 0, overwrites: [] },
      ],
    });
    const snapshot = await takeSnapshot(guild);
    expect(snapshot.channels[0].overwrites).toEqual([]);
  });

  it('captures channel metadata (topic, nsfw, slowmode)', async () => {
    const guild = makeGuild({
      channels: [
        { id: 'ch1', name: 'meta-channel', type: 0, topic: 'Hello world', nsfw: true, rateLimitPerUser: 5 },
      ],
    });
    const snapshot = await takeSnapshot(guild);
    expect(snapshot.channels[0].topic).toBe('Hello world');
    expect(snapshot.channels[0].nsfw).toBe(true);
    expect(snapshot.channels[0].rateLimitPerUser).toBe(5);
  });

  it('includes categories as channels', async () => {
    const guild = makeGuild({
      channels: [
        { id: 'cat1', name: 'Info', type: 4 },
        { id: 'ch1', name: 'announcements', type: 0, parentId: 'cat1' },
      ],
    });
    const snapshot = await takeSnapshot(guild);
    expect(snapshot.channels).toHaveLength(2);
    const cat = snapshot.channels.find((c: any) => c.id === 'cat1');
    expect(cat?.type).toBe(4);
    const child = snapshot.channels.find((c: any) => c.id === 'ch1');
    expect(child?.parentId).toBe('cat1');
  });

  it('skips channels without permissionOverwrites (DMs/threads)', async () => {
    const channelCache = new MockCollection();
    // Add a channel without permissionOverwrites
    channelCache.set('dm1', { id: 'dm1', name: 'dm', type: 1 });
    // Add a normal channel
    channelCache.set('ch1', {
      id: 'ch1', name: 'general', type: 0,
      permissionOverwrites: { cache: new MockCollection() },
      parentId: null, position: 0, topic: null,
      rateLimitPerUser: 0, nsfw: false,
    });

    const guild = {
      id: 'guild1',
      roles: {
        cache: new MockCollection([['guild1', {
          id: 'guild1', name: '@everyone',
          permissions: { bitfield: 0n },
          color: 0, hoist: false, mentionable: false, position: 0, managed: false,
        }]]),
        everyone: { permissions: { bitfield: 0n } },
        fetch: vi.fn(async () => {}),
      },
      channels: { cache: channelCache, fetch: vi.fn(async () => {}) },
    } as any;

    // Need to add map to the role cache
    guild.roles.cache.map = function(fn: any) {
      const result: any[] = [];
      for (const [k, v] of this) result.push(fn(v, k));
      return result;
    };

    const snapshot = await takeSnapshot(guild);
    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.channels[0].id).toBe('ch1');
  });
});
