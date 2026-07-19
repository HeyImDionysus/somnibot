/**
 * CrossFeatureBridge — purchases must not mutate game progression or derive
 * Discord roles from mutable product metadata. Canonical commerce fulfillment
 * owns all purchase grants.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  Guild: class {},
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

function makeEventBus() {
  const listeners: Record<string, Array<(event: any) => Promise<void>>> = {};
  return {
    on: vi.fn((event: string, handler: (e: any) => Promise<void>) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    off: vi.fn(),
    _emit: async (type: string, data: Record<string, unknown>) => {
      for (const handler of listeners[type] ?? []) {
        await handler({ type, guildId: 'g1', data });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    _listeners: listeners,
  };
}

describe('[commerce] CrossFeatureBridge — purchase isolation', () => {
  let rolesAdd: ReturnType<typeof vi.fn>;
  let membersFetch: ReturnType<typeof vi.fn>;
  let supabase: { from: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> };
  let eventBus: ReturnType<typeof makeEventBus>;
  let guild: any;
  let valkey: any;

  beforeEach(() => {
    vi.clearAllMocks();
    rolesAdd = vi.fn().mockResolvedValue(undefined);
    membersFetch = vi.fn().mockResolvedValue({ roles: { add: rolesAdd } });
    supabase = {
      from: vi.fn(),
      rpc: vi.fn(),
    };
    eventBus = makeEventBus();
    guild = {
      id: 'g1',
      members: { fetch: membersFetch },
    };
    valkey = {
      get: vi.fn(),
      set: vi.fn(),
      smembers: vi.fn().mockResolvedValue([]),
      sadd: vi.fn(),
      expire: vi.fn(),
    };
  });

  it('does not register a purchase.completed mutation listener', () => {
    const bridge = new CrossFeatureBridge(guild, supabase as any, eventBus as any, valkey);

    bridge.start();

    expect(eventBus._listeners['purchase.completed']).toBeUndefined();
    expect(eventBus.on).not.toHaveBeenCalledWith('purchase.completed', expect.any(Function));
  });

  it('does not query product metadata, add a role, write temp provenance, or award XP', async () => {
    const bridge = new CrossFeatureBridge(guild, supabase as any, eventBus as any, valkey);
    bridge.start();

    await eventBus._emit('purchase.completed', {
      discordId: 'u1',
      productId: 'prod-1',
      productName: 'Premium Access',
      orderId: 'order-1',
    });

    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(membersFetch).not.toHaveBeenCalled();
    expect(rolesAdd).not.toHaveBeenCalled();
  });
});
