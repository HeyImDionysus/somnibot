/**
 * Wave 8 coverage tests: VoiceXP, GuildOnboardingSync, OwnerNotificationService,
 * GiveawayFulfillmentService, DeployListener
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LEVEL_CONFIG: { DEFAULT_MIN_XP: 15, DEFAULT_MAX_XP: 25, DEFAULT_COOLDOWN_SECONDS: 60 },
  calculateLevel: (xp: number) => Math.floor(Math.sqrt(xp / 100)),
}));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}), writeAuditBatch: vi.fn(async () => {}) }));
vi.mock('../services/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() },
}));
vi.mock('../features/levels/xp-tracker.js', () => ({
  loadLevelConfig: vi.fn(async () => ({
    levels_enabled: true,
    voice_xp_enabled: true,
    voice_xp_per_interval: 10,
    voice_xp_interval_minutes: 5,
  })),
  grantVoiceXp: vi.fn(async () => ({ leveledUp: false, newLevel: 1, oldLevel: 1, newXp: 100 })),
}));
vi.mock('../features/levels/level-announcer.js', () => ({
  handleLevelUp: vi.fn(async () => {}),
}));
vi.mock('../deploy/deployer.js', () => ({
  deployServerState: vi.fn(async () => ({ success: true, changes: [] })),
}));
vi.mock('../services/guild-snapshot.js', () => ({
  writeGuildSnapshot: vi.fn(async () => {}),
}));
vi.mock('../features/commerce/entitlement-service.js', () => ({
  EntitlementService: class {
    constructor() {}
    async grantEntitlement() { return { success: true }; }
  },
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
  }
  class EmbedBuilder {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setTimestamp() { return this; }
    setFooter(f: any) { return this; }
    setAuthor(a: any) { return this; }
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields||[]), ...f]; return this; }
    toJSON() { return this.data; }
  }
  return {
    Collection, EmbedBuilder,
    GuildOnboardingPromptType: { MultipleChoice: 0, Dropdown: 1 },
  };
});

const { Collection } = await import('discord.js');

function chain(data: any = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps','single','maybeSingle'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = undefined;
  return c;
}
function chainAsync(data: any[] = [], count: number | null = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data: data?.[0] ?? null, error: null, count }));
  c.single = vi.fn(async () => ({ data: data?.[0] ?? null, error: null, count }));
  c.then = (resolve: Function) => resolve({ data, error: null, count });
  return c;
}
function guild(id = 'g1') {
  const channels = new Collection<string, any>();
  const textCh: any = {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({ id: 'msg1' })),
  };
  channels.set('ch1', textCh);
  const voiceStates = new Collection<string, any>();
  voiceStates.set('u1', {
    member: { id: 'u1', user: { id: 'u1', bot: false }, roles: { cache: new Collection([['r1', { id: 'r1' }]]) } },
    channelId: 'vc1',
    selfDeaf: false, serverDeaf: false,
  });
  return {
    id, name: 'Test Guild', memberCount: 50,
    channels: { cache: channels, fetch: vi.fn(async () => channels) },
    members: {
      cache: new Collection(),
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'User', bot: false },
        displayName: 'User', send: vi.fn(async () => ({})),
        roles: { cache: new Collection() },
      })),
    },
    voiceStates: { cache: voiceStates },
    afkChannelId: null,
    client: { user: { id: 'bot1' }, guilds: { cache: new Collection() } },
    fetchOnboarding: vi.fn(async () => null),
    iconURL: () => 'https://example.com/icon.png',
  } as any;
}
function valkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})),
    keys: vi.fn(async () => []), setex: vi.fn(async () => 'OK'),
  } as any;
}
const eb = () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() } as any);

// ═══════════════════════════════════════════════
// VoiceXP
// ═══════════════════════════════════════════════
describe('VoiceXP', () => {
  it('onVoiceStateUpdate - join voice', async () => {
    const { onVoiceStateUpdate } = await import('../features/levels/voice-xp.js');
    const oldState = {
      member: { id: 'u1', user: { id: 'u1', bot: false }, roles: { cache: new Collection([['r1', { id: 'r1' }]]) } },
      channelId: null,
      selfDeaf: false, serverDeaf: false,
      guild: { afkChannelId: null },
    } as any;
    const newState = {
      member: { id: 'u1', user: { id: 'u1', bot: false }, roles: { cache: new Collection([['r1', { id: 'r1' }]]) } },
      channelId: 'vc1',
      selfDeaf: false, serverDeaf: false,
      guild: { afkChannelId: null },
    } as any;
    onVoiceStateUpdate(oldState, newState);
  });

  it('onVoiceStateUpdate - leave voice', async () => {
    const { onVoiceStateUpdate } = await import('../features/levels/voice-xp.js');
    const oldState = {
      member: { id: 'u1', user: { id: 'u1', bot: false }, roles: { cache: new Collection([['r1', { id: 'r1' }]]) } },
      channelId: 'vc1',
      selfDeaf: false, serverDeaf: false,
      guild: { afkChannelId: null },
    } as any;
    const newState = {
      member: { id: 'u1', user: { id: 'u1', bot: false }, roles: { cache: new Collection() } },
      channelId: null,
      selfDeaf: false, serverDeaf: false,
      guild: { afkChannelId: null },
    } as any;
    onVoiceStateUpdate(oldState, newState);
  });

  it('onVoiceStateUpdate - deafened', async () => {
    const { onVoiceStateUpdate } = await import('../features/levels/voice-xp.js');
    const state = {
      member: { id: 'u1', user: { id: 'u1', bot: false }, roles: { cache: new Collection() } },
      channelId: 'vc1',
      selfDeaf: true, serverDeaf: false,
      guild: { afkChannelId: null },
    } as any;
    onVoiceStateUpdate(state, state);
  });

  it('onVoiceStateUpdate - bot ignored', async () => {
    const { onVoiceStateUpdate } = await import('../features/levels/voice-xp.js');
    const state = {
      member: { id: 'b1', user: { id: 'b1', bot: true }, roles: { cache: new Collection() } },
      channelId: 'vc1',
      selfDeaf: false, serverDeaf: false,
      guild: { afkChannelId: null },
    } as any;
    onVoiceStateUpdate(state, state);
  });

  it('onVoiceStateUpdate - AFK channel', async () => {
    const { onVoiceStateUpdate } = await import('../features/levels/voice-xp.js');
    const state = {
      member: { id: 'u1', user: { id: 'u1', bot: false }, roles: { cache: new Collection() } },
      channelId: 'afk1',
      selfDeaf: false, serverDeaf: false,
      guild: { afkChannelId: 'afk1' },
    } as any;
    onVoiceStateUpdate(state, state);
  });

  it('initVoiceTracking', async () => {
    const { initVoiceTracking } = await import('../features/levels/voice-xp.js');
    await initVoiceTracking(guild());
  });
});

// ═══════════════════════════════════════════════
// GuildOnboardingSync
// ═══════════════════════════════════════════════
describe('GuildOnboardingSync', () => {
  function leaseRpc() {
    return vi.fn(async (name: string) => {
      if (name === 'acquire_onboarding_sync_lease') {
        return {
          data: {
            disposition: 'acquired',
            lease_token: '77777777-7777-4777-8777-777777777777',
          },
          error: null,
        };
      }
      return { data: true, error: null };
    });
  }

  it('syncs persisted onboarding once when startup runs and avoids duplicate listeners', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const supa = { from: vi.fn(() => chain({
      onboarding_enabled: true,
      onboarding_config: { enabled: true, prompts: [], default_channel_ids: [] },
      onboarding_sync_state: {
        status: 'pending',
        request_id: '00000000-0000-4000-8000-000000000001',
      },
    })), rpc: leaseRpc() } as unknown as SupabaseClient;
    const g = guild();
    g.editOnboarding = vi.fn(async () => ({
      enabled: true,
      prompts: new Collection(),
      defaultChannels: new Collection(),
    }));
    const eventBus = eb();
    const sync = new GuildOnboardingSync(g, supa, eventBus);

    // Given: persisted onboarding configuration is available at bot startup.
    // When: startup is invoked twice for the same guild service.
    sync.start();
    sync.start();

    // Then: exactly one initial Discord sync and one config listener exist.
    await vi.waitFor(() => {
      expect(g.editOnboarding).toHaveBeenCalledTimes(1);
      expect(g.editOnboarding).toHaveBeenCalledWith({
        enabled: true,
        prompts: [],
        defaultChannels: [],
      });
    });
    expect(eventBus.on).toHaveBeenCalledTimes(1);

    const configChangedHandler = eventBus.on.mock.calls[0][1];
    configChangedHandler({ data: { section: 'onboarding' } });
    await vi.waitFor(() => expect(g.editOnboarding).toHaveBeenCalledTimes(2));
  });

  it('syncs native roles and channels, including a deduplicated interest-role mapping', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const db = chain({
        onboarding_enabled: true,
        interest_role_mapping: { Gaming: 'r1' },
        onboarding_sync_state: {
          status: 'pending',
          request_id: '11111111-1111-4111-8111-111111111111',
          requested_at: '2026-08-20T12:00:00.000Z',
        },
        onboarding_config: {
          enabled: true,
          prompts: [
            {
              title: 'What are you interested in?',
              type: 'multiple_choice',
              required: true,
              single_select: false,
              options: [
                { title: 'Gaming', role_ids: ['r1'], emoji: '🎮' },
                { title: 'Art', channel_ids: ['ch1'], emoji: '<:palette:123456789012345678>' },
              ],
            },
          ],
          default_channel_ids: ['ch1'],
        },
      });
    const supa = { from: vi.fn(() => db), rpc: leaseRpc() } as unknown as SupabaseClient;
    const g = guild();
    g.editOnboarding = vi.fn(async () => ({
      enabled: true,
      defaultChannels: new Collection([['ch1', { id: 'ch1' }]]),
      prompts: new Collection([['prompt1', {
        title: 'What are you interested in?',
        type: 0,
        required: true,
        singleSelect: false,
        options: new Collection([
          ['option1', {
            title: 'Gaming', description: null, emoji: { identifier: '%F0%9F%8E%AE' },
            roles: new Collection([['r1', { id: 'r1' }]]), channels: new Collection(),
          }],
          ['option2', {
            title: 'Art', description: null, emoji: { identifier: 'palette:123456789012345678' },
            roles: new Collection(), channels: new Collection([['ch1', { id: 'ch1' }]]),
          }],
        ]),
      }]]),
    }));
    const sync = new GuildOnboardingSync(g, supa, eb());
    await sync.syncOnboarding();

    expect(g.fetchOnboarding).toHaveBeenCalledOnce();
    expect(g.editOnboarding).toHaveBeenCalledWith({
      enabled: true,
      prompts: [{
        title: 'What are you interested in?',
        type: 0,
        required: true,
        singleSelect: false,
        options: [
          { title: 'Gaming', description: null, emoji: '🎮', roles: ['r1'], channels: [] },
          { title: 'Art', description: null, emoji: 'palette:123456789012345678', roles: [], channels: ['ch1'] },
        ],
      }],
      defaultChannels: ['ch1'],
    });
    expect(db.update).toHaveBeenCalledWith({
      onboarding_sync_state: expect.objectContaining({
        status: 'synced',
        request_id: '11111111-1111-4111-8111-111111111111',
        live_config: expect.objectContaining({
          enabled: true,
          default_channel_ids: ['ch1'],
        }),
      }),
    });
    expect(db.contains).toHaveBeenCalledWith('onboarding_sync_state', {
      request_id: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('does not attempt a native onboarding edit when the preflight readback fails', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const db = chain({
      onboarding_enabled: true,
      onboarding_sync_state: {
        status: 'pending',
        request_id: '22222222-2222-4222-8222-222222222222',
      },
      onboarding_config: { enabled: true, prompts: [], default_channel_ids: [] },
    });
    const supa = { from: vi.fn(() => db), rpc: leaseRpc() } as unknown as SupabaseClient;
    const g = guild();
    g.fetchOnboarding.mockRejectedValueOnce(new Error('Community onboarding unavailable'));
    g.editOnboarding = vi.fn(async () => ({}));

    const eventBus = eb();
    await new GuildOnboardingSync(g, supa, eventBus).syncOnboarding();

    expect(g.editOnboarding).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith('sync.failed', 'g1', {
      stage: 'discord-native-onboarding',
      error: 'Error: Community onboarding unavailable',
    });
    expect(db.update).toHaveBeenCalledWith({
      onboarding_sync_state: expect.objectContaining({
        status: 'failed',
        request_id: '22222222-2222-4222-8222-222222222222',
        error: 'Error: Community onboarding unavailable',
      }),
    });
  });

  it('reports a configuration read failure without touching Discord', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const supa = {
      from: vi.fn(() => chain(null, { message: 'database unavailable' })),
      rpc,
    } as unknown as SupabaseClient;
    const g = guild();
    g.editOnboarding = vi.fn();
    const eventBus = eb();

    await expect(new GuildOnboardingSync(g, supa, eventBus).syncOnboarding(
      '77777777-7777-4777-8777-777777777777',
    ))
      .rejects.toThrow('Onboarding configuration read failed: database unavailable');

    expect(g.fetchOnboarding).not.toHaveBeenCalled();
    expect(g.editOnboarding).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith('sync.failed', 'g1', {
      stage: 'discord-native-onboarding',
      error: 'Onboarding configuration read failed: database unavailable',
    });
    expect(rpc).toHaveBeenCalledWith('fail_pending_onboarding_sync', {
      p_guild_id: 'g1',
      p_request_id: '77777777-7777-4777-8777-777777777777',
      p_error: 'Onboarding configuration read failed: database unavailable',
    });
  });

  it('adopts live onboarding on first startup without mutating legacy defaults', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const config = {
      onboarding_enabled: true,
      onboarding_config: { enabled: true, prompts: [], default_channel_ids: [] },
    };
    const firstRead = chain({ ...config, onboarding_sync_state: { status: 'idle' } });
    const firstWrite = chain({ guild_id: 'g1' });
    const secondRead = chain({ ...config, onboarding_sync_state: { status: 'drifted', managed: false } });
    const secondWrite = chain({ guild_id: 'g1' });
    const queries = [firstRead, firstWrite, secondRead, secondWrite];
    const supa = { from: vi.fn(() => {
      const query = queries.shift();
      if (!query) throw new Error('Unexpected database query');
      return query;
    }) } as unknown as SupabaseClient;
    const g = guild();
    g.editOnboarding = vi.fn();
    g.fetchOnboarding.mockResolvedValueOnce({
      enabled: true,
      prompts: new Collection(),
      defaultChannels: new Collection([['legacy', { id: 'legacy' }]]),
    });

    const sync = new GuildOnboardingSync(g, supa, eb());
    await sync.syncOnboarding();
    await sync.syncOnboarding();

    expect(g.editOnboarding).not.toHaveBeenCalled();
    expect(firstWrite.update).toHaveBeenCalledWith({
      onboarding_sync_state: expect.objectContaining({
        status: 'drifted',
        managed: false,
        live_config: expect.objectContaining({ default_channel_ids: ['legacy'] }),
      }),
    });
    expect(secondWrite.update).toHaveBeenCalledWith({
      onboarding_sync_state: expect.objectContaining({ managed: false }),
    });
  });

  it('disables Discord onboarding and records the authoritative state', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const db = chain({
      onboarding_enabled: false,
      onboarding_sync_state: {
        status: 'pending',
        request_id: '33333333-3333-4333-8333-333333333333',
      },
    });
    const supa = { from: vi.fn(() => db), rpc: leaseRpc() } as unknown as SupabaseClient;
    const g = guild();
    g.editOnboarding = vi.fn(async () => ({
      enabled: false,
      prompts: new Collection(),
      defaultChannels: new Collection(),
    }));
    const sync = new GuildOnboardingSync(g, supa, eb());
    await sync.syncOnboarding();

    expect(g.editOnboarding).toHaveBeenCalledWith({ enabled: false });
    expect(db.update).toHaveBeenCalledWith({
      onboarding_sync_state: expect.objectContaining({
        status: 'synced',
        request_id: '33333333-3333-4333-8333-333333333333',
        live_config: expect.objectContaining({ enabled: false }),
      }),
    });
  });

  it('records drift when Discord remains enabled after a disable request', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const db = chain({
      onboarding_enabled: false,
      onboarding_sync_state: {
        status: 'pending',
        request_id: '44444444-4444-4444-8444-444444444444',
      },
    });
    const supa = { from: vi.fn(() => db), rpc: leaseRpc() } as unknown as SupabaseClient;
    const g = guild();
    g.editOnboarding = vi.fn(async () => ({
      enabled: true,
      prompts: new Collection(),
      defaultChannels: new Collection(),
    }));

    await new GuildOnboardingSync(g, supa, eb()).syncOnboarding();

    expect(db.update).toHaveBeenCalledWith({
      onboarding_sync_state: expect.objectContaining({
        status: 'drifted',
        live_config: expect.objectContaining({ enabled: true }),
      }),
    });
  });

  it('serializes overlapping changes so the newest request is the final Discord edit', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const firstRead = chain({
      onboarding_enabled: true,
      onboarding_sync_state: { status: 'pending', request_id: '55555555-5555-4555-8555-555555555555' },
      onboarding_config: { enabled: true, prompts: [], default_channel_ids: ['first'] },
    });
    const secondRead = chain({
      onboarding_enabled: true,
      onboarding_sync_state: { status: 'pending', request_id: '66666666-6666-4666-8666-666666666666' },
      onboarding_config: { enabled: true, prompts: [], default_channel_ids: ['second'] },
    });
    const firstWrite = chain({ guild_id: 'g1' });
    const secondWrite = chain({ guild_id: 'g1' });
    const queries = [firstRead, firstWrite, secondRead, secondWrite];
    const supa = {
      from: vi.fn(() => {
        const query = queries.shift();
        if (!query) throw new Error('Unexpected database query');
        return query;
      }),
      rpc: leaseRpc(),
    } as unknown as SupabaseClient;
    const g = guild();
    let finishFirst: ((value: unknown) => void) | undefined;
    const firstEdit = new Promise((resolve) => { finishFirst = resolve; });
    g.editOnboarding = vi.fn()
      .mockImplementationOnce(() => firstEdit)
      .mockResolvedValueOnce({
        enabled: true,
        prompts: new Collection(),
        defaultChannels: new Collection([['second', { id: 'second' }]]),
      });
    const sync = new GuildOnboardingSync(g, supa, eb());

    const older = sync.syncOnboarding();
    const newer = sync.syncOnboarding();
    await vi.waitFor(() => expect(g.editOnboarding).toHaveBeenCalledTimes(1));
    expect(g.editOnboarding).toHaveBeenLastCalledWith(expect.objectContaining({ defaultChannels: ['first'] }));
    finishFirst?.({
      enabled: true,
      prompts: new Collection(),
      defaultChannels: new Collection([['first', { id: 'first' }]]),
    });
    await Promise.all([older, newer]);

    expect(g.editOnboarding).toHaveBeenCalledTimes(2);
    expect(g.editOnboarding).toHaveBeenLastCalledWith(expect.objectContaining({ defaultChannels: ['second'] }));
    expect(secondWrite.contains).toHaveBeenCalledWith('onboarding_sync_state', {
      request_id: '66666666-6666-4666-8666-666666666666',
    });
  });

  it('does not edit Discord while another instance owns the guild synchronization lease', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const db = chain({
      onboarding_enabled: true,
      onboarding_sync_state: {
        status: 'pending',
        request_id: '77777777-7777-4777-8777-777777777777',
      },
      onboarding_config: { enabled: true, prompts: [], default_channel_ids: [] },
    });
    const rpc = vi.fn(async (name: string) => name === 'acquire_onboarding_sync_lease'
      ? { data: { disposition: 'busy', lease_token: null }, error: null }
      : { data: true, error: null });
    const supa = { from: vi.fn(() => db), rpc } as unknown as SupabaseClient;
    const g = guild();
    g.editOnboarding = vi.fn();

    await expect(new GuildOnboardingSync(g, supa, eb()).syncOnboarding(
      '77777777-7777-4777-8777-777777777777',
    )).rejects.toThrow('already running');

    expect(g.fetchOnboarding).not.toHaveBeenCalled();
    expect(g.editOnboarding).not.toHaveBeenCalled();
  });

  it('syncOnboarding no config', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const supa = { from: vi.fn(() => chain(null)) } as any;
    const sync = new GuildOnboardingSync(guild(), supa, eb());
    await sync.syncOnboarding();
  });
});

// ═══════════════════════════════════════════════
// OwnerNotificationService
// ═══════════════════════════════════════════════
describe('OwnerNotificationService', () => {
  it('construct and start', async () => {
    const { OwnerNotificationService } = await import('../services/owner-notifications.js');
    const g = guild();
    const client = {
      user: { id: 'bot1' },
      users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => ({})) })) },
      guilds: { cache: new Collection([['g1', g]]) },
    } as any;
    const supa = {
      from: vi.fn((t: string) => {
        if (t === 'guild') return chain({ owner_discord_id: 'owner1' });
        if (t === 'guild_config') return chain({ mod_log_channel_id: 'ch1' });
        return chain(null);
      }),
    } as any;
    const service = new OwnerNotificationService(client, 'g1', supa, eb());
    await service.start();
  });

  it('construct no owner', async () => {
    const { OwnerNotificationService } = await import('../services/owner-notifications.js');
    const client = {
      user: { id: 'bot1' },
      users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => ({})) })) },
      guilds: { cache: new Collection() },
    } as any;
    const supa = { from: vi.fn(() => chain(null)) } as any;
    const service = new OwnerNotificationService(client, 'g1', supa, eb());
    await service.start();
  });
});

// ═══════════════════════════════════════════════
// GiveawayFulfillmentService
// ═══════════════════════════════════════════════
describe('GiveawayFulfillmentService', () => {
  it('construct', async () => {
    const { GiveawayFulfillmentService } = await import('../services/giveaway-fulfillment.js');
    const supa = { from: vi.fn(() => chain(null)) } as any;
    const service = new GiveawayFulfillmentService(guild(), supa, eb());
    expect(service).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// DeployListener
// ═══════════════════════════════════════════════
describe('DeployListener', () => {
  it('getDeployStatus returns null initially', async () => {
    const { getDeployStatus } = await import('../deploy/deploy-listener.js');
    expect(getDeployStatus()).toBeNull();
  });
});
