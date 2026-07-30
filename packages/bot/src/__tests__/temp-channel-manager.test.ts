/**
 * Tests for ../features/temp-channels/temp-channel-manager.js — instantiation and lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock('discord.js', () => {
  class C extends Map {
    filter(fn: any) { const r = new C(); for (const [k, v] of this) if (fn(v, k)) r.set(k, v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
    find(fn: any) { return [...this.values()].find(fn); }
    first() { return [...this.values()][0]; }
  }
  return {
    EmbedBuilder: class {
      data: any = {};
      setColor() { return this; } setTitle() { return this; }
      setDescription() { return this; } addFields(...f: any[]) { this.data.fields = f; return this; }
      setFooter() { return this; } setTimestamp() { return this; }
      setAuthor() { return this; } setThumbnail() { return this; }
      setImage() { return this; }
    },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } setEmoji() { return this; } setDisabled() { return this; } },
    StringSelectMenuBuilder: class { setCustomId() { return this; } setPlaceholder() { return this; } addOptions() { return this; } },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n, ManageRoles: 8n, ManageMessages: 8192n },
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    Collection: C,
    ModalBuilder: class { setCustomId() { return this; } setTitle() { return this; } addComponents() { return this; } },
    TextInputBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } setRequired() { return this; } setPlaceholder() { return this; } },
    TextInputStyle: { Short: 1, Paragraph: 2 },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));



import { TempChannelManager } from '../features/temp-channels/temp-channel-manager.js';

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'order', 'limit', 'single', 'maybeSingle', 'match', 'contains', 'overlaps', 'filter', 'or', 'ilike', 'like', 'returns', 'range', 'textSearch']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa() {
  return {
    from: vi.fn(() => makeChain({ data: null, error: null })),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
  };
}

function makeGuild() {
  const ch: any = {
    id: 'ch-1', type: 0, name: 'general',
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
  };
  return {
    id: 'guild-1', name: 'Test', memberCount: 100,
    members: {
      me: { id: 'bot-1', permissions: { has: () => true } },
      fetch: vi.fn().mockResolvedValue({
        id: 'user-1', displayName: 'Tester',
        user: { tag: 'Tester#0001', displayAvatarURL: () => 'url', send: vi.fn() },
        roles: { add: vi.fn(), remove: vi.fn(), cache: new Map() },
      }),
      cache: new Map(),
    },
    roles: {
      cache: new Map(),
      everyone: { id: 'guild-1', permissions: { bitfield: 0n } },
      create: vi.fn().mockResolvedValue({ id: 'new-role' }),
    },
    channels: {
      cache: new Map([['ch-1', ch]]),
      create: vi.fn().mockResolvedValue({ id: 'new-ch', send: vi.fn() }),
      fetch: vi.fn().mockResolvedValue(new Map()),
    },
    client: {
      user: { id: 'bot-1' },
      users: { fetch: vi.fn().mockResolvedValue({ id: 'user-1', send: vi.fn() }) },
    },
  } as any;
}

function makeValkey() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(0),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    hget: vi.fn().mockResolvedValue(null),
    hset: vi.fn().mockResolvedValue(1),
    hdel: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue(null),
  } as any;
}

function makeDiscordClient() {
  return {
    user: { id: 'bot-1' },
    users: { fetch: vi.fn().mockResolvedValue({ id: 'user-1', send: vi.fn() }) },
    guilds: { cache: new Map([['guild-1', makeGuild()]]) },
  };
}

describe('TempChannelManager', () => {
  it('has required methods', () => {
    const manager = new TempChannelManager(makeGuild() as any, makeSupa() as any);
    expect(typeof manager.start).toBe('function');
    expect(typeof manager.handleJoinHub).toBe('function');
    expect(typeof manager.handleLeaveTemp).toBe('function');
    expect(typeof manager.reloadHubs).toBe('function');
  });

  it('instantiates without errors', () => {
    const manager = new TempChannelManager(makeGuild() as any, makeSupa() as any);
    expect(manager).toBeDefined();
  });

  it('clears and releases the original creation fence when ownership transfers', async () => {
    const updates: unknown[] = [];
    const tables: string[] = [];
    const equalityCalls: Array<[string, unknown]> = [];
    const supabase = {
      from: vi.fn((table: string) => {
        tables.push(table);
        const result = makeChain({ data: null, error: null });
        result.eq = vi.fn((column: string, value: unknown) => {
          equalityCalls.push([column, value]);
          return result;
        });
        result.update = vi.fn((payload: unknown) => {
          updates.push(payload);
          return result;
        });
        return result;
      }),
    };
    const manager = new TempChannelManager(makeGuild() as any, supabase as any);
    (manager as any).activeChannels.set('room-1', {
      channel_id: 'room-1',
      text_channel_id: null,
      guild_id: 'guild-1',
      hub_id: 'hub-1',
      owner_id: 'old-owner',
      creation_occurrence_id: 'occurrence-1',
    });

    await manager.transferOwnership('room-1', 'new-owner');

    expect(updates).toContainEqual({
      owner_id: 'new-owner',
      creation_occurrence_id: null,
    });
    expect(tables).toContain('discord_operation_occurrences');
    expect(equalityCalls).toContainEqual(['id', 'occurrence-1']);
    expect(equalityCalls).not.toContainEqual(['status', 'claimed']);
    expect(manager.getChannelOwner('room-1')).toBe('new-owner');
    expect((manager as any).activeChannels.get('room-1').creation_occurrence_id).toBeNull();
  });
  
});
