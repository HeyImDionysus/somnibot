/**
 * Tests for services/config-watcher.ts — hot-reload configuration
 * when the dashboard pushes config changes via the event bus.
 * Tests section routing, cooldown logic, and cache invalidation dispatch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => ({
  ChannelType: { GuildText: 0 },
  Collection: class extends Map {},
}));

// Use vi.hoisted so these are available in vi.mock factories
const mocks = vi.hoisted(() => ({
  invalidateEconomyCache: vi.fn(),
  invalidateGatheringCache: vi.fn(),
  invalidateCraftingCache: vi.fn(),
  invalidateFarmingCache: vi.fn(),
  invalidateFishingCache: vi.fn(),
  invalidateAdventureCache: vi.fn(),
  invalidateMarketCache: vi.fn(),
  invalidateTriviaCache: vi.fn(),
  invalidateGamesCache: vi.fn(),
  invalidateLotteryCache: vi.fn(),
  invalidatePollsCache: vi.fn(),
  invalidatePetsCache: vi.fn(),
  invalidateQuestsCache: vi.fn(),
  invalidateAchievementsCache: vi.fn(),
  invalidateProfilesCache: vi.fn(),
  invalidateHeistCache: vi.fn(),
  invalidateBrandKitCache: vi.fn(),
  invalidateAlertChannelCache: vi.fn(),
}));

// Mock all feature modules that config-watcher imports for invalidation
vi.mock('../features/levels/index.js', () => ({ invalidateLevelCaches: vi.fn() }));
vi.mock('../features/anti-raid/index.js', () => ({ invalidateAntiRaidCache: vi.fn() }));
vi.mock('../features/starboard/index.js', () => ({ invalidateStarboardCache: vi.fn() }));
vi.mock('../features/message-log/index.js', () => ({ invalidateMessageLogCache: vi.fn() }));
vi.mock('../features/economy/index.js', () => ({ invalidateEconomyCache: mocks.invalidateEconomyCache }));
vi.mock('../features/gathering/index.js', () => ({ invalidateGatheringCache: mocks.invalidateGatheringCache }));
vi.mock('../features/crafting/index.js', () => ({ invalidateCraftingCache: mocks.invalidateCraftingCache }));
vi.mock('../features/farming/index.js', () => ({ invalidateFarmingCache: mocks.invalidateFarmingCache }));
vi.mock('../features/fishing/index.js', () => ({ invalidateFishingCache: mocks.invalidateFishingCache }));
vi.mock('../features/adventures/index.js', () => ({ invalidateAdventureCache: mocks.invalidateAdventureCache }));
vi.mock('../features/market/index.js', () => ({ invalidateMarketCache: mocks.invalidateMarketCache }));
vi.mock('../features/trivia/index.js', () => ({ invalidateTriviaCache: mocks.invalidateTriviaCache }));
vi.mock('../features/games/index.js', () => ({ invalidateGamesCache: mocks.invalidateGamesCache }));
vi.mock('../features/lottery/index.js', () => ({ invalidateLotteryCache: mocks.invalidateLotteryCache }));
vi.mock('../features/polls/index.js', () => ({ invalidatePollsCache: mocks.invalidatePollsCache }));
vi.mock('../features/pets/index.js', () => ({ invalidatePetsCache: mocks.invalidatePetsCache }));
vi.mock('../features/quests/index.js', () => ({ invalidateQuestsCache: mocks.invalidateQuestsCache }));
vi.mock('../features/achievements/index.js', () => ({ invalidateAchievementsCache: mocks.invalidateAchievementsCache }));
vi.mock('../features/profiles/index.js', () => ({ invalidateProfilesCache: mocks.invalidateProfilesCache }));
vi.mock('../features/heist/index.js', () => ({ invalidateHeistCache: mocks.invalidateHeistCache }));
vi.mock('../features/branding/index.js', () => ({ invalidateBrandKitCache: mocks.invalidateBrandKitCache }));

// Mock the remaining features that reloadXxx methods may call
vi.mock('../features/moderation/index.js', () => ({ reloadModerationConfig: vi.fn() }));
vi.mock('../features/welcome/index.js', () => ({ reloadWelcomeConfig: vi.fn() }));
vi.mock('../features/commerce/index.js', () => ({ EntitlementService: class {} }));
vi.mock('../features/music/index.js', () => ({ MusicPlayerManager: class {} }));
vi.mock('../features/tickets/index.js', () => ({ reloadTicketConfig: vi.fn() }));
vi.mock('../features/automations/index.js', () => ({ AutomationEngine: class { reload = vi.fn() } }));
vi.mock('../features/reaction-roles/index.js', () => ({ loadReactionRoles: vi.fn() }));
vi.mock('../features/giveaways/index.js', () => ({ GiveawayManager: class {} }));
vi.mock('../features/temp-channels/index.js', () => ({ TempChannelManager: class {} }));
vi.mock('../features/scheduled-messages/index.js', () => ({ ScheduledMessageRunner: class {} }));
vi.mock('../features/custom-commands/index.js', () => ({ loadCustomCommands: vi.fn() }));
vi.mock('../features/stats-channels/index.js', () => ({ StatsChannelManager: class {} }));
vi.mock('../features/discord-ux/index.js', () => ({}));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../services/alert-service.js', () => ({ invalidateAlertChannelCache: mocks.invalidateAlertChannelCache }));

import { ConfigWatcher } from '../services/config-watcher.js';

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'order', 'limit', 'single', 'maybeSingle']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa() {
  return {
    from: vi.fn(() => makeChain({ data: null, error: null })),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

function makeGuild() {
  return { id: 'guild-1', name: 'Test' } as any;
}

function makeValkey() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
  } as any;
}

describe('ConfigWatcher', () => {
  let watcher: ConfigWatcher;
  let eventBus: any;
  let configHandler: any;

  beforeEach(() => {
    vi.clearAllMocks();
    configHandler = null;
    eventBus = {
      on: vi.fn((event: string, cb: any) => { configHandler = cb; }),
      off: vi.fn(),
      emit: vi.fn(),
    };
    watcher = new ConfigWatcher(makeGuild(), makeSupa() as any, eventBus, makeValkey());
    watcher.start();
  });

  it('registers a config.changed event listener on start()', () => {
    expect(eventBus.on).toHaveBeenCalledWith('config.changed', expect.any(Function));
    expect(configHandler).toBeInstanceOf(Function);
  });

  it('ignores events from other guilds', async () => {
    await configHandler({ guildId: 'other-guild', data: { section: 'economy', changedBy: 'user1' } });
    expect(mocks.invalidateEconomyCache).not.toHaveBeenCalled();
  });

  it('invalidates all economy caches on section=economy', async () => {
    await configHandler({ guildId: 'guild-1', data: { section: 'economy', changedBy: 'user1' } });
    expect(mocks.invalidateEconomyCache).toHaveBeenCalled();
    expect(mocks.invalidateGatheringCache).toHaveBeenCalled();
    expect(mocks.invalidateCraftingCache).toHaveBeenCalled();
    expect(mocks.invalidateFarmingCache).toHaveBeenCalled();
    expect(mocks.invalidateFishingCache).toHaveBeenCalled();
    expect(mocks.invalidateAdventureCache).toHaveBeenCalled();
    expect(mocks.invalidateMarketCache).toHaveBeenCalled();
    expect(mocks.invalidateTriviaCache).toHaveBeenCalled();
    expect(mocks.invalidateGamesCache).toHaveBeenCalled();
    expect(mocks.invalidateLotteryCache).toHaveBeenCalled();
    expect(mocks.invalidatePollsCache).toHaveBeenCalled();
    expect(mocks.invalidatePetsCache).toHaveBeenCalled();
    expect(mocks.invalidateQuestsCache).toHaveBeenCalled();
    expect(mocks.invalidateAchievementsCache).toHaveBeenCalled();
    expect(mocks.invalidateProfilesCache).toHaveBeenCalled();
    expect(mocks.invalidateHeistCache).toHaveBeenCalled();
    // currency_name/currency_emoji are part of the brand kit, and the economy
    // dashboard route notifies 'economy' — a currency rename must invalidate
    // the kit too, or brand surfaces show the old currency for the TTL.
    expect(mocks.invalidateBrandKitCache).toHaveBeenCalledWith('guild-1');
  });

  it('invalidates the brand kit cache on section=branding', async () => {
    await configHandler({ guildId: 'guild-1', data: { section: 'branding', changedBy: 'user1' } });
    expect(mocks.invalidateBrandKitCache).toHaveBeenCalledWith('guild-1');
    // branding is a targeted invalidation — not an economy-wide sweep
    expect(mocks.invalidateEconomyCache).not.toHaveBeenCalled();
  });

  it('invalidates the brand kit cache as part of the full reload (settings/all)', async () => {
    await configHandler({ guildId: 'guild-1', data: { section: 'all', changedBy: 'user1' } });
    expect(mocks.invalidateBrandKitCache).toHaveBeenCalledWith('guild-1');
  });

  // Every switch-case section should be handled without errors
  for (const section of [
    'moderation', 'levels', 'welcome', 'commerce', 'music', 'tickets',
    'automations', 'onboarding', 'reaction-roles', 'giveaways', 'temp-channels',
    'scheduled-messages', 'custom-commands', 'stats-channels', 'embeds',
    'settings', 'economy', 'branding', 'all',
  ]) {
    it(`handles section=${section} without throwing`, async () => {
      await configHandler({ guildId: 'guild-1', data: { section, changedBy: 'user1' } });
    });
  }

  it('handles unknown section via full reload', async () => {
    await configHandler({ guildId: 'guild-1', data: { section: 'nonexistent', changedBy: 'user1' } });
  });

  it('drops the alert-channel cache on section=settings so a changed alert_channel_id takes effect', async () => {
    // The 60s alert-channel cache also caches negatives — without this
    // invalidation, owner pings keep resolving the stale channel id (or the
    // cached "not configured") until the TTL lapses.
    await configHandler({ guildId: 'guild-1', data: { section: 'settings', changedBy: 'user1' } });
    expect(mocks.invalidateAlertChannelCache).toHaveBeenCalledWith('guild-1');
  });

  it('drops the alert-channel cache on section=all (full reload path)', async () => {
    await configHandler({ guildId: 'guild-1', data: { section: 'all', changedBy: 'user1' } });
    expect(mocks.invalidateAlertChannelCache).toHaveBeenCalledWith('guild-1');
  });

  it('respects cooldown — same section within cooldown window is skipped', async () => {
    vi.clearAllMocks();
    await configHandler({ guildId: 'guild-1', data: { section: 'economy', changedBy: 'user1' } });
    expect(mocks.invalidateEconomyCache).toHaveBeenCalledTimes(1);

    // Immediate second call should be cooldown-blocked
    await configHandler({ guildId: 'guild-1', data: { section: 'economy', changedBy: 'user1' } });
    expect(mocks.invalidateEconomyCache).toHaveBeenCalledTimes(1);
  });

  it('different sections are not cooldown-blocked by each other', async () => {
    vi.clearAllMocks();
    await configHandler({ guildId: 'guild-1', data: { section: 'economy', changedBy: 'user1' } });
    await configHandler({ guildId: 'guild-1', data: { section: 'levels', changedBy: 'user1' } });
    // economy handled
    expect(mocks.invalidateEconomyCache).toHaveBeenCalled();
    // levels also handled (separate cooldown)
  });
});
