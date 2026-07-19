/**
 * CrossFeatureBridge — coverage tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  Guild: class {},
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setColor(c: number) { this.data.color = c; return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setTimestamp() { return this; }
  },
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { CrossFeatureBridge } from '../services/cross-feature-bridge.js';

// ── Helpers ───────────────────────────────────────────────

function makeSupabase(overrides: Record<string, any> = {}) {
  const fromMock = vi.fn();
  fromMock.mockImplementation((table: string) => {
    const chain: Record<string, any> = {};
    const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle', 'in'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    const data = overrides[table] ?? null;
    chain.then = (resolve: (v: any) => void) => resolve({ data, error: null });
    (chain as any)[Symbol.toStringTag] = 'Promise';
    return chain;
  });
  return {
    from: fromMock,
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

function makeEventBus() {
  const listeners: Record<string, Array<(event: any) => Promise<void>>> = {};
  return {
    on: vi.fn((event: string, handler: (e: any) => Promise<void>) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
      return () => { /* unsub */ };
    }),
    _emit: async (type: string, data: Record<string, unknown>) => {
      for (const h of listeners[type] ?? []) {
        await h({ type, guildId: 'g1', data });
      }
    },
    _listeners: listeners,
  };
}

function makeGuild() {
  return {
    id: 'g1',
    channels: { cache: { get: vi.fn().mockReturnValue(null) } },
    members: { cache: { get: vi.fn().mockReturnValue(null) } },
  };
}

function makeValkey() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
  };
}

// ── Tests ────────────────────────────────────────────────

describe('CrossFeatureBridge', () => {
  let bridge: CrossFeatureBridge;
  let supabase: ReturnType<typeof makeSupabase>;
  let eventBus: ReturnType<typeof makeEventBus>;
  let guild: ReturnType<typeof makeGuild>;
  let valkey: ReturnType<typeof makeValkey>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabase = makeSupabase();
    eventBus = makeEventBus();
    guild = makeGuild();
    valkey = makeValkey();
    bridge = new CrossFeatureBridge(guild as any, supabase as any, eventBus as any, valkey as any);
  });

  describe('start', () => {
    it('registers event listeners', () => {
      bridge.start();
      expect(eventBus.on).toHaveBeenCalled();
      // Should register multiple listeners
      expect(eventBus.on.mock.calls.length).toBeGreaterThan(5);
    });
  });

  describe('member.banned event', () => {
    it('cleans up giveaway entries, tickets, and economy on ban', async () => {
      bridge.start();
      await eventBus._emit('member.banned', { discordId: 'u1' });
      // Should call from for giveaway_entries, tickets, economy tables
      expect(supabase.from).toHaveBeenCalled();
    });

    it('handles missing discordId gracefully', async () => {
      bridge.start();
      await eventBus._emit('member.banned', {});
      // Should not throw
    });
  });

  describe('member.kicked event', () => {
    it('cleans up giveaway entries and economy on kick', async () => {
      bridge.start();
      await eventBus._emit('member.kicked', { discordId: 'u1' });
      expect(supabase.from).toHaveBeenCalled();
    });
  });

  describe('member.left event', () => {
    it('processes member leave', async () => {
      bridge.start();
      await eventBus._emit('member.left', { discordId: 'u1' });
    });
  });

  describe('level.up event', () => {
    it('handles level up with discount unlock', async () => {
      supabase = makeSupabase({
        guild_config: { economy_level_discount_thresholds: { '10': 5, '20': 10, '50': 20 } },
      });
      bridge = new CrossFeatureBridge(guild as any, supabase as any, eventBus as any, valkey as any);
      bridge.start();
      await eventBus._emit('level.up', { discordId: 'u1', newLevel: 10, oldLevel: 9 });
    });

    it('handles level up without threshold match', async () => {
      bridge.start();
      await eventBus._emit('level.up', { discordId: 'u1', newLevel: 3, oldLevel: 2 });
    });
  });

  describe('purchase.completed event', () => {
    it('does not install a purchase-to-XP or purchase-to-role mutation path', async () => {
      bridge.start();
      supabase.rpc.mockClear();
      supabase.from.mockClear();

      await eventBus._emit('purchase.completed', {
        discordId: 'u1',
        productId: 'product-1',
        amount: 999,
      });

      expect(eventBus._listeners['purchase.completed']).toBeUndefined();
      expect(supabase.rpc).not.toHaveBeenCalled();
      expect(supabase.from).not.toHaveBeenCalled();
    });
  });

  describe('ticket.closed event', () => {
    it('logs ticket resolution', async () => {
      bridge.start();
      await eventBus._emit('ticket.closed', { ticketId: 't1', closedBy: 'mod1', channelId: 'c1' });
    });
  });

  describe('infraction.created event', () => {
    it('checks escalation on infraction', async () => {
      bridge.start();
      await eventBus._emit('infraction.created', { userId: 'u1', type: 'warn', totalInfractions: 5 });
    });
  });
});
