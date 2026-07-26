/**
 * Wave 8 coverage tests: VoiceXP, GuildOnboardingSync, OwnerNotificationService,
 * GiveawayFulfillmentService, DeployListener
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  it('start and sync enabled', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const supa = {
      from: vi.fn(() => chain({
        onboarding_enabled: true,
        onboarding_config: {
          enabled: true,
          prompts: [
            {
              title: 'What are you interested in?',
              type: 'multiple_choice',
              required: true,
              single_select: false,
              options: [
                { title: 'Gaming', role_ids: ['r1'] },
                { title: 'Art', channel_ids: ['ch1'] },
              ],
            },
          ],
          default_channel_ids: ['ch1'],
        },
      })),
    } as any;
    const g = guild();
    const sync = new GuildOnboardingSync(g, supa, eb());
    sync.start();
    await sync.syncOnboarding();
  });

  it('syncOnboarding disabled', async () => {
    const { GuildOnboardingSync } = await import('../features/discord-native/guild-onboarding-sync.js');
    const supa = { from: vi.fn(() => chain({ onboarding_enabled: false })) } as any;
    const sync = new GuildOnboardingSync(guild(), supa, eb());
    await sync.syncOnboarding();
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
