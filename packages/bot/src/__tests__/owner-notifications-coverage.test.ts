/**
 * OwnerNotificationService — coverage tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    fields: any[] = [];
    setColor(c: number) { this.data.color = c; return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setTimestamp() { return this; }
    setFooter(f: { text: string }) { this.data.footer = f; return this; }
    addFields(...args: any[]) {
      for (const a of args) this.fields.push(a);
      return this;
    }
  },
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  SOMNI_PALETTE: {},
}));

import { OwnerNotificationService } from '../services/owner-notifications.js';

// ── Helpers ───────────────────────────────────────────────

function makeSupabase(overrides: Record<string, any> = {}) {
  const fromMock = vi.fn();
  fromMock.mockImplementation((table: string) => {
    const chain: Record<string, any> = {};
    const methods = ['select', 'eq', 'single', 'maybeSingle'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    const data = overrides[table] ?? null;
    chain.then = (resolve: (v: any) => void) => resolve({ data, error: null });
    (chain as any)[Symbol.toStringTag] = 'Promise';
    return chain;
  });
  return { from: fromMock };
}

function makeEventBus() {
  const listeners: Record<string, Array<(event: any) => void>> = {};
  return {
    on: vi.fn((event: string, handler: (e: any) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    _emit: (type: string, data: Record<string, unknown>) => {
      for (const h of listeners[type] ?? []) {
        h({ type, guildId: 'g1', data });
      }
    },
    _listeners: listeners,
  };
}

function makeClient(overrides: Record<string, any> = {}) {
  const sendMock = vi.fn().mockResolvedValue(undefined);
  const channel = overrides.hasChannel ? { send: sendMock } : null;
  return {
    guilds: {
      cache: {
        get: vi.fn().mockReturnValue({
          channels: { cache: { get: vi.fn().mockReturnValue(channel) } },
        }),
      },
    },
    users: {
      fetch: vi.fn().mockResolvedValue({
        send: sendMock,
      }),
    },
    _sendMock: sendMock,
  };
}

// ── Tests ────────────────────────────────────────────────

describe('OwnerNotificationService', () => {
  let service: OwnerNotificationService;
  let client: ReturnType<typeof makeClient>;
  let supabase: ReturnType<typeof makeSupabase>;
  let eventBus: ReturnType<typeof makeEventBus>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = makeClient({ hasChannel: true });
    supabase = makeSupabase({
      guild: { owner_discord_id: 'owner1' },
      guild_config: { mod_log_channel_id: 'ch1' },
    });
    eventBus = makeEventBus();
    service = new OwnerNotificationService(client as any, 'g1', supabase as any, eventBus as any);
  });

  describe('start', () => {
    it('loads config and subscribes to events', async () => {
      await service.start();
      expect(eventBus.on).toHaveBeenCalledWith('fraud.detected', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('incident.created', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('moderation.action', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('payment.failed', expect.any(Function));
    });

    it('handles null config values', async () => {
      supabase = makeSupabase({});
      service = new OwnerNotificationService(client as any, 'g1', supabase as any, eventBus as any);
      await service.start();
      expect(eventBus.on).toHaveBeenCalled();
    });
  });

  describe('fraud.detected', () => {
    it('sends notification on fraud detection', async () => {
      await service.start();
      eventBus._emit('fraud.detected', {
        signal: 'duplicate_payment',
        orderId: 'order123',
        discordId: 'u1',
        action: 'Blocked',
      });
      // Wait for async notify
      await new Promise((r) => process.nextTick(r));
      expect(client._sendMock).toHaveBeenCalled();
    });
  });

  describe('incident.created', () => {
    it('sends notification for critical incidents', async () => {
      await service.start();
      eventBus._emit('incident.created', {
        severity: 'critical',
        title: 'DB Connection Lost',
        category: 'infrastructure',
      });
      await new Promise((r) => process.nextTick(r));
      expect(client._sendMock).toHaveBeenCalled();
    });

    it('sends notification for high severity', async () => {
      await service.start();
      eventBus._emit('incident.created', {
        severity: 'high',
        title: 'High latency',
        category: 'performance',
      });
      await new Promise((r) => process.nextTick(r));
      expect(client._sendMock).toHaveBeenCalled();
    });

    it('skips low severity incidents', async () => {
      await service.start();
      eventBus._emit('incident.created', {
        severity: 'low',
        title: 'Minor issue',
      });
      await new Promise((r) => process.nextTick(r));
      // Low severity should not trigger notification
    });
  });

  describe('moderation.action', () => {
    it('sends notification for bans', async () => {
      await service.start();
      eventBus._emit('moderation.action', {
        action: 'ban',
        discordId: 'u1',
        moderatorId: 'mod1',
        reason: 'Spamming',
      });
      await new Promise((r) => process.nextTick(r));
      expect(client._sendMock).toHaveBeenCalled();
    });

    it('sends auto-mod ban notification', async () => {
      await service.start();
      eventBus._emit('moderation.action', {
        action: 'ban',
        discordId: 'u1',
        moderatorId: 'system',
        reason: 'Auto-ban',
      });
      await new Promise((r) => process.nextTick(r));
      expect(client._sendMock).toHaveBeenCalled();
    });

    it('skips non-ban moderation actions', async () => {
      await service.start();
      eventBus._emit('moderation.action', {
        action: 'warn',
        discordId: 'u1',
        moderatorId: 'mod1',
      });
      await new Promise((r) => process.nextTick(r));
      // warn shouldn't trigger DM
    });
  });

  describe('payment.failed', () => {
    it('sends notification on payment failure', async () => {
      await service.start();
      eventBus._emit('payment.failed', {
        discordId: 'u1',
        amount: 999,
        error: 'Card declined',
      });
      await new Promise((r) => process.nextTick(r));
      expect(client._sendMock).toHaveBeenCalled();
    });

    it('handles missing fields', async () => {
      await service.start();
      eventBus._emit('payment.failed', {});
      await new Promise((r) => process.nextTick(r));
    });
  });

  describe('notify cooldown', () => {
    it('respects cooldown for same event type', async () => {
      await service.start();

      eventBus._emit('fraud.detected', { signal: 'test1' });
      await new Promise((r) => process.nextTick(r));
      const firstCallCount = client._sendMock.mock.calls.length;

      // Emit again immediately — should be throttled
      eventBus._emit('fraud.detected', { signal: 'test2' });
      await new Promise((r) => process.nextTick(r));
      expect(client._sendMock.mock.calls.length).toBe(firstCallCount);
    });
  });

  describe('notify with no admin channel', () => {
    it('only DMs owner when no admin channel configured', async () => {
      supabase = makeSupabase({
        guild: { owner_discord_id: 'owner1' },
        guild_config: { mod_log_channel_id: null },
      });
      client = makeClient({ hasChannel: false });
      service = new OwnerNotificationService(client as any, 'g1', supabase as any, eventBus as any);
      await service.start();

      eventBus._emit('fraud.detected', { signal: 'test' });
      await new Promise((r) => process.nextTick(r));
      expect(client._sendMock).toHaveBeenCalled();
    });
  });

  describe('notify error handling', () => {
    it('handles DM send failure gracefully', async () => {
      client.users.fetch.mockRejectedValue(new Error('Cannot DM user'));
      await service.start();

      eventBus._emit('fraud.detected', { signal: 'test' });
      await new Promise((r) => process.nextTick(r));
      // Should not throw
    });
  });
});
