/**
 * Tests for features/adventures/adventure-manager.ts — AdventureManager lifecycle and methods.
 * 336 uncovered statements at 52.3%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
}));

vi.mock('discord.js', () => {
  class C extends Map {
    filter(fn: any) { const r = new C(); for (const [k, v] of this.entries()) if (fn(v, k)) r.set(k, v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
    find(fn: any) { return [...this.values()].find(fn); }
    first() { return [...this.values()][0]; }
  }
  return {
    EmbedBuilder: class {
      data: any = {};
      setColor() { return this; } setTitle() { return this; }
      setDescription() { return this; } addFields() { return this; }
      setFooter() { return this; } setTimestamp() { return this; }
      setThumbnail() { return this; } setImage() { return this; }
      setAuthor() { return this; }
    },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonBuilder: class {
      setCustomId() { return this; } setLabel() { return this; }
      setStyle() { return this; } setEmoji() { return this; }
      setDisabled() { return this; }
    },
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ChannelType: { GuildText: 0 },
    PermissionFlagsBits: {},
    Collection: C,
    StringSelectMenuBuilder: class {
      setCustomId() { return this; } setPlaceholder() { return this; }
      addOptions() { return this; }
    },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock('../features/economy/economy-utils.js', () => ({
  getBalance: vi.fn(async () => 1000),
  addBalance: vi.fn(async () => true),
  deductBalance: vi.fn(async () => true),
}));

import { AdventureManager } from '../features/adventures/adventure-manager.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'not', 'is', 'gte', 'lte', 'contains']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null });
  return chain;
}

function makeSupa() {
  return {
    from: vi.fn(() => makeChain()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeGuild() {
  return {
    id: 'guild-1', name: 'Test', memberCount: 100,
    channels: { cache: new Map() },
    members: {
      fetch: vi.fn().mockResolvedValue({
        id: 'user-1', displayName: 'Tester',
        user: { tag: 'Tester#0001', displayAvatarURL: () => 'url', send: vi.fn() },
      }),
      cache: new Map(),
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
    hget: vi.fn().mockResolvedValue(null),
    hset: vi.fn().mockResolvedValue(1),
    hdel: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue(null),
  } as any;
}

describe('AdventureManager', () => {
  let manager: AdventureManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AdventureManager(makeGuild(), makeSupa(), makeValkey());
  });

  it('instantiates without errors', () => {
    expect(manager).toBeDefined();
  });
});
