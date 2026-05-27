/**
 * Production-grade test utilities for Somnibot.
 * Provides realistic mocks for Discord.js interactions, guilds, and Supabase chains.
 */
import { vi } from 'vitest';

const { Collection } = await import('discord.js');

// ═══════════════════════════════════════════════════════════
// Interaction Mock Factory
// ═══════════════════════════════════════════════════════════
export interface MockInteractionOptions {
  guildId?: string;
  userId?: string;
  channelId?: string;
  username?: string;
}

export function createMockInteraction(opts: MockInteractionOptions = {}) {
  const {
    guildId = 'g1',
    userId = 'u1',
    channelId = 'ch1',
    username = 'TestUser',
  } = opts;

  const replyMessage = {
    id: 'reply-msg-1',
    edit: vi.fn(async () => replyMessage),
    delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    createMessageComponentCollector: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      stop: vi.fn(),
    })),
  };

  return {
    guildId,
    channelId,
    user: { id: userId, username, displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/test.png' },
    member: {
      id: userId,
      roles: { cache: new Collection(), add: vi.fn(async () => {}) },
      displayName: username,
    },
    guild: createMockGuild(guildId),
    reply: vi.fn(async () => replyMessage),
    editReply: vi.fn(async () => replyMessage),
    deferReply: vi.fn(async () => {}),
    followUp: vi.fn(async () => replyMessage),
    fetchReply: vi.fn(async () => replyMessage),
    replied: false,
    deferred: false,
    isCommand: () => true,
    isChatInputCommand: () => true,
    isButton: () => false,
    options: {
      getString: vi.fn(() => null),
      getInteger: vi.fn(() => null),
      getNumber: vi.fn(() => null),
      getBoolean: vi.fn(() => null),
      getUser: vi.fn(() => null),
      getChannel: vi.fn(() => null),
      getRole: vi.fn(() => null),
      getSubcommand: vi.fn(() => null),
      getSubcommandGroup: vi.fn(() => null),
    },
  } as any;
}

export function createMockButtonInteraction(opts: MockInteractionOptions & { customId?: string } = {}) {
  const base = createMockInteraction(opts);
  return {
    ...base,
    customId: opts.customId ?? 'btn-1',
    isButton: () => true,
    isChatInputCommand: () => false,
    update: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    message: {
      id: 'msg-1',
      edit: vi.fn(async () => {}),
      components: [],
    },
  } as any;
}

// ═══════════════════════════════════════════════════════════
// Guild Mock
// ═══════════════════════════════════════════════════════════
export function createMockGuild(id = 'g1') {
  const channels = new Collection<string, any>();
  channels.set('ch1', {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({
      id: 'msg1',
      edit: vi.fn(async () => {}),
      react: vi.fn(async () => {}),
      createMessageComponentCollector: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        stop: vi.fn(),
      })),
    })),
    messages: { fetch: vi.fn(async () => new Collection()) },
  });

  const members = new Collection<string, any>();
  return {
    id, name: 'Test Guild', memberCount: 100,
    roles: { cache: new Collection() },
    channels: { cache: channels, fetch: vi.fn(async () => channels.get('ch1')) },
    members: {
      cache: members,
      me: { roles: { highest: { position: 10 } } },
      fetch: vi.fn(async (uid: string) => ({
        id: uid,
        user: { id: uid, username: 'User', displayAvatarURL: () => 'url', send: vi.fn(async () => {}) },
        roles: { cache: new Collection(), add: vi.fn(async () => {}) },
      })),
    },
    client: {
      user: { id: 'bot1' },
      users: { fetch: vi.fn(async (uid: string) => ({ send: vi.fn(async () => {}), id: uid, username: 'User' })) },
    },
  } as any;
}

// ═══════════════════════════════════════════════════════════
// Supabase Chain Mock
// ═══════════════════════════════════════════════════════════
export function createSupabaseChain(data: any = null) {
  const chain: any = {};
  const methods = [
    'select','insert','update','upsert','delete',
    'eq','neq','gt','gte','lt','lte','in','is','or','not',
    'order','limit','range','match','ilike','like','filter',
    'contains','textSearch',
  ];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
  chain.single = vi.fn(async () => ({ data, error: null }));
  chain.then = undefined;
  return chain;
}

export function createMockSupabase(routing: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => {
      if (table in routing) {
        const val = routing[table];
        return typeof val === 'function' ? val() : createSupabaseChain(val);
      }
      return createSupabaseChain(null);
    }),
    rpc: vi.fn(async () => ({ data: true, error: null })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: any) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: vi.fn() }; }),
    })),
  } as any;
}

// ═══════════════════════════════════════════════════════════
// Valkey Mock
// ═══════════════════════════════════════════════════════════
export function createMockValkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1), ttl: vi.fn(async () => -2),
    pttl: vi.fn(async () => -2), sadd: vi.fn(async () => 1),
    sismember: vi.fn(async () => 0), smembers: vi.fn(async () => []),
    scard: vi.fn(async () => 0), keys: vi.fn(async () => []),
    hset: vi.fn(async () => 1), hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
  } as any;
}

export function createMockEventBus() {
  return {
    on: vi.fn(), off: vi.fn(), emit: vi.fn(),
    removeAllListeners: vi.fn(), onAny: vi.fn(),
  } as any;
}
