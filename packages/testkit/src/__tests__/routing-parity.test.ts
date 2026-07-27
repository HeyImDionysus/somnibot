/**
 * Routing parity — proves the testkit's synthetic interaction builders drive the
 * REAL production dispatcher down the SAME branches a genuine Discord interaction
 * would, WITHOUT a live stack (no docker, no DB, no gateway).
 *
 * How it works:
 *   - We import the REAL exported `handleInteraction` from @somnibot/bot's compiled
 *     dispatcher, plus @somnibot/bot's compiled `handler.js` purely for its
 *     module-load side effect of populating the slash command-registry
 *     (registerCommand('help'|'setup'|'warn'|…)). Without that import the registry
 *     is empty and registry-routed commands would not dispatch.
 *   - We build a stub SomniClient (mirroring handler-routing.test.ts's makeClient)
 *     with vi.fn managers so the real feature handlers don't crash.
 *   - For a representative interaction of every kind, we build it with a testkit
 *     builder and assert it is ROUTED — observed via the CapturedResponse being
 *     written, a manager method being called, an eventBus emit, or (matching the
 *     handler-routing precedent) the correct type-guard being consulted.
 *
 * assertLoopbackAllowed() is bypassed for the routing assertions by calling
 * handleInteraction directly. A separate block sets the guard env and exercises
 * the guarded createInteractionInjector/inject ingress end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Populate the slash command-registry via handler.js's module-load side effects.
import '@somnibot/bot/dist/events/handler.js';
// The REAL production dispatcher under test.
import { handleInteraction } from '@somnibot/bot/dist/events/interaction-handler.js';

import {
  buildSlashInteraction,
  buildButtonInteraction,
  buildSelectInteraction,
  buildModalInteraction,
  buildAutocompleteInteraction,
  buildUserContextMenuInteraction,
  buildMessageContextMenuInteraction,
} from '../interaction-builders.js';
import {
  createInteractionInjector,
  mintCapabilityToken,
  LOOPBACK_E2E_CONFIRMATION,
} from '../index.js';

// ── Stub SomniClient (trimmed port of handler-routing.test.ts's makeClient) ──

interface StubSetup {
  client: any;
  managers: Map<string, any>;
}

function makeClient(opts: { storeEnabled?: boolean } = {}): StubSetup {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range', 'ilike', 'filter']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({
    data: { store_enabled: opts.storeEnabled ?? true },
    error: null,
  });
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });

  const managers = new Map<string, any>([
    ['economy', {
      loadConfig: vi.fn().mockResolvedValue({ currency_emoji: '💰', currency_name: 'coins' }),
      claimTimedReward: vi.fn().mockResolvedValue({ success: true, message: 'You earned 500!' }),
      getOrCreateWallet: vi.fn().mockResolvedValue({ wallet: 1000, bank: 500, bank_max: 10000 }),
      getInventory: vi.fn().mockResolvedValue([]),
      getShopItems: vi.fn().mockResolvedValue([]),
    }],
    ['giveawayManager', { handleEntry: vi.fn().mockResolvedValue(true) }],
    ['musicPlayer', {
      handleButton: vi.fn().mockResolvedValue({ message: 'Paused' }),
      queueManager: { getQueue: vi.fn().mockResolvedValue(null) },
    }],
    ['trivia', { handleAnswer: vi.fn().mockResolvedValue(undefined) }],
    ['polls', { handlePollVote: vi.fn().mockResolvedValue(undefined) }],
    ['tempChannelManager', {}],
    ['adventures', {}],
  ]);

  const ctx = {
    guild: { id: 'guild-1', name: 'Test', memberCount: 100 },
    guildId: 'guild-1',
    supabase: { from: vi.fn(() => chain) },
    getManager: <T>(key: string): T | undefined => managers.get(key) as T | undefined,
  };

  const client: any = {
    guildId: 'guild-1',
    user: { id: 'bot-1', tag: 'Bot#0001' },
    supabase: { from: vi.fn(() => chain) },
    valkey: { ttl: vi.fn().mockResolvedValue(-2) },
    eventBus: { emit: vi.fn() },
    shoukaku: { nodes: new Map(), players: new Map() },
    setupVerificationMode: false,
    router: {
      getContext: vi.fn(() => ctx),
      getContextSync: vi.fn(() => ctx),
      all: vi.fn(() => [ctx]),
    },
  };

  return { client, managers };
}

describe('routing parity: synthetic builders ↔ real handleInteraction', () => {
  let client: any;
  let managers: Map<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = makeClient();
    client = setup.client;
    managers = setup.managers;
  });

  // ── Slash commands ──────────────────────────────────────────────────

  it('routes a registry slash command (/help)', async () => {
    const interaction = buildSlashInteraction({ commandName: 'help', client });
    await handleInteraction(interaction as any, client);
    // handleHelpCommand replies unconditionally.
    expect(interaction.captured.count).toBeGreaterThan(0);
    expect(interaction.captured.has('reply')).toBe(true);
  });

  it('routes a registry slash command (/setup)', async () => {
    const interaction = buildSlashInteraction({ commandName: 'setup', client });
    await handleInteraction(interaction as any, client);
    // handleSetupCommand replies or defers.
    expect(interaction.captured.count).toBeGreaterThan(0);
  });

  it('routes an inline feature-gated slash (/voice) — disabled reply when no manager', async () => {
    managers.delete('tempChannelManager');
    const interaction = buildSlashInteraction({ commandName: 'voice', client });
    await handleInteraction(interaction as any, client);
    const reply = interaction.captured.find('reply');
    expect(reply?.payload).toMatchObject({ content: expect.stringContaining('not enabled') });
  });

  it('routes an inline feature-gated slash (/balance) — disabled reply when no manager', async () => {
    managers.delete('economy');
    const interaction = buildSlashInteraction({ commandName: 'balance', client });
    await handleInteraction(interaction as any, client);
    const reply = interaction.captured.find('reply');
    expect(reply?.payload).toMatchObject({ content: expect.stringContaining('not enabled') });
  });

  it('drives slash options through the real getters (options map)', async () => {
    managers.delete('economy');
    const interaction = buildSlashInteraction({
      commandName: 'balance',
      options: { user: { id: 'u2' }, amount: 50 },
      client,
    });
    expect(interaction.options.getInteger('amount')).toBe(50);
    expect(interaction.options.getString('missing')).toBeNull();
    expect(() => interaction.options.getString('missing', true)).toThrow();
    await handleInteraction(interaction as any, client);
    expect(interaction.captured.count).toBeGreaterThan(0);
  });

  // ── Gated slash-command families (absent-manager / disabled probe) ───
  // Coverage per COMMAND FAMILY, not just per interaction kind. Each case drives
  // the family with its manager absent (or the store DB-flag disabled) so the
  // handler takes its deterministic "not enabled / not available / disabled"
  // branch. That reply is unique to the family's own branch: since each command
  // name matches no other branch, deleting the family's routing drops the reply
  // and fails the case. Fast + in-process (no docker/DB).
  const gatedSlashProbes: Array<{
    command: string;
    deleteManager?: string;
    storeDisabled?: boolean;
    expected: string;
    /** This branch replies with a branded embed rather than plain content. */
    asEmbed?: boolean;
  }> = [
    { command: 'voice', deleteManager: 'tempChannelManager', expected: 'not enabled' },
    { command: 'giveaway', deleteManager: 'giveawayManager', expected: 'not enabled' },
    // Music enabled but the player manager is missing → the infra-gap branch.
    // Both music declines are branded embeds now (the disabled one says
    // "switched off"; this one says the audio service is not reachable).
    { command: 'play', deleteManager: 'musicPlayer', expected: 'not reachable', asEmbed: true },
    { command: 'balance', deleteManager: 'economy', expected: 'not enabled' },
    { command: 'trivia', deleteManager: 'trivia', expected: 'not enabled' },
    { command: 'poll', deleteManager: 'polls', expected: 'not enabled' },
    { command: 'store', storeDisabled: true, expected: 'disabled' },
    { command: 'heist', expected: 'not enabled' },
    { command: 'market', expected: 'not enabled' },
    { command: 'pet', expected: 'not enabled' },
    { command: 'quests', expected: 'not enabled' },
    { command: 'lottery', expected: 'not enabled' },
    { command: 'coinflip', expected: 'not enabled' },
    { command: 'hunt', expected: 'not enabled' },
    { command: 'craft', expected: 'not enabled' },
    { command: 'farm', expected: 'not enabled' },
    { command: 'fish', expected: 'not enabled' },
    { command: 'profile', expected: 'not available' },
    { command: 'badges', expected: 'not enabled' },
  ];

  it.each(gatedSlashProbes)(
    'routes gated slash /$command to its own branch (deterministic "$expected" reply)',
    async ({ command, deleteManager, storeDisabled, expected, asEmbed }) => {
      const setup = makeClient({ storeEnabled: !storeDisabled });
      if (deleteManager) setup.managers.delete(deleteManager);
      const interaction = buildSlashInteraction({ commandName: command, client: setup.client });
      await handleInteraction(interaction as any, setup.client);
      const reply = interaction.captured.find('reply');
      if (asEmbed) {
        const embeds = (reply?.payload as { embeds?: Array<{ data?: { description?: string } }> })?.embeds;
        expect(embeds).toHaveLength(1);
        expect(String(embeds?.[0]?.data?.description)).toContain(expected);
        return;
      }
      expect(reply?.payload).toMatchObject({ content: expect.stringContaining(expected) });
    },
  );

  // ── Buttons ─────────────────────────────────────────────────────────

  it('routes a setup: button to handleSetupButton (owner-gated reply)', async () => {
    const interaction = buildButtonInteraction({ customId: 'setup:page:1', client });
    await handleInteraction(interaction as any, client);
    // handleSetupButton owner-gates FIRST: the synthetic guild has no ownerId, so
    // the user is not the owner and it replies with its distinctive owner-only
    // message. No other button branch produces that reply, so deleting the
    // `setup:` button branch (line ~148 of interaction-handler.ts) drops it and
    // fails this assertion.
    const reply = interaction.captured.find('reply');
    expect(reply?.payload).toMatchObject({ content: expect.stringContaining('Only the server owner can use setup') });
  });

  it('routes a store:buy: button (disabled → deterministic reply)', async () => {
    const setup = makeClient({ storeEnabled: false });
    const interaction = buildButtonInteraction({ customId: 'store:buy:product-1', client: setup.client });
    await handleInteraction(interaction as any, setup.client);
    const reply = interaction.captured.find('reply');
    expect(reply?.payload).toMatchObject({ content: expect.stringContaining('disabled') });
  });

  it('routes a music: button to the music manager', async () => {
    const interaction = buildButtonInteraction({ customId: 'music:pause', client });
    await handleInteraction(interaction as any, client);
    expect(managers.get('musicPlayer').handleButton).toHaveBeenCalled();
    expect(interaction.captured.has('reply')).toBe(true);
  });

  it('routes an econ_ button to the economy manager', async () => {
    const interaction = buildButtonInteraction({ customId: 'econ_daily', client });
    await handleInteraction(interaction as any, client);
    expect(managers.get('economy').claimTimedReward).toHaveBeenCalled();
    expect(interaction.captured.has('deferReply')).toBe(true);
  });

  it('routes an econ_balance button to the economy manager', async () => {
    const interaction = buildButtonInteraction({ customId: 'econ_balance', client });
    await handleInteraction(interaction as any, client);
    expect(managers.get('economy').getOrCreateWallet).toHaveBeenCalled();
    expect(interaction.captured.has('reply')).toBe(true);
  });

  it('routes a giveaway_enter: button to the giveaway manager', async () => {
    const interaction = buildButtonInteraction({ customId: 'giveaway_enter:123', client });
    await handleInteraction(interaction as any, client);
    expect(managers.get('giveawayManager').handleEntry).toHaveBeenCalled();
  });

  it('routes a trivia: button to the trivia manager', async () => {
    const interaction = buildButtonInteraction({ customId: 'trivia:answer:A', client });
    await handleInteraction(interaction as any, client);
    expect(managers.get('trivia').handleAnswer).toHaveBeenCalled();
  });

  it('routes a poll: button to the polls manager', async () => {
    const interaction = buildButtonInteraction({ customId: 'poll:vote:1', client });
    await handleInteraction(interaction as any, client);
    expect(managers.get('polls').handlePollVote).toHaveBeenCalled();
  });

  it('routes a btnrole: button (branch consumes it — no button.clicked fallthrough)', async () => {
    const interaction = buildButtonInteraction({ customId: 'btnrole:role-1', client });
    await handleInteraction(interaction as any, client);
    // The btnrole branch consumes the button: handleButtonRoleInteraction returns
    // true, so the generic fall-through `client.eventBus.emit('button.clicked', …)`
    // must NOT fire. If the `btnrole:` branch were deleted, this button would fall
    // through to that emit — the observable that makes this assertion non-vacuous.
    expect(client.eventBus.emit).not.toHaveBeenCalledWith('button.clicked', expect.anything(), expect.anything());
    // And the handler produced its own consumed reply rather than no-op'ing.
    expect(interaction.captured.has('reply')).toBe(true);
  });

  it('routes an adventure: button (branch consumes it — no button.clicked fallthrough)', async () => {
    const interaction = buildButtonInteraction({ customId: 'adventure:sess-1:0', client });
    await handleInteraction(interaction as any, client);
    // handleAdventureButton consumes the button (no adventure manager registered →
    // it replies "module is not loaded") and returns, so the fall-through
    // `button.clicked` emit must NOT fire. Deleting the `adventure:` branch would
    // let it fall through to that emit — proving the branch is load-bearing.
    expect(client.eventBus.emit).not.toHaveBeenCalledWith('button.clicked', expect.anything(), expect.anything());
    expect(interaction.captured.has('reply')).toBe(true);
  });

  it('emits button.clicked for an unhandled button', async () => {
    const interaction = buildButtonInteraction({ customId: 'totally:unknown', client });
    await handleInteraction(interaction as any, client);
    expect(client.eventBus.emit).toHaveBeenCalledWith('button.clicked', expect.any(String), expect.any(Object));
  });

  // ── Select menus ────────────────────────────────────────────────────

  it('routes a help:category select menu', async () => {
    const interaction = buildSelectInteraction({ customId: 'help:category', values: ['moderation'], client });
    await handleInteraction(interaction as any, client);
    // handleHelpCategorySelect reads interaction.values[0] and — with no matching
    // category in this stub — replies with its unique "Category not found" message.
    // That message is emitted by no other branch, so it deterministically proves
    // the select routed to the help-category handler.
    const reply = interaction.captured.find('reply');
    expect(reply?.payload).toMatchObject({ content: expect.stringContaining('Category not found') });
    expect(interaction.values).toEqual(['moderation']);
  });

  it('routes a setup:reconfigure select to handleReconfigureSelect (owner-gated reply)', async () => {
    const interaction = buildSelectInteraction({ customId: 'setup:reconfigure', values: ['economy'], client });
    await handleInteraction(interaction as any, client);
    // handleReconfigureSelect owner-gates first: the synthetic guild has no
    // ownerId, so it replies with its distinctive owner-only message — a response
    // no other select branch produces. Deleting the `setup:reconfigure` branch
    // leaves the select unrouted (no reply), failing this assertion.
    const reply = interaction.captured.find('reply');
    expect(reply?.payload).toMatchObject({ content: expect.stringContaining('Only the server owner can use setup') });
  });

  // ── Modal ───────────────────────────────────────────────────────────

  it('routes a setup:modal: submission to handleSetupModal (owner-gated reply)', async () => {
    const interaction = buildModalInteraction({
      customId: 'setup:modal:page1',
      fields: { field1: 'value1' },
      client,
    });
    await handleInteraction(interaction as any, client);
    // handleSetupModal owner-gates first and replies with its distinctive
    // owner-only message. The generic handleModalSubmit fallthrough produces no
    // such reply, so deleting the `setup:modal:` branch (routing this to the
    // fallthrough instead) fails this assertion.
    const reply = interaction.captured.find('reply');
    expect(reply?.payload).toMatchObject({ content: expect.stringContaining('Only the server owner can use setup') });
    // The fields accessor the real handler uses is wired up.
    expect(interaction.fields.getTextInputValue('field1')).toBe('value1');
  });

  // ── Autocomplete ────────────────────────────────────────────────────

  it('routes an autocomplete interaction and captures respond()', async () => {
    const interaction = buildAutocompleteInteraction({
      commandName: 'play',
      focused: { name: 'query', value: 'x' },
      client,
    });
    // discord.js's AutocompleteInteraction is NOT repliable — it has no reply(),
    // only respond(). The builder must mirror that so the dispatcher's error path
    // (which checks isRepliable() before replying) behaves faithfully.
    expect(interaction.isRepliable()).toBe(false);
    await handleInteraction(interaction as any, client);
    expect(interaction.captured.has('respond')).toBe(true);
  });

  // ── Context menus ───────────────────────────────────────────────────

  it('routes a user context menu (View Profile)', async () => {
    const interaction = buildUserContextMenuInteraction({ commandName: 'View Profile', targetId: 'u9', client });
    await handleInteraction(interaction as any, client);
    // handleViewProfile defers, gathers data, then edits the deferred reply.
    expect(interaction.captured.has('deferReply')).toBe(true);
    expect(interaction.captured.has('editReply')).toBe(true);
  });

  it('routes a message context menu (Report Message)', async () => {
    const interaction = buildMessageContextMenuInteraction({ commandName: 'Report Message', targetId: 'm9', client });
    await handleInteraction(interaction as any, client);
    // handleReportMessage shows a modal — a response only this handler produces.
    expect(interaction.captured.has('showModal')).toBe(true);
  });

  // ── Guild/DM early returns ──────────────────────────────────────────

  it('short-circuits an interaction with no guild', async () => {
    const interaction = buildButtonInteraction({ customId: 'econ_daily', client });
    (interaction as any).guild = null;
    await handleInteraction(interaction as any, client);
    expect(managers.get('economy').claimTimedReward).not.toHaveBeenCalled();
    expect(interaction.captured.count).toBe(0);
  });
});

