/**
 * OwnerNotificationService — coverage tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockEventBus, mockGuild, mockSupabase } from './helpers/discord-mocks.js';

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

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { OwnerNotificationService } from '../services/owner-notifications.js';

// ── Helpers ───────────────────────────────────────────────

function makeSupabase(overrides: Record<string, unknown> = {}) {
  const fromMock = vi.fn();
  fromMock.mockImplementation((table: string) => {
    const chain: Record<PropertyKey, unknown> = {};
    const methods = ['select', 'eq', 'single', 'maybeSingle'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    const data = overrides[table] ?? null;
    chain.then = (resolve: (value: { readonly data: unknown; readonly error: null }) => void) =>
      resolve({ data, error: null });
    return chain;
  });
  const supabase = mockSupabase();
  supabase.from = fromMock;
  return supabase;
}

function makeEventBus() {
  const listeners: Record<string, Array<(event: { readonly type: string; readonly guildId: string; readonly data: Record<string, unknown> }) => void>> = {};
  const eventBus = mockEventBus();
  eventBus.on = vi.fn((event: string, handler: (payload: { readonly type: string; readonly guildId: string; readonly data: Record<string, unknown> }) => void) => {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(handler);
  });
  eventBus._emit = (type: string, data: Record<string, unknown>, guildId = 'g1') => {
    for (const handler of listeners[type] ?? []) {
      handler({ type, guildId, data });
    }
  };
  eventBus._listeners = listeners;
  return eventBus;
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const client = mockGuild();
  const sendMock = vi.fn().mockResolvedValue(undefined);
  const channel = overrides.hasChannel === true ? { send: sendMock } : null;
  client.guilds = {
    cache: {
      get: vi.fn().mockReturnValue({
        channels: { cache: { get: vi.fn().mockReturnValue(channel) } },
      }),
    },
  };
  client.users = {
    fetch: vi.fn().mockResolvedValue({ send: sendMock }),
  };
  client._sendMock = sendMock;
  return client;
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
    service = new OwnerNotificationService(client, 'g1', supabase, eventBus);
  });

  describe('start', () => {
    it('loads config and subscribes to events', async () => {
      await service.start();
      expect(eventBus.on).toHaveBeenCalledWith('fraud.detected', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('incident.created', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('moderation.action', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('payment.failed', expect.any(Function));
    });

    it('ignores events emitted for another guild', async () => {
      await service.start();

      eventBus._emit('incident.created', {
        severity: 'critical',
        title: 'Other server incident',
        category: 'infrastructure',
      }, 'g2');
      await new Promise((resolve) => process.nextTick(resolve));

      expect(client._sendMock).not.toHaveBeenCalled();
    });

    it('handles null config values', async () => {
      supabase = makeSupabase({});
      service = new OwnerNotificationService(client, 'g1', supabase, eventBus);
      await service.start();
      expect(eventBus.on).toHaveBeenCalled();
    });
  });

  describe('fraud.detected', () => {
    it('DMs the owner for a critical signal', async () => {
      await service.start();
      eventBus._emit('fraud.detected', {
        signal: 'velocity',
        severity: 'critical',
        discordId: 'u1',
        action: 'Flagged',
      });
      // Wait for async notify
      await new Promise((r) => process.nextTick(r));
      expect(client._sendMock).toHaveBeenCalled();
    });

    it('does NOT DM the owner for a non-critical signal (no staff channel)', async () => {
      await service.start();
      eventBus._emit('fraud.detected', {
        signal: 'payment_pattern',
        severity: 'medium',
        discordId: 'u1',
      });
      await new Promise((r) => process.nextTick(r));
      // No staff channel configured + non-critical → neither mirror nor DM.
      expect(client._sendMock).not.toHaveBeenCalled();
    });

    it('does NOT DM the owner when owner-dm-on-critical is disabled', async () => {
      supabase = makeSupabase({
        guild: { owner_discord_id: 'owner1' },
        guild_config: { mod_log_channel_id: 'ch1', fraud_owner_dm_on_critical: false },
      });
      client = makeClient({ hasChannel: false });
      service = new OwnerNotificationService(client, 'g1', supabase, eventBus);
      await service.start();
      eventBus._emit('fraud.detected', { signal: 'velocity', severity: 'critical', discordId: 'u1' });
      await new Promise((r) => process.nextTick(r));
      expect(client._sendMock).not.toHaveBeenCalled();
    });

    it('mirrors every signal to the staff channel and DMs owner on critical', async () => {
      supabase = makeSupabase({
        guild: { owner_discord_id: 'owner1' },
        guild_config: { mod_log_channel_id: 'ch1', fraud_staff_alert_channel_id: 'staff1', fraud_owner_dm_on_critical: true },
      });
      client = makeClient({ hasChannel: true });
      service = new OwnerNotificationService(client, 'g1', supabase, eventBus);
      await service.start();
      eventBus._emit('fraud.detected', { signal: 'velocity', severity: 'critical', discordId: 'u1' });
      await new Promise((r) => process.nextTick(r));
      // One send to the staff channel mirror + one owner DM.
      expect(client._sendMock).toHaveBeenCalledTimes(2);
    });

    it('mirrors a non-critical signal to the staff channel without DMing owner', async () => {
      const dmMock = vi.fn().mockResolvedValue(undefined);
      const channelSend = vi.fn().mockResolvedValue(undefined);
      const localClient = mockGuild();
      localClient.guilds = {
        cache: {
          get: vi.fn().mockReturnValue({
            channels: { cache: { get: vi.fn().mockReturnValue({ send: channelSend }) } },
          }),
        },
      };
      localClient.users = { fetch: vi.fn().mockResolvedValue({ send: dmMock }) };
      supabase = makeSupabase({
        guild: { owner_discord_id: 'owner1' },
        guild_config: { mod_log_channel_id: 'ch1', fraud_staff_alert_channel_id: 'staff1', fraud_owner_dm_on_critical: true },
      });
      service = new OwnerNotificationService(localClient, 'g1', supabase, eventBus);
      await service.start();
      eventBus._emit('fraud.detected', { signal: 'payment_pattern', severity: 'medium', discordId: 'u1' });
      await new Promise((r) => process.nextTick(r));
      expect(channelSend).toHaveBeenCalledTimes(1);
      expect(dmMock).not.toHaveBeenCalled();
    });
  });

  describe('incident.created', () => {
    it('suppresses runtime delivery when the feature rollout is emergency-disabled', async () => {
      supabase = makeSupabase({
        guild: { owner_discord_id: 'owner1' },
        guild_config: {
          mod_log_channel_id: 'ch1',
          owner_notification_rollout: {
            state: 'emergency_disabled',
            guildIds: [],
            deploymentIds: [],
          },
        },
      });
      service = new OwnerNotificationService(client, 'g1', supabase, eventBus);
      await service.start();

      eventBus._emit('incident.created', {
        severity: 'critical',
        title: 'DB Connection Lost',
        category: 'infrastructure',
      });
      await new Promise((resolve) => process.nextTick(resolve));

      expect(client._sendMock).not.toHaveBeenCalled();
    });

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

      eventBus._emit('fraud.detected', { signal: 'test1', severity: 'critical' });
      await new Promise((r) => process.nextTick(r));
      const firstCallCount = client._sendMock.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      // Emit again immediately — the owner-DM path should be throttled
      eventBus._emit('fraud.detected', { signal: 'test2', severity: 'critical' });
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
      service = new OwnerNotificationService(client, 'g1', supabase, eventBus);
      await service.start();

      eventBus._emit('fraud.detected', { signal: 'test', severity: 'critical' });
      await new Promise((r) => process.nextTick(r));
      expect(client._sendMock).toHaveBeenCalled();
    });
  });

  describe('notify error handling', () => {
    it('handles DM send failure gracefully', async () => {
      client.users.fetch.mockRejectedValue(new Error('Cannot DM user'));
      await service.start();

      eventBus._emit('fraud.detected', { signal: 'test', severity: 'critical' });
      await new Promise((r) => process.nextTick(r));
      // Should not throw
    });
  });
});
