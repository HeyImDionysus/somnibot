/**
 * [commerce] CrossFeatureBridge — commerce/game seam labeling.
 *
 * A real-money commerce product purchase (`purchase.completed`, productId
 * referencing the `products` table) that grants a temporary Discord role must
 * record the grant in `temp_role_grants` with a COMMERCE-accurate provenance
 * (`source: 'commerce_purchase'`), not the play-money game-economy label
 * (`'economy_purchase'`). Mislabeling tags real-money audit rows as fake
 * game-economy events. The Discord audit-log reason must likewise not claim
 * "economy purchase".
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
      return () => { /* unsub */ };
    }),
    off: vi.fn(),
    _emit: async (type: string, data: Record<string, unknown>) => {
      for (const h of listeners[type] ?? []) {
        await h({ type, guildId: 'g1', data });
      }
      // The bridge's `on` wrapper fires handlers without returning the promise,
      // so flush the microtask queue to let async side effects settle.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('[commerce] CrossFeatureBridge — role-grant provenance labeling', () => {
  let inserts: Array<{ table: string; payload: any }>;
  let rolesAdd: ReturnType<typeof vi.fn>;
  let supabase: any;
  let eventBus: ReturnType<typeof makeEventBus>;
  let guild: any;
  let valkey: any;

  beforeEach(() => {
    vi.clearAllMocks();
    inserts = [];
    rolesAdd = vi.fn().mockResolvedValue(undefined);

    // Product with a role grant + a duration so a temp_role_grants row is written.
    const products = {
      metadata: { grant_role_id: 'role-123', role_duration_hours: 24 },
    };

    supabase = {
      from: vi.fn((table: string) => {
        const chain: Record<string, any> = {};
        for (const m of ['select', 'eq', 'update', 'delete', 'limit']) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        chain.maybeSingle = vi.fn(async () => ({
          data: table === 'products' ? products : null,
          error: null,
        }));
        chain.insert = vi.fn(async (payload: any) => {
          inserts.push({ table, payload });
          return { data: null, error: null };
        });
        chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return chain;
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    eventBus = makeEventBus();
    guild = {
      id: 'g1',
      members: {
        fetch: vi.fn().mockResolvedValue({ roles: { add: rolesAdd } }),
      },
    };
    valkey = { get: vi.fn(), set: vi.fn(), smembers: vi.fn().mockResolvedValue([]) };
  });

  it('records a commerce role grant with source "commerce_purchase"', async () => {
    const bridge = new CrossFeatureBridge(guild, supabase, eventBus as any, valkey);
    bridge.start();

    await eventBus._emit('purchase.completed', {
      discordId: 'u1',
      productId: 'prod-1',
      productName: 'Premium Access',
      orderId: 'order-1',
    });

    const grant = inserts.find((i) => i.table === 'temp_role_grants');
    expect(grant, 'a temp_role_grants row should be written').toBeTruthy();
    // Real-money commerce provenance — never the play-money game label.
    expect(grant!.payload.source).toBe('commerce_purchase');
    expect(grant!.payload.source).not.toBe('economy_purchase');
    expect(grant!.payload.source_id).toBe('prod-1');
  });

  it('does not label the Discord role add as an "economy purchase"', async () => {
    const bridge = new CrossFeatureBridge(guild, supabase, eventBus as any, valkey);
    bridge.start();

    await eventBus._emit('purchase.completed', {
      discordId: 'u1',
      productId: 'prod-1',
      productName: 'Premium Access',
      orderId: 'order-1',
    });

    expect(rolesAdd).toHaveBeenCalledTimes(1);
    const reason = String(rolesAdd.mock.calls[0][1] ?? '');
    expect(reason.toLowerCase()).not.toContain('economy');
    expect(reason.toLowerCase()).toContain('commerce');
  });
});
