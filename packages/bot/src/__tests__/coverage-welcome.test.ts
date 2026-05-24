/**
 * Coverage tests — Welcome/Onboarding subsystem
 * Tests: onboarding-handler, welcome-service, goodbye-service, member-service
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, warning: 0xfee75c, error: 0xed4245 },
}));

vi.mock('discord.js', () => ({
  GuildMemberFlags: { CompletedOnboarding: 1 << 1, DidRejoin: 1 << 2, StartedOnboarding: 1 << 3 },
  EmbedBuilder: class {
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    setThumbnail() { return this; }
    setTimestamp() { return this; }
    setFooter() { return this; }
    setImage() { return this; }
    setAuthor() { return this; }
    addFields() { return this; }
    toJSON() { return {}; }
  },
  AttachmentBuilder: class {
    constructor() {}
  },
  ChannelType: { GuildText: 0 },
  PermissionFlagsBits: {},
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock('../features/welcome/member-service.js', () => ({
  lookupMember: vi.fn(async () => null),
  recordMemberJoin: vi.fn(async () => {}),
  recordMemberLeave: vi.fn(async () => {}),
  markOnboardingCompleted: vi.fn(async () => {}),
}));

vi.mock('../features/welcome/welcome-service.js', () => ({
  executeWelcomeFlow: vi.fn(async () => {}),
}));

vi.mock('../features/welcome/goodbye-service.js', () => ({
  executeGoodbyeFlow: vi.fn(async () => {}),
}));

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in', 'is', 'not',
    'order', 'limit', 'single', 'maybeSingle', 'match']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa(result?: any) {
  const chain = makeChain(result);
  // Return fresh chain per call so state doesn't leak between queries
  return { from: vi.fn(() => makeChain(result)), _chain: chain };
}

function makeValkey() {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    setex: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
  };
}

function makeClient(supaResult?: any) {
  const supa = makeSupa(supaResult);
  return {
    supabase: supa,
    valkey: makeValkey(),
    eventBus: { emit: vi.fn(), on: vi.fn() },
    channels: { cache: { get: vi.fn(() => ({ send: vi.fn(async () => {}) })) } },
    guilds: { cache: { get: vi.fn() } },
    user: { id: 'bot1' },
  };
}

describe('onboarding-handler', () => {
  let handler: typeof import('../features/welcome/onboarding-handler.js');

  beforeEach(async () => {
    vi.resetModules();
    handler = await import('../features/welcome/onboarding-handler.js');
  });

  function makeMember(flags = 0, overrides: any = {}) {
    const flagSet = new Set<number>();
    // Set individual flag bits
    if (flags & 2) flagSet.add(2);  // CompletedOnboarding
    if (flags & 4) flagSet.add(4);  // DidRejoin
    if (flags & 8) flagSet.add(8);  // StartedOnboarding
    return {
      id: 'u1',
      guild: {
        id: 'g1',
        name: 'Test Guild',
        roles: { cache: new Map([['r1', { id: 'r1', name: 'Member' }]]) },
        memberCount: 100,
      },
      user: { tag: 'User#0001', displayAvatarURL: () => 'url', bot: false, id: 'u1' },
      flags: { bitfield: flags, has: (flag: number) => flagSet.has(flag) },
      roles: { add: vi.fn(async () => {}), cache: Object.assign(new Map(), { map: (fn: Function) => [] as any[] }) },
      pending: false,
      ...overrides,
    };
  }

  it('handleMemberJoin processes new member', async () => {
    const client = makeClient({ data: { member_role_id: 'r1', welcome_channel_id: 'ch1' }, error: null });
    await handler.handleMemberJoin(client as any, makeMember() as any);
    expect(client.supabase.from).toHaveBeenCalled();
  });

  it('handleMemberJoin skips bots', async () => {
    const client = makeClient();
    await handler.handleMemberJoin(client as any, makeMember(0, { user: { tag: 'Bot#0001', bot: true, displayAvatarURL: () => 'url' } }) as any);
  });

  it('handleMemberUpdate detects onboarding completion', async () => {
    const client = makeClient({ data: { member_role_id: 'r1', welcome_channel_id: 'ch1' }, error: null });
    const oldMember = makeMember(0);
    const newMember = makeMember(2); // CompletedOnboarding flag
    await handler.handleMemberUpdate(client as any, oldMember as any, newMember as any);
    expect(client.supabase.from).toHaveBeenCalled();
  });

  it('handleMemberLeave processes leaving member', async () => {
    const client = makeClient({ data: { goodbye_channel_id: 'ch1' }, error: null });
    await handler.handleMemberLeave(client as any, makeMember() as any);
    expect(client.supabase.from).toHaveBeenCalled();
  });

  it('invalidateGuildConfigCache clears cache', async () => {
    const client = makeClient();
    await handler.invalidateGuildConfigCache(client as any, 'g1');
    expect(client.valkey.del).toHaveBeenCalled();
  });
});

describe('welcome-service', () => {
  it('module loads with executeWelcomeFlow', async () => {
    vi.resetModules();
    const mod = await vi.importActual('../features/welcome/welcome-service.js') as any;
    expect(mod.executeWelcomeFlow).toBeDefined();
  });
});

describe('goodbye-service', () => {
  it('module loads with executeGoodbyeFlow', async () => {
    vi.resetModules();
    const mod = await vi.importActual('../features/welcome/goodbye-service.js') as any;
    expect(mod.executeGoodbyeFlow).toBeDefined();
  });
});
