/**
 * Wave 10 coverage: AutomationRateLimiter, MusicStatusReporter, 
 * additional branches in existing modules
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865F2, success: 0x57F287, error: 0xED4245, warning: 0xFEE75C },
  AUTOMATION_LIMITS: {
    MAX_AUTOMATIONS_PER_GUILD: 100,
    MAX_ACTIONS_PER_AUTOMATION: 10,
    MAX_CONDITIONS_PER_AUTOMATION: 5,
    MAX_DELAY_SECONDS: 3600,
    MAX_FIRES_PER_USER_PER_MINUTE: 5,
    DM_COOLDOWN_SECONDS: 300,
    ROLE_GRANT_DELAY_MS: 1000,
    MAX_CHAIN_DEPTH: 3,
  },
  isTriggerType: (value: unknown) => ['member.joined', 'message.sent'].includes(String(value)),
  isConditionType: () => true,
  isActionType: () => true,
}));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../services/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() },
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
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields||[]), ...f]; return this; }
    toJSON() { return this.data; }
  }
  return {
    Collection, EmbedBuilder,
    AutoModerationRuleTriggerType: { Keyword: 1, Spam: 3, KeywordPreset: 4, MentionSpam: 5 },
    AutoModerationActionType: { BlockMessage: 1, SendAlertMessage: 2, Timeout: 3 },
    AutoModerationRuleEventType: { MessageSend: 1 },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n },
    GatewayIntentBits: { Guilds: 1, GuildMembers: 2, GuildMessages: 256 },
  };
});

function chain(data: any = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps','single','maybeSingle'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = undefined;
  return c;
}

function valkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1), ttl: vi.fn(async () => -2),
    exists: vi.fn(async () => 0),
    setex: vi.fn(async () => 'OK'),
  } as any;
}

// ═══════════════════════════════════════════════
// AutomationRateLimiter
// ═══════════════════════════════════════════════
describe('AutomationRateLimiter', () => {
  it('allowFire first call', async () => {
    const { AutomationRateLimiter } = await import('../features/automations/rate-limiter.js');
    const rl = new AutomationRateLimiter(valkey());
    const allowed = await rl.allowFire('g1', 'u1');
    expect(allowed).toBe(true);
  });

  it('allowFire exceeds limit', async () => {
    const { AutomationRateLimiter } = await import('../features/automations/rate-limiter.js');
    const v = valkey();
    v.incr = vi.fn(async () => 6); // exceeds MAX_FIRES_PER_USER_PER_MINUTE=5
    const rl = new AutomationRateLimiter(v);
    const allowed = await rl.allowFire('g1', 'u1');
    expect(allowed).toBe(false);
  });

  it('allowDM first call', async () => {
    const { AutomationRateLimiter } = await import('../features/automations/rate-limiter.js');
    const v = valkey();
    v.exists = vi.fn(async () => 0);
    const rl = new AutomationRateLimiter(v);
    const allowed = await rl.allowDM('g1', 'auto1', 'u1');
    expect(allowed).toBe(true);
  });

  it('allowDM on cooldown', async () => {
    const { AutomationRateLimiter } = await import('../features/automations/rate-limiter.js');
    const v = valkey();
    v.exists = vi.fn(async () => 1);
    const rl = new AutomationRateLimiter(v);
    const allowed = await rl.allowDM('g1', 'auto1', 'u1');
    expect(allowed).toBe(false);
  });

  it('allowCustom first call', async () => {
    const { AutomationRateLimiter } = await import('../features/automations/rate-limiter.js');
    const rl = new AutomationRateLimiter(valkey());
    const allowed = await rl.allowCustom('g1', 'auto1', 'u1', 3, 60);
    expect(allowed).toBe(true);
  });

  it('allowCustom exceeds limit', async () => {
    const { AutomationRateLimiter } = await import('../features/automations/rate-limiter.js');
    const v = valkey();
    v.incr = vi.fn(async () => 4);
    const rl = new AutomationRateLimiter(v);
    const allowed = await rl.allowCustom('g1', 'auto1', 'u1', 3, 60);
    expect(allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════
// MusicStatusReporter
// ═══════════════════════════════════════════════
describe('MusicStatusReporter', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('construct and start/stop', async () => {
    const { MusicStatusReporter } = await import('../services/music-status-reporter.js');
    const musicPlayer = {
      getStatus: vi.fn(async () => ({
        nowPlaying: null, queue: [], volume: 80, paused: false,
        loop: 'none', autoplay: false,
      })),
    } as any;
    const supa = { from: vi.fn(() => chain(null)) } as any;
    const reporter = new MusicStatusReporter(musicPlayer, supa, 'g1');
    reporter.start(60000);
    await new Promise(r => setTimeout(r, 50));
    reporter.stop();
    expect(musicPlayer.getStatus).toHaveBeenCalled();
  });

  it('stop without start', async () => {
    const { MusicStatusReporter } = await import('../services/music-status-reporter.js');
    const reporter = new MusicStatusReporter({ getStatus: vi.fn() } as any, { from: vi.fn(() => chain(null)) } as any, 'g1');
    reporter.stop(); // should not throw
  });
});



// ═══════════════════════════════════════════════
// Additional: AutomationLoader
// ═══════════════════════════════════════════════
describe('AutomationLoader', () => {
  it('construct and loadAll', async () => {
    const { AutomationLoader } = await import('../features/automations/automation-loader.js');
    const supa = {
      from: vi.fn(() => {
        const c: any = {};
        for (const m of ['select','eq','neq','order','limit'])
          c[m] = vi.fn(() => c);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      }),
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn(),
      })),
    } as any;
    const loader = new AutomationLoader(supa, 'g1');
    await loader.load();
    const triggers = loader.getForTrigger('member.joined');
    expect(triggers).toBeDefined();
  });

  it('getForTrigger empty', async () => {
    const { AutomationLoader } = await import('../features/automations/automation-loader.js');
    const supa = {
      from: vi.fn(() => {
        const c: any = {};
        for (const m of ['select','eq','neq','order','limit'])
          c[m] = vi.fn(() => c);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      }),
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn(),
      })),
    } as any;
    const loader = new AutomationLoader(supa, 'g1');
    await loader.load();
    const result = loader.getForTrigger('message.sent');
    expect(Array.isArray(result)).toBe(true);
  });
});
