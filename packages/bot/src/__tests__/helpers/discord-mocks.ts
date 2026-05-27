/**
 * Production-grade Discord.js mock factory for vitest.
 * 
 * Based on community best practices from discord.js#6179 and vitest mocking guide.
 * Creates type-safe mock objects matching Discord.js v14 interfaces without 
 * importing actual discord.js classes (which require a real WebSocket client).
 */

import { vi } from 'vitest';

// ── Collection mock ──────────────────────────────────────
export class MockCollection<K = string, V = any> extends Map<K, V> {
  filter(fn: (v: V, k: K) => boolean): MockCollection<K, V> {
    const result = new MockCollection<K, V>();
    for (const [k, v] of this) if (fn(v, k)) result.set(k, v);
    return result;
  }
  find(fn: (v: V) => boolean): V | undefined {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
  map<T>(fn: (v: V, k: K) => T): T[] {
    return [...this.entries()].map(([k, v]) => fn(v, k));
  }
  first(): V | undefined {
    return this.values().next().value;
  }
  some(fn: (v: V) => boolean): boolean {
    for (const v of this.values()) if (fn(v)) return true;
    return false;
  }
  every(fn: (v: V) => boolean): boolean {
    for (const v of this.values()) if (!fn(v)) return false;
    return true;
  }
  toJSON(): V[] {
    return [...this.values()];
  }
}

// ── User mock ────────────────────────────────────────────
export function mockUser(overrides: Partial<{ id: string; username: string; displayName: string; bot: boolean }> = {}) {
  return {
    id: overrides.id ?? 'u1',
    username: overrides.username ?? 'testuser',
    displayName: overrides.displayName ?? 'TestUser',
    discriminator: '0',
    bot: overrides.bot ?? false,
    avatarURL: vi.fn(() => 'https://cdn.discordapp.com/avatars/u1/abc.png'),
    toString: () => `<@${overrides.id ?? 'u1'}>`,
    send: vi.fn(async () => ({})),
  };
}

// ── GuildMember mock ─────────────────────────────────────
export function mockMember(overrides: Partial<{ id: string; displayName: string; roles: string[] }> = {}) {
  const rolesCache = new MockCollection<string, any>();
  for (const r of overrides.roles ?? ['r1']) {
    rolesCache.set(r, { id: r, name: `Role-${r}` });
  }
  const user = mockUser({ id: overrides.id });
  return {
    id: overrides.id ?? 'u1',
    user,
    displayName: overrides.displayName ?? 'TestUser',
    roles: {
      cache: rolesCache,
      add: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      highest: { id: 'r1', position: 1 },
    },
    permissions: { has: vi.fn(() => true), bitfield: 8n },
    send: vi.fn(async () => ({})),
    ban: vi.fn(async () => {}),
    kick: vi.fn(async () => {}),
    timeout: vi.fn(async () => {}),
    bannable: true,
    kickable: true,
    moderatable: true,
    joinedAt: new Date(),
    toString: () => `<@${overrides.id ?? 'u1'}>`,
  };
}

// ── Guild mock ───────────────────────────────────────────
export function mockGuild(overrides: Partial<{ id: string; name: string; memberCount: number }> = {}) {
  const id = overrides.id ?? 'g1';
  const members = new MockCollection<string, any>();
  members.set('u1', mockMember({ id: 'u1' }));
  
  const channels = new MockCollection<string, any>();
  channels.set('ch1', {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({ id: 'msg1' })),
    permissionOverwrites: { cache: new MockCollection(), edit: vi.fn(async () => {}) },
  });
  channels.set('ch2', {
    id: 'ch2', name: 'mod-log', type: 0,
    send: vi.fn(async () => ({ id: 'msg2' })),
    permissionOverwrites: { cache: new MockCollection(), edit: vi.fn(async () => {}) },
  });
  
  const roles = new MockCollection<string, any>();
  const everyoneRole = {
    id, name: '@everyone',
    permissions: { bitfield: 0n },
    setPermissions: vi.fn(async () => {}),
  };
  roles.set(id, everyoneRole);
  roles.set('r1', { id: 'r1', name: 'Member', position: 1, permissions: { bitfield: 0n } });
  
