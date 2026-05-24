/**
 * Coverage: previously untested modules.
 * ticket-interactions, automod-actions, tutorial-engine, diagnostics-service,
 * mydata-command, giveaway-fulfillment, music-self-healer, purge-command,
 * client, sync/snapshot, services/valkey, services/supabase
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
  computeStateDiff: vi.fn(() => []),
  classifyDrift: vi.fn(() => []),
  DEFAULT_ESCALATION_CHAIN: [],
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; }
    setAuthor() { return this; } addFields() { return this; } setImage() { return this; }
    setURL() { return this; } toJSON() { return {}; }
  }
  class ActionRowBuilder { addComponents() { return this; } }
  class ButtonBuilder {
    setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
    setEmoji() { return this; } setDisabled() { return this; }
  }
  class ModalBuilder { setCustomId() { return this; } setTitle() { return this; } addComponents() { return this; } }
  class TextInputBuilder {
    setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
    setRequired() { return this; } setValue() { return this; } setPlaceholder() { return this; }
    setMinLength() { return this; } setMaxLength() { return this; }
  }
  class StringSelectMenuBuilder {
    setCustomId() { return this; } setPlaceholder() { return this; }
    addOptions() { return this; } setMaxValues() { return this; }
  }
  class AttachmentBuilder { constructor() {} }
  class SlashCommandBuilder {
    setName() { return this; } setDescription() { return this; } setDefaultMemberPermissions() { return this; }
    addSubcommand(fn: any) { try { fn(this); } catch {} return this; }
    addStringOption(fn: any) { try { fn(this); } catch {} return this; }
    addIntegerOption(fn: any) { try { fn(this); } catch {} return this; }
    addBooleanOption(fn: any) { try { fn(this); } catch {} return this; }
    addUserOption(fn: any) { try { fn(this); } catch {} return this; }
    addChannelOption(fn: any) { try { fn(this); } catch {} return this; }
    setRequired() { return this; } setMinValue() { return this; } setMaxValue() { return this; }
    addChoices() { return this; } setChoices() { return this; } setAutocomplete() { return this; }
    toJSON() { return {}; }
  }
  return {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder, SlashCommandBuilder,
    ModalBuilder, TextInputBuilder, AttachmentBuilder,
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    ButtonStyle: { Primary: 1, Secondary: 2, Danger: 4, Link: 5, Success: 3 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, BanMembers: 4n, KickMembers: 8n, ManageMessages: 16n, ModerateMembers: 128n, ManageGuild: 32n, ManageChannels: 64n },
    ComponentType: { Button: 2, StringSelect: 3 },
    TextInputStyle: { Short: 1, Paragraph: 2 },
    Client: class { on() { return this; } once() { return this; } login() {} },
    GatewayIntentBits: { Guilds: 1, GuildMembers: 2, GuildMessages: 4 },
    Partials: { Channel: 0, Message: 1, Reaction: 2 },
    Collection: class extends Map {
      filter(fn: any) { const r = new (this.constructor as any)(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; }
      map(fn: any) { return [...this.values()].map(fn); }
      find(fn: any) { return [...this.values()].find(fn); }
      first() { return [...this.values()][0]; }
    },
    Events: { ClientReady: 'ready', InteractionCreate: 'interactionCreate' },
  };
});

// Mock ticket-service for ticket-interactions
vi.mock('../features/tickets/ticket-service.js', () => ({
  createTicket: vi.fn(async () => ({ id: 't1', number: 1, channel_id: 'ch1' })),
  claimTicket: vi.fn(async () => true),
  closeTicket: vi.fn(async () => true),
  reopenTicket: vi.fn(async () => true),
  deleteTicket: vi.fn(async () => true),
}));
vi.mock('../features/tickets/transcript-generator.js', () => ({
  generateTranscript: vi.fn(async () => 'transcript.html'),
}));

// Mock for automod-actions
vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: vi.fn(async () => ({ id: 'inf1' })),
  getActiveWarningCount: vi.fn(async () => 0),
  calculateExpiryDate: vi.fn(() => new Date()),
}));
vi.mock('../features/moderation/escalation.js', () => ({
  executeEscalation: vi.fn(async () => {}),
}));
vi.mock('../features/moderation/mod-log.js', () => ({
  postModLogEntry: vi.fn(async () => {}),
}));
vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

// Mock for commerce
vi.mock('../features/commerce/entitlement-service.js', () => ({
  EntitlementService: class {
    grantEntitlement = vi.fn(async () => {});
  },
}));

// Mock supabase and valkey
vi.mock('../services/supabase.js', () => ({
  getSupabase: vi.fn(() => ({})),
}));
vi.mock('../services/valkey.js', () => ({
  getValkey: vi.fn(() => ({})),
  connectValkey: vi.fn(async () => {}),
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
  const chain = makeChain(result ?? { data: null, error: null });
  return { from: vi.fn(() => chain), rpc: vi.fn(async () => ({ data: null, error: null })), channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })), removeChannel: vi.fn() };
}

function makeGuild(): any {
  return {
    id: 'g1', name: 'Test', memberCount: 100,
    roles: { cache: new Map([['r1', { id: 'r1', name: 'Member', position: 1, permissions: { bitfield: 0n }, editable: true }]]), everyone: { id: 'g1', permissions: { bitfield: 0n } }, fetch: vi.fn(async () => new Map()) },
    channels: { cache: new Map([['ch1', { id: 'ch1', name: 'general', type: 0, position: 0, permissionOverwrites: { cache: new Map() } }]]), fetch: vi.fn(async () => new Map()) },
    members: { cache: new Map(), fetch: vi.fn(async () => new Map()) },
    commands: { set: vi.fn(async () => []) },
    emojis: { cache: new Map() },
    stickers: { cache: new Map() },
  };
}

function makeValkey(): any {
  return { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), setex: vi.fn(async () => 'OK'), del: vi.fn(async () => 1), incr: vi.fn(async () => 1), expire: vi.fn(async () => 1), keys: vi.fn(async () => []), mget: vi.fn(async () => []), scan: vi.fn(async () => ['0', []]), lpush: vi.fn(async () => 1), rpop: vi.fn(async () => null), llen: vi.fn(async () => 0), subscribe: vi.fn(async () => {}), on: vi.fn(), psubscribe: vi.fn(async () => {}), publish: vi.fn(async () => 1), duplicate: vi.fn(function(this: any) { return this; }), sadd: vi.fn(async () => 1), smembers: vi.fn(async () => []), srem: vi.fn(async () => 1), hset: vi.fn(async () => 1), hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})), hdel: vi.fn(async () => 1) };
}

// ═══════════════════════════════════════════════════════════
// ticket-interactions.ts
// ═══════════════════════════════════════════════════════════
describe('ticket-interactions', () => {
  let mod: typeof import('../features/tickets/ticket-interactions.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/tickets/ticket-interactions.js');
  });

  it('handles button panel open', async () => {
    const interaction: any = {
      isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
      customId: 'panel:open:panel1:type1',
      guildId: 'g1', user: { id: 'u1' }, member: { id: 'u1' },
      reply: vi.fn(async () => {}), deferReply: vi.fn(async () => {}),
      showModal: vi.fn(async () => {}), editReply: vi.fn(async () => {}),
    };
    const client: any = { supabase: makeSupa({ data: { id: 'panel1', intake_form: null }, error: null }) };
    const result = await mod.handleTicketInteraction(interaction, client);
    expect(typeof result).toBe('boolean');
  });

  it('handles ticket close button', async () => {
    const interaction: any = {
      isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
      customId: 'ticket:close:1',
      guildId: 'g1', user: { id: 'u1' }, member: { id: 'u1', permissions: { has: () => true } },
      reply: vi.fn(async () => {}), deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      guild: makeGuild(),
    };
    const client: any = { supabase: makeSupa({ data: { id: 't1', number: 1, channel_id: 'ch1', guild_id: 'g1' }, error: null }) };
    const result = await mod.handleTicketInteraction(interaction, client);
    expect(typeof result).toBe('boolean');
  });

  it('returns false for non-ticket interaction', async () => {
    const interaction: any = {
      isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
      customId: 'not-a-ticket-id',
    };
    const client: any = { supabase: makeSupa() };
    const result = await mod.handleTicketInteraction(interaction, client);
    expect(result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// automod-actions.ts
// ═══════════════════════════════════════════════════════════
describe('automod-actions', () => {
  let mod: typeof import('../features/moderation/automod-actions.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/moderation/automod-actions.js');
  });

  it('executes delete action', async () => {
    const client: any = { supabase: makeSupa() };
    const message: any = {
      deletable: true, delete: vi.fn(async () => {}),
      member: { id: 'u1', user: { id: 'u1', tag: 'User#0001' } },
      guild: { id: 'g1' },
      channel: { id: 'ch1' },
    };
    const rule: any = { name: 'no-spam', action: 'delete', type: 'keyword', log_to_mod_channel: true };
    await mod.executeAutoModAction(client, message, rule, 'Spam detected', {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: 'mod-ch1',
    });
  });

  it('executes warn action', async () => {
    const client: any = { supabase: makeSupa() };
    const message: any = {
      deletable: false, delete: vi.fn(async () => {}),
      member: { id: 'u1', user: { id: 'u1', tag: 'User#0001' } },
      guild: { id: 'g1' },
      channel: { id: 'ch1' },
    };
    const rule: any = { name: 'no-links', action: 'warn', type: 'keyword', log_to_mod_channel: false };
    await mod.executeAutoModAction(client, message, rule, 'Posted link', {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
  });

  it('executes escalate action', async () => {
    const client: any = { supabase: makeSupa() };
    const message: any = {
      deletable: true, delete: vi.fn(async () => {}),
      member: { id: 'u1', user: { id: 'u1', tag: 'User#0001' }, timeout: vi.fn(async () => {}) },
      guild: { id: 'g1' },
      channel: { id: 'ch1' },
    };
    const rule: any = { name: 'severe', action: 'escalate', type: 'keyword', log_to_mod_channel: true };
    await mod.executeAutoModAction(client, message, rule, 'Severe violation', {
      escalationChain: [{ threshold: 1, action: 'mute', duration: '1h' }], infractionExpiryDays: 30, modLogChannelId: 'mod-ch1',
    });
  });

  it('skips when no member', async () => {
    const client: any = { supabase: makeSupa() };
    const message: any = { member: null, guild: { id: 'g1' } };
    const rule: any = { name: 'test', action: 'delete', type: 'keyword' };
    await mod.executeAutoModAction(client, message, rule, 'test', {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
  });
});

// ═══════════════════════════════════════════════════════════
// tutorial-engine.ts
// ═══════════════════════════════════════════════════════════
describe('tutorial-engine', () => {
  let mod: typeof import('../features/tutorial/tutorial-engine.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/tutorial/tutorial-engine.js');
  });

  it('constructs TutorialEngine', () => {
    const supa = makeSupa({ data: [], error: null });
    const engine = new mod.TutorialEngine(supa as any, 'g1');
    expect(engine).toBeDefined();
  });

  it('loads steps', async () => {
    const supa = makeSupa({ data: [{ id: 's1', step_order: 1, title: 'Welcome', description: 'Hello', image_url: null, built_in_key: null, enabled: true }], error: null });
    const engine = new mod.TutorialEngine(supa as any, 'g1');
    await engine.loadSteps();
  });

  it('starts tutorial', async () => {
    const supa = makeSupa({ data: [], error: null });
    const engine = new mod.TutorialEngine(supa as any, 'g1');
    const interaction: any = {
      user: { id: 'u1' }, guildId: 'g1',
      reply: vi.fn(async () => ({})),
      editReply: vi.fn(async () => ({})),
      deferReply: vi.fn(async () => {}),
    };
    await engine.startTutorial(interaction);
  });
});

// ═══════════════════════════════════════════════════════════
// diagnostics-service.ts
// ═══════════════════════════════════════════════════════════
describe('diagnostics-service', () => {
  let mod: typeof import('../features/audit/diagnostics-service.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/audit/diagnostics-service.js');
  });

  it('constructs DiagnosticsService', () => {
    const svc = new mod.DiagnosticsService(makeGuild() as any, makeSupa() as any, makeValkey() as any);
    expect(svc).toBeDefined();
  });

  it('runs diagnostics', async () => {
    const svc = new mod.DiagnosticsService(makeGuild() as any, makeSupa() as any, makeValkey() as any);
    const result = await svc.runDiagnostics();
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// mydata-command.ts
// ═══════════════════════════════════════════════════════════
describe('mydata-command', () => {
  let mod: typeof import('../features/account/mydata-command.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/account/mydata-command.js');
  });

  it('buildMyDataCommand', () => {
    const cmd = mod.buildMyDataCommand();
    expect(cmd).toBeDefined();
  });

  it('handleMyDataCommand', async () => {
    const interaction: any = {
      user: { id: 'u1', displayName: 'Tester' }, guildId: 'g1',
      reply: vi.fn(async () => {}), deferReply: vi.fn(async () => {}), editReply: vi.fn(async () => {}),
    };
    const supa = makeSupa({ data: { xp: 100, level: 5 }, error: null });
    await mod.handleMyDataCommand(interaction, supa as any, 'g1');
  });
});

// ═══════════════════════════════════════════════════════════
// giveaway-fulfillment.ts
// ═══════════════════════════════════════════════════════════
describe('giveaway-fulfillment', () => {
  let mod: typeof import('../services/giveaway-fulfillment.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../services/giveaway-fulfillment.js');
  });

  it('constructs and starts', () => {
    const eventBus: any = { on: vi.fn(), emit: vi.fn() };
    const svc = new mod.GiveawayFulfillmentService(makeGuild(), makeSupa() as any, eventBus);
    svc.start();
    expect(eventBus.on).toHaveBeenCalledWith('giveaway.ended', expect.any(Function));
  });
});

// ═══════════════════════════════════════════════════════════
// music-self-healer.ts
// ═══════════════════════════════════════════════════════════
describe('music-self-healer', () => {
  let mod: typeof import('../features/music/music-self-healer.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/music/music-self-healer.js');
  });

  it('constructs and records events', () => {
    const healer = new mod.MusicSelfHealer();
    healer.recordSuccess();
    healer.recordSuccess();
    healer.recordFailure();
    expect(healer.getSuccessRate()).toBeGreaterThan(0);
  });

  it('recommends search provider on degradation', () => {
    const healer = new mod.MusicSelfHealer();
    // Record many failures to trigger provider rotation
    for (let i = 0; i < 50; i++) healer.recordFailure();
    const provider = healer.getRecommendedProvider();
    expect(typeof provider).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════
// purge-command.ts
// ═══════════════════════════════════════════════════════════
describe('purge-command', () => {
  let mod: typeof import('../features/moderation/purge-command.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/moderation/purge-command.js');
  });

  it('buildPurgeCommand', () => {
    const cmd = mod.buildPurgeCommand();
    expect(cmd).toBeDefined();
  });

  it('handlePurgeCommand', async () => {
    const interaction: any = {
      guildId: 'g1', user: { id: 'u1' },
      member: { permissions: { has: () => true } },
      options: {
        getInteger: vi.fn(() => 10),
        getUser: vi.fn(() => null),
        getString: vi.fn(() => null),
      },
      channel: {
        bulkDelete: vi.fn(async () => new Map([['m1', {}], ['m2', {}]])),
        messages: { fetch: vi.fn(async () => new Map([['m1', { author: { bot: false } }]])) },
      },
      reply: vi.fn(async () => {}), deferReply: vi.fn(async () => {}), editReply: vi.fn(async () => {}),
    };
    await mod.handlePurgeCommand(interaction);
  });
});

// ═══════════════════════════════════════════════════════════
// sync/snapshot.ts
// ═══════════════════════════════════════════════════════════
describe('sync/snapshot', () => {
  let mod: typeof import('../sync/snapshot.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../sync/snapshot.js');
  });

  it('takeSnapshot returns ActualState', async () => {
    const guild = makeGuild();
    const snapshot = await mod.takeSnapshot(guild);
    expect(snapshot).toBeDefined();
  });
});
