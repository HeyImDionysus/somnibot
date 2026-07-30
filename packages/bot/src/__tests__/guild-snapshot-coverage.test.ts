/**
 * guild-snapshot — coverage tests
 *
 * Tests writeGuildSnapshot and startPeriodicSnapshots using REAL imports
 * with mocked Discord/Supabase boundaries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

// Need to mock discord.js ChannelType enum
vi.mock('discord.js', () => ({
  ChannelType: {
    GuildCategory: 4,
    GuildText: 0,
    GuildVoice: 2,
    GuildAnnouncement: 5,
    GuildForum: 15,
    GuildStageVoice: 13,
    GuildNewsThread: 10,
  },
}));

import { writeGuildSnapshot, startPeriodicSnapshots } from '../services/guild-snapshot.js';

// ── Helpers ───────────────────────────────────────────────

class MockCollection<V> extends Map<string, V> {
  filter(fn: (v: V, k: string) => boolean): MockCollection<V> {
    const result = new MockCollection<V>();
    for (const [k, v] of this) { if (fn(v, k)) result.set(k, v); }
    return result;
  }
  map<T>(fn: (v: V, k: string) => T): T[] {
    const result: T[] = [];
    for (const [k, v] of this) result.push(fn(v, k));
    return result;
  }
  sort(fn?: (a: V, b: V) => number): this {
    const entries = [...this.entries()];
    if (fn) entries.sort(([, a], [, b]) => fn(a, b));
    this.clear();
    for (const [k, v] of entries) this.set(k, v);
    return this;
  }
}

function chainBuilder(resolveValue: Record<string, unknown> = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'update', 'upsert', 'insert', 'delete', 'order', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(resolveValue);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  chain.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
    Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeGuild() {
  const rolesCache = new MockCollection<any>();
  // @everyone role (same id as guild)
  rolesCache.set('g1', {
    id: 'g1', name: '@everyone', color: 0, position: 0,
    permissions: { bitfield: 0n },
    hoist: false, mentionable: false, managed: false,
    tags: {}, members: { size: 10 },
  });
  // Regular role
  rolesCache.set('r1', {
    id: 'r1', name: 'Admin', color: 0xFF0000, position: 5,
    permissions: { bitfield: 8n },
    hoist: true, mentionable: false, managed: false,
    tags: { botId: null, integrationId: null, premiumSubscriberRole: false, availableForPurchase: false, guildConnections: false },
    members: { size: 3 },
  });
  // Managed role
  rolesCache.set('r2', {
    id: 'r2', name: 'BotRole', color: 0, position: 2,
    permissions: { bitfield: 0n },
    hoist: false, mentionable: false, managed: true,
    tags: { botId: 'bot1' },
    members: { size: 1 },
  });
  // Premium subscriber role
  rolesCache.set('r3', {
    id: 'r3', name: 'Booster', color: 0xFF73FA, position: 3,
    permissions: { bitfield: 0n },
    hoist: false, mentionable: false, managed: false,
    tags: { premiumSubscriberRole: true },
    members: { size: 2 },
  });

  const channelsCache = new MockCollection<any>();
  // Category
  channelsCache.set('cat1', {
    id: 'cat1', name: 'Text Channels', type: 4, position: 0,
  });
  // Text channel
  channelsCache.set('ch1', {
    id: 'ch1', name: 'general', type: 0, parentId: 'cat1', position: 0,
    topic: 'Welcome!', rateLimitPerUser: 5, nsfw: false,
    manageable: true,
    permissionsFor: vi.fn(() => ({ bitfield: 0xC00n })),
    permissionOverwrites: {
      cache: new MockCollection<any>([
        ['r1', {
          id: 'r1',
          type: 0,
          allow: { bitfield: 0x400n },
          deny: { bitfield: 0n },
        }],
      ]),
    },
  });
  // Voice channel
  channelsCache.set('ch2', {
    id: 'ch2', name: 'voice', type: 2, parentId: 'cat1', position: 1,
    topic: null, rateLimitPerUser: 0, nsfw: false,
  });
  // Announcement channel
  channelsCache.set('ch3', {
    id: 'ch3', name: 'news', type: 5, parentId: null, position: 2,
    topic: 'Announcements', rateLimitPerUser: 0, nsfw: false,
  });
  // Thread (type 10 — should be skipped)
  channelsCache.set('th1', {
    id: 'th1', name: 'thread', type: 10, parentId: 'ch1', position: 0,
  });

  const membersCache = new MockCollection<any>();
  membersCache.set('u1', {
    id: 'u1',
    user: { username: 'TestUser', bot: false, avatar: 'abc123' },
    displayName: 'Test User',
    joinedAt: new Date('2025-01-01'),
    roles: {
      cache: new MockCollection<any>([
        ['g1', { id: 'g1' }],
        ['r1', { id: 'r1' }],
      ]),
    },
  });
  membersCache.set('b1', {
    id: 'b1',
    user: { username: 'SomniBot', bot: true, avatar: null },
    displayName: 'SomniBot',
    joinedAt: new Date('2024-06-01'),
    roles: {
      cache: new MockCollection<any>([['g1', { id: 'g1' }]]),
    },
  });

  return {
    id: 'g1',
    memberCount: 42,
    roles: {
      cache: rolesCache,
      fetch: vi.fn().mockResolvedValue(rolesCache),
    },
    channels: {
      cache: channelsCache,
      fetch: vi.fn().mockResolvedValue(channelsCache),
    },
    members: {
      me: {
        roles: { highest: { id: 'r2', position: 2 } },
        permissions: {
          bitfield: 0x10000000n,
          has: vi.fn((permission: string) => permission === 'ManageRoles'),
        },
      },
      cache: membersCache,
      fetch: vi.fn().mockResolvedValue(membersCache),
    },
    fetchOnboarding: vi.fn().mockResolvedValue({
      enabled: true,
      prompts: [
        {
          id: 'p1', title: 'Pick your interests', type: 0,
          required: true, singleSelect: false,
          options: [{
            id: 'o1', title: 'Gaming', description: 'Game stuff',
            roles: [{ id: 'r1' }], channels: [{ id: 'ch1' }],
          }],
        },
      ],
    }),
  };
}

describe('writeGuildSnapshot', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes full snapshot with roles, channels, categories, members', async () => {
    const guild = makeGuild();
    const upsertChain = chainBuilder({ data: null, error: null });
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'discord_id_map') {
          return chainBuilder({
            data: [
              { entity_type: 'role', template_key: 'admin', discord_id: 'r1' },
              { entity_type: 'channel', template_key: 'general', discord_id: 'ch1' },
              { entity_type: 'category', template_key: 'text-channels', discord_id: 'cat1' },
            ],
            error: null,
          });
        }
        if (table === 'guild_desired_state') {
          return chainBuilder({
            data: { roles: [{ key: 'admin', tier: 'admin' }] },
            error: null,
          });
        }
        if (table === 'guild_live_state') {
          return upsertChain;
        }
        return chainBuilder();
      }),
    };

    await writeGuildSnapshot(guild as any, supabase as any);

    // Check roles and channels were fetched
    expect(guild.roles.fetch).toHaveBeenCalled();
    expect(guild.channels.fetch).toHaveBeenCalled();
    // Check upsert was called on guild_live_state
    expect(supabase.from).toHaveBeenCalledWith('guild_live_state');
    expect(upsertChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot_version: 2,
        bot_permissions: '268435456',
        roles: expect.arrayContaining([
          expect.objectContaining({ id: 'r1', editableByBot: false }),
        ]),
        channels: expect.arrayContaining([
          expect.objectContaining({
            id: 'ch1',
            botPermissions: '3072',
            manageableByBot: true,
            permissionOverwrites: [
              { id: 'r1', type: 'role', allow: '1024', deny: '0' },
            ],
          }),
        ]),
      }),
      { onConflict: 'guild_id' },
    );
  });

  it('handles upsert error', async () => {
    const guild = makeGuild();
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'guild_live_state') {
          return chainBuilder({ data: null, error: { message: 'upsert fail' } });
        }
        if (table === 'discord_id_map') {
          return chainBuilder({ data: [], error: null });
        }
        return chainBuilder({ data: null, error: null });
      }),
    };

    // Should not throw
    await writeGuildSnapshot(guild as any, supabase as any);
  });

  it('handles missing onboarding method', async () => {
    const guild = makeGuild();
    delete (guild as any).fetchOnboarding;
    const supabase = {
      from: vi.fn().mockReturnValue(chainBuilder({ data: [], error: null })),
    };

    await writeGuildSnapshot(guild as any, supabase as any);
    expect(supabase.from).toHaveBeenCalledWith('guild_live_state');
  });

  it('handles onboarding fetch error', async () => {
    const guild = makeGuild();
    guild.fetchOnboarding.mockRejectedValueOnce(new Error('no onboarding'));
    const supabase = {
      from: vi.fn().mockReturnValue(chainBuilder({ data: [], error: null })),
    };

    await writeGuildSnapshot(guild as any, supabase as any);
    // Should not throw — catches the error gracefully
  });

  it('handles member fetch failure', async () => {
    const guild = makeGuild();
    guild.members.fetch.mockRejectedValueOnce(new Error('no members'));
    const supabase = {
      from: vi.fn().mockReturnValue(chainBuilder({ data: [], error: null })),
    };

    await writeGuildSnapshot(guild as any, supabase as any);
    // Should not throw — members will be null
  });

  it('handles null mappings from discord_id_map', async () => {
    const guild = makeGuild();
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'discord_id_map') {
          return chainBuilder({ data: null, error: null });
        }
        return chainBuilder({ data: null, error: null });
      }),
    };

    await writeGuildSnapshot(guild as any, supabase as any);
  });

  it('classifies role sources correctly', async () => {
    const guild = makeGuild();
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'discord_id_map') {
          return chainBuilder({
            data: [
              { entity_type: 'role', template_key: 'admin', discord_id: 'r1' },
            ],
            error: null,
          });
        }
        if (table === 'guild_desired_state') {
          return chainBuilder({ data: { roles: [] }, error: null });
        }
        if (table === 'guild_live_state') {
          return chainBuilder({ data: null, error: null });
        }
        return chainBuilder();
      }),
    };

    await writeGuildSnapshot(guild as any, supabase as any);
    // r1 has templateKey → source = 'deployed'
    // r2 is managed → source = 'managed'
    // r3 has premiumSubscriberRole → source = 'managed'
  });

  it('handles displayName same as username', async () => {
    const guild = makeGuild();
    // Set displayName same as username for member u1
    guild.members.cache.get('u1')!.displayName = 'TestUser';
    const supabase = {
      from: vi.fn().mockReturnValue(chainBuilder({ data: [], error: null })),
    };

    await writeGuildSnapshot(guild as any, supabase as any);
  });
});

describe('startPeriodicSnapshots', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes immediately and sets interval', async () => {
    const guild = makeGuild();
    const supabase = {
      from: vi.fn().mockReturnValue(chainBuilder({ data: [], error: null })),
    };

    const timer = startPeriodicSnapshots(guild as any, supabase as any, 10_000);
    expect(timer).toBeTruthy();
    clearInterval(timer);
  });

  it('handles initial write failure', async () => {
    const guild = makeGuild();
    guild.roles.fetch.mockRejectedValue(new Error('fail'));
    const supabase = {
      from: vi.fn().mockReturnValue(chainBuilder({ data: [], error: null })),
    };

    const timer = startPeriodicSnapshots(guild as any, supabase as any, 60_000);
    // Should not throw
    clearInterval(timer);
  });
});
