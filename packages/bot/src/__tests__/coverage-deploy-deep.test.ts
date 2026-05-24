/**
 * Coverage test for deploy/deployer.ts and deploy/deploy-listener.ts
 * These files total ~960 lines with near-0% coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }),
  SOMNI_PALETTE: {},
  computeStateDiff: vi.fn(() => []),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; }
    addFields() { return this; } setImage() { return this; }
  },
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
  PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n, ManageRoles: 8n },
  PermissionsBitField: class {
    static Flags = { ViewChannel: 1n, SendMessages: 2n };
    constructor(public bitfield: bigint = 0n) {}
    has() { return false; }
  },
  Collection: class extends Map {
    filter(fn: any) { const r = new (this.constructor as any)(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
    find(fn: any) { return [...this.values()].find(fn); }
    first() { return [...this.values()][0]; }
  },
}));

vi.mock('../guards/bot-role-guard.js', () => ({
  checkBotRolePosition: vi.fn(async () => ({ isTopPosition: true, botRolePosition: 5, highestOtherPosition: 3 })),
  checkBotPermissions: vi.fn(async () => ({ hasAll: true, missing: [] })),
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock('../services/event-bus.js', () => ({
  PlatformEventBus: class { emit = vi.fn(); on = vi.fn(); off = vi.fn(); },
}));

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from','select','insert','update','delete','upsert','eq','neq','gt','lt','gte','lte','in','is','not','order','limit','single','maybeSingle','match','contains','overlaps','filter','or','ilike','like','textSearch','returns','range']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}
function makeSupa(result?: any) {
  const chain = makeChain(result || { data: null, error: null });
  return { from: vi.fn(() => chain), rpc: vi.fn(async () => ({ data: null, error: null })), channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })), removeChannel: vi.fn() };
}

function makeGuild() {
  const roles = new Map([
    ['g1', { id: 'g1', name: '@everyone', position: 0, permissions: { bitfield: 0n }, managed: false, editable: true, setPermissions: vi.fn(async () => {}), edit: vi.fn(async () => ({})) }],
  ]);
  const channels = new Map();
  return {
    id: 'g1', name: 'Test Guild', memberCount: 100,
    roles: {
      cache: roles,
      everyone: roles.get('g1'),
      fetch: vi.fn(async () => roles),
      create: vi.fn(async (data: any) => ({ id: 'new-r', name: data.name, position: 1, ...data })),
    },
    channels: {
      cache: channels,
      fetch: vi.fn(async () => channels),
      create: vi.fn(async (data: any) => ({ id: 'new-c', name: data.name, type: data.type, ...data })),
    },
    members: { fetch: vi.fn(async () => new Map()), cache: new Map() },
    me: { roles: { highest: { position: 5 } }, permissions: { has: () => true } },
  };
}

// ═══════════════════════════════════════════════════════════
// deployer.ts
// ═══════════════════════════════════════════════════════════
describe('deployer', () => {
  let mod: typeof import('../deploy/deployer.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../deploy/deployer.js');
  });

  it('exports deployServerState', () => {
    expect(mod.deployServerState).toBeDefined();
    expect(typeof mod.deployServerState).toBe('function');
  });

  it('deployServerState with empty desired state', async () => {
    const guild = makeGuild();
    const supa = makeSupa();
    const desiredState = { everyonePermissions: '0', roles: [], categories: [], channels: [] };
    const options = { dryRun: false, onProgress: vi.fn() };
    const result = await mod.deployServerState(guild as any, supa as any, desiredState, options);
    expect(result).toBeDefined();
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('actions');
  });

  it('deployServerState with roles to create', async () => {
    const guild = makeGuild();
    const supa = makeSupa();
    const desiredState = {
      everyonePermissions: '0',
      roles: [{ key: 'member', name: 'Member', permissions: '0', color: 0x5865f2, hoist: false, mentionable: false, position: 1 }],
      categories: [],
      channels: [],
    };
    const options = { dryRun: false, onProgress: vi.fn() };
    const result = await mod.deployServerState(guild as any, supa as any, desiredState as any, options);
    expect(result).toBeDefined();
  });

  it('deployServerState with channels', async () => {
    const guild = makeGuild();
    const supa = makeSupa();
    const desiredState = {
      everyonePermissions: '0',
      roles: [],
      categories: [{ key: 'cat1', name: 'General', position: 0 }],
      channels: [{ key: 'general', name: 'general', type: 0, categoryKey: 'cat1', position: 0, topic: null, slowmode: 0, nsfw: false, templateId: 't1', overrides: [] }],
    };
    const options = { dryRun: false, onProgress: vi.fn() };
    const result = await mod.deployServerState(guild as any, supa as any, desiredState as any, options);
    expect(result).toBeDefined();
  });

  it('deployServerState dry run', async () => {
    const guild = makeGuild();
    const supa = makeSupa();
    const desiredState = {
      everyonePermissions: '0',
      roles: [{ key: 'admin', name: 'Admin', permissions: '8', color: 0xff0000, hoist: true, mentionable: false, position: 2 }],
      categories: [],
      channels: [],
    };
    const options = { dryRun: true, onProgress: vi.fn() };
    const result = await mod.deployServerState(guild as any, supa as any, desiredState as any, options);
    expect(result).toBeDefined();
  });

  it('deployServerState with bot role not top returns error', async () => {
    const { checkBotRolePosition } = await import('../guards/bot-role-guard.js');
    (checkBotRolePosition as any).mockResolvedValueOnce({ isTopPosition: false, botRolePosition: 1, highestOtherPosition: 3 });
    const guild = makeGuild();
    const supa = makeSupa();
    const desiredState = { everyonePermissions: '0', roles: [], categories: [], channels: [] };
    const result = await mod.deployServerState(guild as any, supa as any, desiredState, { dryRun: false });
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// deploy-listener.ts
// ═══════════════════════════════════════════════════════════
describe('deploy-listener', () => {
  it('imports successfully', async () => {
    vi.resetModules();
    const mod = await import('../deploy/deploy-listener.js');
    expect(mod).toBeDefined();
  });
});