  return {
    id, name: overrides.name ?? 'TestGuild',
    memberCount: overrides.memberCount ?? 100,
    members: { cache: members, fetch: vi.fn(async (uid: string) => members.get(uid) ?? null) },
    channels: { cache: channels, fetch: vi.fn(async (cid: string) => channels.get(cid) ?? null) },
    roles: { cache: roles, everyone: everyoneRole, fetch: vi.fn(async () => roles) },
    bans: { create: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    iconURL: vi.fn(() => 'https://cdn.discordapp.com/icons/g1/abc.png'),
    rulesChannelId: null,
    publicUpdatesChannelId: null,
  } as any;
}

// ── ChatInputCommandInteraction mock ─────────────────────
export function mockChatInputInteraction(overrides: Partial<{
  guildId: string; userId: string; subcommand: string;
  options: Record<string, any>; guild: any;
}> = {}) {
  const user = mockUser({ id: overrides.userId });
  const guild = overrides.guild ?? mockGuild();
  const member = guild.members.cache.get(overrides.userId ?? 'u1') ?? mockMember({ id: overrides.userId });
  const optionValues = overrides.options ?? {};
  
  return {
    guildId: overrides.guildId ?? 'g1',
    guild,
    user,
    member,
    channelId: 'ch1',
    channel: guild.channels.cache.get('ch1'),
    client: { ws: { status: 0 }, guilds: { cache: new MockCollection() } },
    
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    deleteReply: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    isRepliable: vi.fn(() => true),
    deferred: false,
    replied: false,
    
    isChatInputCommand: vi.fn(() => true),
    isButton: vi.fn(() => false),
    isStringSelectMenu: vi.fn(() => false),
    isModalSubmit: vi.fn(() => false),
    isAutocomplete: vi.fn(() => false),
    isCommand: vi.fn(() => true),
    
    options: {
      getSubcommand: vi.fn(() => overrides.subcommand ?? 'default'),
      getSubcommandGroup: vi.fn(() => null),
      getString: vi.fn((name: string) => optionValues[name] ?? null),
      getInteger: vi.fn((name: string) => optionValues[name] ?? null),
      getNumber: vi.fn((name: string) => optionValues[name] ?? null),
      getBoolean: vi.fn((name: string) => optionValues[name] ?? null),
      getUser: vi.fn((name: string) => optionValues[name] ?? null),
      getMember: vi.fn((name: string) => optionValues[name] ?? null),
      getChannel: vi.fn((name: string) => optionValues[name] ?? null),
      getRole: vi.fn((name: string) => optionValues[name] ?? null),
      getAttachment: vi.fn((name: string) => optionValues[name] ?? null),
      getMentionable: vi.fn((name: string) => optionValues[name] ?? null),
      get: vi.fn((name: string) => optionValues[name] ? { value: optionValues[name] } : null),
      data: [],
    },
    
    commandName: optionValues._commandName ?? 'test',
    commandId: 'cmd1',
    id: 'int1',
    token: 'token1',
    applicationId: 'app1',
    type: 2,
    createdTimestamp: Date.now(),
    locale: 'en-US',
  } as any;
}

// ── ButtonInteraction mock ───────────────────────────────
export function mockButtonInteraction(overrides: Partial<{
  customId: string; guildId: string; userId: string; guild: any;
}> = {}) {
  const user = mockUser({ id: overrides.userId });
  const guild = overrides.guild ?? mockGuild();
  const member = guild.members.cache.get(overrides.userId ?? 'u1') ?? mockMember({ id: overrides.userId });
  
  return {
    customId: overrides.customId ?? 'btn:action',
    guildId: overrides.guildId ?? 'g1',
    guild,
    user,
    member,
    channelId: 'ch1',
    channel: guild.channels.cache.get('ch1'),
    message: { id: 'msg1', edit: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    isRepliable: vi.fn(() => true),
    deferred: false,
    replied: false,
    
    isButton: vi.fn(() => true),
    isChatInputCommand: vi.fn(() => false),
    isStringSelectMenu: vi.fn(() => false),
    isModalSubmit: vi.fn(() => false),
    isCommand: vi.fn(() => false),
    
    id: 'int1',
    token: 'token1',
    applicationId: 'app1',
    type: 3,
    createdTimestamp: Date.now(),
  } as any;
}

// ── Supabase mock ────────────────────────────────────────
export function mockSupabaseChain(data: any = null, error: any = null) {
  const c: any = {};
  const methods = ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte',
    'in','is','or','not','order','limit','range','match','ilike','like','filter','contains',
    'textSearch','head','overlaps','single','maybeSingle'];
  for (const m of methods) c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = undefined;
  return c;
}

export function mockSupabase(defaultData: any = null) {
  return {
    from: vi.fn(() => mockSupabaseChain(defaultData)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    })),
  } as any;
}

// ── Valkey mock ──────────────────────────────────────────
export function mockValkey() {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    setex: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    incrby: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => -2),
    ping: vi.fn(async () => 'PONG'),
    multi: vi.fn(() => ({
      incrby: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [[null, 1]]),
    })),
    info: vi.fn(async () => 'used_memory:1024'),
  } as any;
}

// ── EventBus mock ────────────────────────────────────────
export function mockEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() } as any;
}