// ── Guarded ingress: createInteractionInjector + inject ──────────────────

describe('guarded injector ingress (real dispatcher via inject.ts)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Configure a disposable-rig environment so assertLoopbackAllowed() passes.
    process.env.NODE_ENV = 'test';
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.DISCORD_GUILD_ID = '111111111111111111';
    process.env.SOMNIBOT_E2E_DISPOSABLE_GUILD_ID = '111111111111111111';
    process.env.SOMNIBOT_LOOPBACK_E2E_CONFIRMATION = LOOPBACK_E2E_CONFIRMATION;
    process.env.PAYPAL_ENV = 'sandbox';
  });

  // Restore the process environment after every test in this block.
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('injects a synthetic interaction through the real dispatcher and returns the recorder', async () => {
    const { client, managers } = makeClient();
    managers.delete('economy');
    const token = mintCapabilityToken();
    const injector = createInteractionInjector(client, { authToken: token });
    const interaction = buildSlashInteraction({ commandName: 'balance', client });

    const captured = await injector.inject(interaction, { authToken: token });

    expect(captured).toBe(interaction.captured);
    const reply = captured.find('reply');
    expect(reply?.payload).toMatchObject({ content: expect.stringContaining('not enabled') });
  });

  it('rejects an inject with a mismatched capability token', async () => {
    const { client } = makeClient();
    const token = mintCapabilityToken();
    const wrong = mintCapabilityToken();
    const injector = createInteractionInjector(client, { authToken: token });
    const interaction = buildButtonInteraction({ customId: 'econ_daily', client });

    await expect(injector.inject(interaction, { authToken: wrong })).rejects.toThrow(/capability token mismatch/);
  });

  it('refuses to construct an injector outside a disposable rig', () => {
    delete process.env.SOMNIBOT_LOOPBACK_E2E_CONFIRMATION;
    const { client } = makeClient();
    expect(() => createInteractionInjector(client, { authToken: mintCapabilityToken() })).toThrow();
  });
});
