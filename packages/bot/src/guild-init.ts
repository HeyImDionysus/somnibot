/**
 * Guild Feature Initializer — registers all per-guild feature managers.
 *
 * Extracted from index.ts boot sequence so the same initialization logic
 * can run for:
 *   (a) The primary guild at startup
 *   (b) Additional guilds lazily via GuildRouter.initCallback
 *   (c) Newly joined guilds via the guildCreate event
 *
 * This is the core of multi-guild support: each guild gets its own
 * isolated set of feature managers, timers, and config.
 */

import type { Guild, RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import { BOOT_ID } from './services/boot-identity.js';
import { seedStarterContent } from './services/content-seeder.js';
import { backfillMembers } from './features/welcome/member-service.js';
import { REST, Routes } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { PlatformEventBus } from './services/event-bus.js';
import type { GuildContext } from './guild-context.js';
import type { SomniClient } from './client.js';
import { createLogger } from '@somnibot/shared';

// ── Feature managers ──
import { AutomationEngine } from './features/automations/index.js';
import { initVoiceTracking, startVoiceXpTicker, buildLevelCommands } from './features/levels/index.js';
import { loadReactionRoles } from './features/reaction-roles/index.js';
import { loadCustomCommands } from './features/custom-commands/index.js';
import { TempChannelManager } from './features/temp-channels/temp-channel-manager.js';
import { buildTempChannelCommands } from './features/temp-channels/commands.js';
import { StatsChannelManager } from './features/stats-channels/index.js';
import { ScheduledMessageRunner } from './features/scheduled-messages/index.js';
import { GiveawayManager, buildGiveawayCommands } from './features/giveaways/index.js';
import { MusicPlayerManager, buildMusicCommands } from './features/music/index.js';
import { EntitlementService, buildStoreCommand, buildLicenseCommand } from './features/commerce/index.js';
import { AuditService, DiagnosticsService } from './features/audit/index.js';
import { startPeriodicSnapshots } from './services/guild-snapshot.js';
import { startActionQueueListener } from './services/action-queue.js';
import { buildModerationCommands } from './features/moderation/commands.js';
import { buildPurgeCommand } from './features/moderation/purge-command.js';
import { buildXpAdminCommands } from './features/levels/admin-commands.js';
import { buildHelpCommand } from './features/help/index.js';
import { buildForgetMeCommand } from './features/privacy/forgetme-command.js';
import { buildPrivacyCommand } from './features/privacy/privacy-command.js';
import { buildMyDataCommand } from './features/account/mydata-command.js';
import { buildTutorialCommand } from './features/tutorial/tutorial-command.js';
import { buildContextMenuCommands, BotPresenceManager } from './features/discord-ux/index.js';
import { ConfigWatcher } from './services/config-watcher.js';
import { OwnerNotificationService } from './services/owner-notifications.js';
import { GiveawayFulfillmentService } from './services/giveaway-fulfillment.js';
import { MusicStatusReporter } from './services/music-status-reporter.js';
import { HeartbeatService } from './services/heartbeat.js';
import { AlertService } from './services/alert-service.js';
import { CrossFeatureBridge } from './services/cross-feature-bridge.js';
import { scheduleReconciliation, type ReconciliationSchedule } from './services/reconciliation.js';
import { AutoModSync } from './features/discord-native/automod-sync.js';
import { GuildOnboardingSync } from './features/discord-native/guild-onboarding-sync.js';
import { startAntiRaidPruner, stopAntiRaidPruner, clearAntiRaidGuildState, resumeRaidState } from './features/anti-raid/index.js';
import { ForumTicketService } from './features/discord-native/forum-tickets.js';
import { buildSetupCommand } from './features/setup-wizard/index.js';
import { startSyncScheduler, type SyncConfig } from './sync/sync-engine.js';
import { checkBotRolePosition } from './guards/bot-role-guard.js';
import { ticketCommand } from './features/tickets/ticket-commands.js';
import { reconcileTicketOrphanChannels } from './features/tickets/ticket-service.js';
import { EconomyManager, buildEconomyCommands, registerEconomyManager, unregisterEconomyManager, buildTimersCommand } from './features/economy/index.js';
import { GatheringManager, buildGatheringCommands, registerGatheringManager, unregisterGatheringManager } from './features/gathering/index.js';
import { CraftingManager, buildCraftingCommands, registerCraftingManager, unregisterCraftingManager } from './features/crafting/index.js';
import { FarmingManager, buildFarmingCommands, registerFarmingManager, unregisterFarmingManager } from './features/farming/index.js';
import { FishingManager, buildFishingCommands, registerFishingManager, unregisterFishingManager } from './features/fishing/index.js';
import { AdventureManager, buildAdventureCommands, registerAdventureManager, unregisterAdventureManager } from './features/adventures/index.js';
import { MarketManager, buildMarketCommands, registerMarketManager, unregisterMarketManager } from './features/market/index.js';
import { TriviaManager, buildTriviaCommands, registerTriviaManager, unregisterTriviaManager, TriviaScheduleRunner } from './features/trivia/index.js';
import { appealCommand } from './features/appeals/index.js';
import { GamesManager, buildGameCommands, registerGamesManager, unregisterGamesManager } from './features/games/index.js';
import { LotteryManager, buildLotteryCommands, registerLotteryManager, unregisterLotteryManager } from './features/lottery/index.js';
import { PollsManager, buildPollCommands, registerPollsManager, unregisterPollsManager } from './features/polls/index.js';
import { PetsManager, buildPetCommands, registerPetsManager, unregisterPetsManager } from './features/pets/index.js';
import { QuestsManager, buildQuestCommands, registerQuestsManager, unregisterQuestsManager } from './features/quests/index.js';
import { AchievementsManager, buildAchievementCommands, registerAchievementsManager, unregisterAchievementsManager } from './features/achievements/index.js';
import { ProfilesManager, buildProfileCommands, registerProfilesManager, unregisterProfilesManager } from './features/profiles/index.js';
import { HeistManager, buildHeistCommands, registerHeistManager, unregisterHeistManager } from './features/heist/index.js';

const log = createLogger('GuildInit');

// ── Content-warmup concurrency gate ──
// Each guild's content warmup runs as a detached promise (tracked via
// ctx.backgroundInit but never awaited by init), so a mass-guild boot would
// otherwise fire every guild's seed reads/writes at Supabase simultaneously.
// This module-level semaphore caps how many warmup bodies run at once; the
// promises stay detached, waiters simply queue for a slot.
const WARMUP_MAX_CONCURRENT = 3;
let warmupActive = 0;
const warmupWaiters: Array<() => void> = [];

async function acquireWarmupSlot(): Promise<void> {
  if (warmupActive < WARMUP_MAX_CONCURRENT) {
    warmupActive++;
    return;
  }
  await new Promise<void>((resolve) => warmupWaiters.push(resolve));
}

function releaseWarmupSlot(): void {
  const next = warmupWaiters.shift();
  if (next) {
    // Hand the slot to the next waiter — active count is unchanged.
    next();
  } else {
    warmupActive--;
  }
}

/**
 * All per-guild timers and services stored in the context for cleanup.
 */
interface GuildServices {
  snapshotTimer?: ReturnType<typeof setInterval>;
  voiceXpTimer?: ReturnType<typeof setInterval>;
  actionQueueStaleTimer?: ReturnType<typeof setInterval>;
  actionQueueStop?: () => Promise<void>;
  syncHandle?: {
    stop: () => Promise<void>;
    reconfigure: (intervalMinutes?: number, runImmediately?: boolean) => void;
  };
  reconciliationSchedule?: ReconciliationSchedule;
  ticketCleanupTimer?: ReturnType<typeof setInterval>;
  automationEngine?: AutomationEngine;
  configWatcher?: ConfigWatcher;
  presenceManager?: BotPresenceManager;
  crossFeatureBridge?: CrossFeatureBridge;
  autoModSync?: AutoModSync;
  guildOnboardingSync?: GuildOnboardingSync;
  notificationService?: OwnerNotificationService;
  heartbeatService?: HeartbeatService;
  alertService?: AlertService;
  diagnosticsService?: DiagnosticsService;
  auditService?: AuditService;
  musicStatusReporter?: MusicStatusReporter;
  musicPlayer?: MusicPlayerManager;
  tempChannelManager?: TempChannelManager;
  statsManager?: StatsChannelManager;
  scheduledRunner?: ScheduledMessageRunner;
  triviaScheduleRunner?: TriviaScheduleRunner;
  giveawayManager?: GiveawayManager;
  giveawayFulfillment?: GiveawayFulfillmentService;
  forumTicketService?: ForumTicketService;
}

/**
 * Market is configurable at runtime, so its manager and command must exist even
 * while the feature is disabled. MarketManager enforces the flag at execution.
 */
export function initializeMarketFeature(
  ctx: GuildContext,
  allCommands: RESTPostAPIApplicationCommandsJSONBody[],
): void {
  const manager = new MarketManager(ctx.guild, ctx.supabase, ctx.valkey);
  registerMarketManager(manager, ctx.guildId);
  ctx.setManager('market', manager);
  const commands = buildMarketCommands();
  for (const command of Object.values(commands)) {
    allCommands.push(command.toJSON());
  }
}

/**
 * Initialize all feature managers and services for a single guild.
 * This is the GuildRouter initCallback: called once per guild on first access.
 *
 * @returns The slash commands that should be registered for this guild.
 */
export async function initGuildFeatures(
  ctx: GuildContext,
  client: SomniClient,
): Promise<RESTPostAPIApplicationCommandsJSONBody[]> {
  const { guild, guildId, supabase, valkey, eventBus } = ctx;
  const guildLog = log.child({ guild: guild.name, guildId });
  const services: GuildServices = {};
  const allCommands: RESTPostAPIApplicationCommandsJSONBody[] = [];

  guildLog.info('Initializing features');

  // V10 Audit L-3: Anti-raid pruner is process-wide (idempotent singleton),
  // moved to bot-level startup in index.ts to avoid redundant per-guild calls.

  // ── Bot role check ──
  const roleCheck = await checkBotRolePosition(guild);
  if (roleCheck.isTopPosition) {
    guildLog.info('Bot role at position #1');
  } else {
    guildLog.warn('Bot role NOT at position #1', {
      rolesAbove: roleCheck.rolesAboveBot.length,
    });
  }

  // ── Guild record in Supabase ──
  const botMember = guild.members.me;
  if (botMember) {
    const { error } = await supabase
      .from('guild')
      .upsert({
        id: guildId,
        name: guild.name,
        owner_discord_id: guild.ownerId,
        bot_role_position: botMember.roles.highest.position,
        total_roles: guild.roles.cache.size,
      }, { onConflict: 'id' });
    if (error) guildLog.error('Failed to update guild record', { error: error.message });
    else guildLog.info('Guild record updated');
  }

  // ── Community channels ──
  try {
    const communityIds: { key: string; discordId: string }[] = [];
    if (guild.rulesChannelId) communityIds.push({ key: 'channel:rules', discordId: guild.rulesChannelId });
    if (guild.publicUpdatesChannelId) communityIds.push({ key: 'channel:public-updates', discordId: guild.publicUpdatesChannelId });
    const modOnly = guild.channels.cache.find((c) => c.name === 'moderator-only');
    if (modOnly) communityIds.push({ key: 'channel:moderator-only', discordId: modOnly.id });

    if (communityIds.length > 0) {
      const rows = communityIds.map((c) => ({
        guild_id: guildId,
        entity_type: 'channel',
        template_key: c.key,
        discord_id: c.discordId,
      }));
      const { error } = await supabase
        .from('discord_id_map')
        .upsert(rows, { onConflict: 'guild_id,entity_type,template_key' });
      if (error) guildLog.warn('Failed to register community channels', { error: error.message });
      else guildLog.info('Registered community channels', { count: communityIds.length });
    }
  } catch (err) {
    guildLog.warn('Community channel registration failed', { error: String(err) });
  }

  // ── Pre-fetch guild config (single query) ──
  // eslint-disable-next-line prefer-const -- reassigned below when we create the row
  let { data: guildCfg } = await supabase
    .from('guild_config')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (guildCfg) {
    ctx.config = guildCfg;
    guildLog.info('Guild config loaded (1 query)');
  } else {
    // No row yet: the wizard is what normally creates one, so a guild that has
    // not run /setup had no config at all. Every caller then fell back to its
    // own hardcoded default, which is a second place for defaults to live and
    // duly drifted from the column defaults (levels shipped ON in the schema
    // but OFF in loadLevelConfig's fallback). Create the row on join instead,
    // so the column defaults are the single source of truth.
    const { data: created, error } = await supabase
      .from('guild_config')
      .insert({ guild_id: guildId })
      .select()
      .single();

    if (created) {
      // Everything below this point reads `guildCfg`, not ctx.config. Setting
      // only the latter left the rest of init running against null fallbacks,
      // so a freshly joined guild skipped every service whose flag defaults on
      // (the economy block and its subfeatures) until the next restart.
      guildCfg = created;
      ctx.config = created;
      guildLog.info('Guild config created with catalog defaults');
    } else {
      // Most likely the guild row is missing (bot member unavailable above, so
      // the FK has nothing to point at). Not fatal — callers still have their
      // fallbacks, and the next init will retry.
      guildLog.warn('Could not create guild config', { error: error?.message });
    }
  }

  // ── Snapshots + Action Queue ──
  // V11 Audit C-3: Interval increased to 5 min (matches new default).
  services.snapshotTimer = startPeriodicSnapshots(guild, supabase, 300_000);
  guildLog.info('Guild snapshots started (5 min)');

  // Roster backfill: member rows were only written by guildMemberAdd, so a
  // server that existed before the bot was installed had an empty members
  // table forever — the dashboard's Members page showed nobody. Fire and
  // forget; init must not wait on a large member fetch.
  // The loopback E2E harness skips the EAGER init work. Scenarios are
  // authored against controlled fixtures and trigger the same seeds lazily —
  // the long-proven semantics where a manager's in-memory cache and the
  // database always agree. Running the eager path there either raced the
  // cleanup sweep (residue) or, if awaited then swept, left caches describing
  // rows that no longer exist. Production behaviour is unchanged; this is the
  // same documented seam the harness already uses for its disposable-guild
  // confirmation.
  const eagerInitEnabled = !process.env.SOMNIBOT_LOOPBACK_E2E_CONFIRMATION;

  const backfillWork = eagerInitEnabled
    ? backfillMembers(supabase, guild).then(() => undefined, (err) => {
      guildLog.warn('Member roster backfill failed', { error: String(err) });
    })
    : Promise.resolve();
  // Tracked immediately: if the economy block below is disabled, the warmup
  // never runs, and the backfill must still be awaitable by the E2E harness.
  ctx.backgroundInit = backfillWork;
  const aqHandle = await startActionQueueListener(guild, supabase);
  services.actionQueueStaleTimer = aqHandle.staleRecoveryTimer;
  services.actionQueueStop = aqHandle.stop;
  guildLog.info('Action queue listener started');

  // ── Sync engine ──
  const syncConfig: SyncConfig = {
    enabled: guildCfg?.sync_enabled ?? true,
    intervalMinutes: guildCfg?.sync_interval_minutes ?? 60,
    autoRepair: guildCfg?.sync_auto_repair ?? false,
    autoRepairEveryone: guildCfg?.sync_auto_repair_everyone ?? false,
  };
  // Keep the scheduler alive even while sync is disabled. Its cycles read the
  // current DB config and no-op while disabled, which lets a dashboard change
  // enable sync without requiring a process restart.
  services.syncHandle = startSyncScheduler(guild, supabase, eventBus, syncConfig);
  guildLog.info('Sync scheduler started', {
    enabled: syncConfig.enabled,
    interval: syncConfig.intervalMinutes,
  });

  // ── Ticket command (always registered) ──
  allCommands.push(ticketCommand);
  allCommands.push(appealCommand);

  // ── Automation engine ──
  try {
    services.automationEngine = new AutomationEngine(guild, supabase, valkey, eventBus);
    await services.automationEngine.start();
    ctx.setManager('automationEngine', services.automationEngine);
    guildLog.info('Automation engine started');
  } catch (err) {
    guildLog.error('Automation engine failed', { error: String(err) });
  }

  // ── Levels, Reaction Roles, Custom Commands ──
  try {
    const { rankCmd, leaderboardCmd } = buildLevelCommands();
    allCommands.push(rankCmd.toJSON(), leaderboardCmd.toJSON());
    const xpAdminCmd = buildXpAdminCommands();
    allCommands.push(xpAdminCmd.toJSON());

    await initVoiceTracking(guild);
    services.voiceXpTimer = await startVoiceXpTicker(guild, supabase, valkey, eventBus);
    await loadReactionRoles(supabase, valkey, guildId);

    const rest = new REST({ version: '10' }).setToken(client.env.DISCORD_TOKEN);
    // FIX #15: loadCustomCommands now returns command JSON bodies to merge
    // into allCommands so the bulk PUT includes them (instead of separate
    // POST calls that get overwritten by the bulk PUT on every restart).
    const customCmdBodies = await loadCustomCommands(supabase, guild, rest);
    for (const body of customCmdBodies) allCommands.push(body);
    guildLog.info('Levels, reaction roles, custom commands loaded');
  } catch (err) {
    guildLog.error('Levels/reaction roles init error', { error: String(err) });
  }

  // ── Community features (temp channels, stats, scheduled messages, giveaways) ──
  const startedRuntimeFeatures: string[] = [];
  try {
    if (guildCfg?.temp_channels_enabled !== false) {
      services.tempChannelManager = new TempChannelManager(guild, supabase);
      await services.tempChannelManager.start();
      ctx.setManager('tempChannelManager', services.tempChannelManager);
      const voiceCmd = buildTempChannelCommands();
      allCommands.push(voiceCmd.toJSON());
      startedRuntimeFeatures.push('temp_channels');
      guildLog.info('Temp channels started');
    }
    if (guildCfg?.stats_enabled !== false) {
      const intervalMins = guildCfg?.stats_update_interval_minutes ?? 10;
      services.statsManager = new StatsChannelManager(guild, supabase, intervalMins);
      await services.statsManager.start();
      ctx.setManager('statsManager', services.statsManager);
      startedRuntimeFeatures.push('stats_channels');
      guildLog.info('Stats channels started');
    }
    if (guildCfg?.scheduled_messages_enabled !== false) {
      services.scheduledRunner = new ScheduledMessageRunner(guild, supabase);
      await services.scheduledRunner.start();
      ctx.setManager('scheduledRunner', services.scheduledRunner);
      startedRuntimeFeatures.push('scheduled_messages');
      guildLog.info('Scheduled messages started');
    }
    if (guildCfg?.giveaways_enabled !== false) {
      services.giveawayManager = new GiveawayManager(guild, supabase, valkey, eventBus);
      await services.giveawayManager.start();
      ctx.setManager('giveawayManager', services.giveawayManager);
      const giveawayCmd = buildGiveawayCommands();
      allCommands.push(giveawayCmd.toJSON());
      services.giveawayFulfillment = new GiveawayFulfillmentService(guild, supabase, eventBus);
      services.giveawayFulfillment.start();
      startedRuntimeFeatures.push('giveaways');
      guildLog.info('Giveaway system started');
    }
  } catch (err) {
    guildLog.error('Community features init error', { error: String(err) });
  }


  // ── Music system ──
  try {
    if (guildCfg?.music_enabled !== false) {
      const musicPlayer = new MusicPlayerManager(guild, client.shoukaku, supabase, valkey, eventBus);
      await musicPlayer.init();
      services.musicPlayer = musicPlayer;
      ctx.setManager('musicPlayer', musicPlayer);
      const musicCmds = buildMusicCommands();
      for (const cmd of musicCmds) allCommands.push(cmd.toJSON());
      services.musicStatusReporter = new MusicStatusReporter(musicPlayer, supabase, guildId);
      services.musicStatusReporter.start();
      guildLog.info('Music system started', { commands: musicCmds.length });
      startedRuntimeFeatures.push('music');
    }
  } catch (err) {
    guildLog.error('Music system init error', { error: String(err) });
  }

  // ── Commerce & Licensing ──
  try {
    if (guildCfg?.paypal_enabled !== false) {
      const entitlementService = new EntitlementService(guild, supabase, eventBus);
      ctx.setManager('entitlementService', entitlementService);
      const commerceCmds = [buildStoreCommand(), buildLicenseCommand()];
      for (const cmd of commerceCmds) allCommands.push(cmd.toJSON());
      startedRuntimeFeatures.push('commerce');
      guildLog.info('Commerce system started');
    }
  } catch (err) {
    guildLog.error('Commerce init error', { error: String(err) });
  }

  // ── Economy system + sub-features ──
  try {
    if (guildCfg?.economy_enabled) {
      const economyManager = new EconomyManager(guild, supabase, valkey);
      registerEconomyManager(economyManager, guildId);
      ctx.setManager('economy', economyManager);
      const econCmds = buildEconomyCommands();
      for (const cmd of Object.values(econCmds)) allCommands.push(cmd.toJSON());
      const timersCmd = buildTimersCommand();
      allCommands.push(timersCmd.toJSON());
      guildLog.info('Economy system started');

      // Sub-features (gathering, crafting, farming, fishing, adventures, market, trivia, games, lottery, polls, pets, quests, achievements, heist)
      if (guildCfg.economy_gathering_enabled) {
        const mgr = new GatheringManager(guild, supabase, valkey);
        registerGatheringManager(mgr, guildId); ctx.setManager('gathering', mgr);
        const cmds = buildGatheringCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.economy_crafting_enabled) {
        const mgr = new CraftingManager(guild, supabase, valkey);
        registerCraftingManager(mgr, guildId); ctx.setManager('crafting', mgr);
        const cmds = buildCraftingCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.economy_farming_enabled) {
        const mgr = new FarmingManager(guild, supabase, valkey);
        registerFarmingManager(mgr, guildId); ctx.setManager('farming', mgr);
        const cmds = buildFarmingCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.economy_fishing_enabled) {
        const mgr = new FishingManager(guild, supabase, valkey);
        registerFishingManager(mgr, guildId); ctx.setManager('fishing', mgr);
        const cmds = buildFishingCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.economy_adventures_enabled) {
        const mgr = new AdventureManager(guild, supabase, valkey);
        registerAdventureManager(mgr, guildId); ctx.setManager('adventures', mgr);
        const cmds = buildAdventureCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      // Keep /market registered even while the owner has the feature disabled.
      // The manager already enforces economy_market_enabled and returns an honest
      // disabled response. Conditional construction made the dashboard toggle
      // impossible to hot-enable: ConfigWatcher could invalidate only a manager
      // that did not exist, and Discord kept no /market command until restart.
      initializeMarketFeature(ctx, allCommands);
      if (guildCfg.economy_trivia_enabled) {
        const mgr = new TriviaManager(supabase, valkey);
        registerTriviaManager(mgr, guildId); ctx.setManager('trivia', mgr);
        const cmds = buildTriviaCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
        // Hosted/scheduled trivia cadence: tick every minute and start a round when due.
        services.triviaScheduleRunner = new TriviaScheduleRunner(guild, supabase, mgr);
        services.triviaScheduleRunner.start();
        ctx.setManager('triviaScheduleRunner', services.triviaScheduleRunner);
      }
      if (guildCfg.economy_games_enabled) {
        const mgr = new GamesManager(supabase, valkey);
        registerGamesManager(mgr, guildId); ctx.setManager('games', mgr);
        const cmds = buildGameCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.economy_lottery_enabled) {
        const mgr = new LotteryManager(supabase, client);
        registerLotteryManager(mgr, guildId); ctx.setManager('lottery', mgr);
        mgr.scheduleLotteryDraws(guildId);
        const cmds = buildLotteryCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.polls_enabled || guildCfg.predictions_enabled) {
        const mgr = new PollsManager(supabase);
        registerPollsManager(mgr, guildId); ctx.setManager('polls', mgr);
        const cmds = buildPollCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.economy_pets_enabled) {
        const mgr = new PetsManager(supabase, client, valkey);
        registerPetsManager(mgr, guildId); ctx.setManager('pets', mgr);
        mgr.schedulePetDecay(guildId);
        const cmds = buildPetCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.economy_quests_enabled) {
        const mgr = new QuestsManager(supabase);
        registerQuestsManager(mgr, guildId); ctx.setManager('quests', mgr);
        mgr.scheduleWeeklyReset(guildId);
        const cmds = buildQuestCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.economy_achievements_enabled || guildCfg.economy_prestige_enabled) {
        // The guild handle lets reward_xp grants run the level-up path
        // (role rewards + announcements) exactly like message XP.
        const mgr = new AchievementsManager(supabase, guild);
        registerAchievementsManager(mgr, guildId); ctx.setManager('achievements', mgr);
        const cmds = buildAchievementCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.economy_heist_enabled) {
        const mgr = new HeistManager(supabase, client);
        registerHeistManager(mgr, guildId); ctx.setManager('heist', mgr);
        await mgr.resumePendingHeists(guildId);
        const cmds = buildHeistCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
    }

    // Profiles (always available)
    const profilesManager = new ProfilesManager(supabase);
    registerProfilesManager(profilesManager, guildId); ctx.setManager('profiles', profilesManager);
    const profCmds = buildProfileCommands();
    for (const cmd of Object.values(profCmds)) allCommands.push(cmd.toJSON());

    // ── Content warmup ──
    // Fishing, adventures, crafting, farming, gathering and quests all ship
    // default content, but they seeded it lazily on first command use — so a
    // fresh install showed empty dashboard pages for features that claimed to
    // be on, until somebody happened to run each command in Discord. Seed now,
    // in the background; every call is idempotent and only writes when the
    // guild has no rows.
    const warmupWork = eagerInitEnabled ? (async () => {
      // Bounded concurrency: the promise stays detached (ctx.backgroundInit
      // below still tracks it), but at most WARMUP_MAX_CONCURRENT guilds run
      // their seed reads/writes at once.
      await acquireWarmupSlot();
      const failed: string[] = [];
      try {
        // Starter content runs FIRST: the crafting warmup below creates
        // economy_items rows (recipe outputs), and the starter shop's
        // name-scoped gate must be evaluated before any of that lands —
        // otherwise a default install never gets the Padlock + tools
        // (see content-seeder.ts).
        try {
          await seedStarterContent(supabase, guildId);
        } catch (err) {
          failed.push('starter-content');
          guildLog.warn('Starter content seeding failed', { error: String(err) });
        }
        const warmups: Array<[string, (() => Promise<void>) | undefined]> = [
          ['fishing', ctx.getManager<FishingManager>('fishing') && (() => ctx.getManager<FishingManager>('fishing')!.ensureContentSeeded())],
          ['adventures', ctx.getManager<AdventureManager>('adventures') && (() => ctx.getManager<AdventureManager>('adventures')!.ensureContentSeeded())],
          ['crafting', ctx.getManager<CraftingManager>('crafting') && (() => ctx.getManager<CraftingManager>('crafting')!.ensureContentSeeded())],
          ['farming', ctx.getManager<FarmingManager>('farming') && (() => ctx.getManager<FarmingManager>('farming')!.ensureContentSeeded())],
          ['gathering', ctx.getManager<GatheringManager>('gathering') && (() => ctx.getManager<GatheringManager>('gathering')!.ensureContentSeeded())],
          ['quests', ctx.getManager<QuestsManager>('quests') && (() => ctx.getManager<QuestsManager>('quests')!.ensureContentSeeded(guildId))],
        ];
        for (const [name, run] of warmups) {
          if (!run) continue; // feature disabled — nothing registered
          try {
            await run();
          } catch (err) {
            failed.push(name);
            guildLog.warn(`Content warmup failed for ${name}`, { error: String(err) });
          }
        }
      } finally {
        releaseWarmupSlot();
      }
      // Every seed helper now surfaces its Supabase {error}, so this line is
      // honest: "complete" means every enabled feature actually has content.
      if (failed.length > 0) {
        guildLog.warn('Content warmup degraded — some features could not seed content', { failed });
      } else {
        guildLog.info('Content warmup complete');
      }
    })() : Promise.resolve();
    // Fold the warmup into the tracked background work (joins the backfill
    // registered above), so the E2E harness can wait for ALL init writes.
    ctx.backgroundInit = Promise.allSettled([backfillWork, warmupWork]).then(() => undefined);
  } catch (err) {
    guildLog.error('Economy system init error', { error: String(err) });
  }

  // ── Anti-raid recovery ──
  // Raid mode lives in Valkey with a 5-minute expiry, so a restart mid-raid
  // used to drop containment AND strand any lockdown at "Very High" with its
  // invites paused. Rebuild it from the durable record before anything else
  // starts processing joins.
  try {
    const resumed = await resumeRaidState(guild, supabase);
    if (resumed === 'resumed') {
      guildLog.warn('Anti-raid: active raid mode resumed after restart');
    } else if (resumed === 'expired') {
      guildLog.info('Anti-raid: a raid had expired during downtime — state cleared');
    }
  } catch (err) {
    guildLog.error('Anti-raid resume failed', { error: String(err) });
  }

  // ── Entitlement reconciliation ──
  try {
    services.reconciliationSchedule = scheduleReconciliation(guild, supabase);
    guildLog.info('Entitlement reconciliation scheduled');
  } catch (err) {
    guildLog.error('Reconciliation scheduler failed', { error: String(err) });
  }

  // ── Durable orphaned ticket-channel cleanup ──
  const retryTicketOrphanCleanup = () => {
    void reconcileTicketOrphanChannels(guild, supabase).catch((error) => {
      guildLog.warn('Ticket orphan reconciliation failed; cleanup remains queued', {
        error: String(error),
      });
    });
  };
  services.ticketCleanupTimer = setInterval(retryTicketOrphanCleanup, 5 * 60_000);
  services.ticketCleanupTimer.unref?.();
  try {
    const reconciled = await reconcileTicketOrphanChannels(guild, supabase);
    if (reconciled > 0) {
      guildLog.warn('Recovered orphaned ticket channels after restart', { count: reconciled });
    }
  } catch (err) {
    // The durable occurrence rows remain claimed and the timer above retries
    // even when the initial startup query itself is unavailable.
    guildLog.error('Ticket orphan reconciliation startup failed', { error: String(err) });
  }

  // ── Audit & Diagnostics ──
  try {
    services.auditService = new AuditService(guildId, supabase, eventBus, valkey);
    services.auditService.start();
    ctx.setManager('auditService', services.auditService);

    await services.auditService.log({
      action: 'bot.started',
      actorType: 'system',
      actorId: 'system',
      details: { version: '0.5.0' },
    });

    services.diagnosticsService = new DiagnosticsService(client, supabase, guildId);
    services.diagnosticsService.start();

    // V5 Fix #9: Heartbeat is now bot-level (started in index.ts), not per-guild.
    // Per-guild heartbeat removed to avoid 2 timers per guild.

    services.alertService = new AlertService(valkey, supabase, guild);
    await services.alertService.init();
    ctx.setManager('alertService', services.alertService);

    // Wire alert service into automation engine
    if (services.automationEngine) {
      services.automationEngine.setAlertService(services.alertService);
    }

    guildLog.info('Audit, diagnostics, heartbeat, and alerts initialized');
  } catch (err) {
    guildLog.error('Audit/diagnostics init error', { error: String(err) });
  }

  // ── Moderation, Help, Context Menus, Config Watcher, Notifications ──
  try {
    const modCmds = buildModerationCommands();
    for (const cmd of Object.values(modCmds)) allCommands.push(cmd.toJSON());
    const purgeCmd = buildPurgeCommand();
    allCommands.push(purgeCmd.toJSON());

    allCommands.push(buildHelpCommand().toJSON());
    allCommands.push(buildSetupCommand().toJSON());
    allCommands.push(buildForgetMeCommand().toJSON());
    allCommands.push(buildPrivacyCommand().toJSON());
    allCommands.push(buildMyDataCommand().toJSON());
    allCommands.push(buildTutorialCommand().toJSON());

    const contextMenuCmds = buildContextMenuCommands();
    for (const cmd of contextMenuCmds) allCommands.push(cmd.toJSON());

    services.configWatcher = new ConfigWatcher(
      guild,
      supabase,
      eventBus,
      valkey,
      (intervalMinutes, runImmediately) =>
        services.syncHandle?.reconfigure(intervalMinutes, runImmediately),
    );
    services.configWatcher.start();
    ctx.setManager('configWatcher', services.configWatcher);

    // V10 Audit L-4: BotPresenceManager sets client-wide presence but was
    // created per-guild (each guild's timer would overwrite the last).
    // Moved to bot-level init in index.ts. See presenceManager on client.

    services.crossFeatureBridge = new CrossFeatureBridge(guild, supabase, eventBus, valkey);
    services.crossFeatureBridge.start();

    services.autoModSync = new AutoModSync(guild, supabase, eventBus);
    services.autoModSync.start();

    services.guildOnboardingSync = new GuildOnboardingSync(guild, supabase, eventBus);
    services.guildOnboardingSync.start();

    services.forumTicketService = new ForumTicketService(guild, supabase);
    ctx.setManager('forumTicketService', services.forumTicketService);

    services.notificationService = new OwnerNotificationService(client, guildId, supabase, eventBus);
    await services.notificationService.start();

    guildLog.info('Moderation, help, config watcher, notifications initialized');
  } catch (err) {
    guildLog.error('Phase 14 init error', { error: String(err) });
  }

  // Store services in context for cleanup on destroy
  ctx.setManager('_services', services);
  ctx.setManager('_commands', allCommands);

  guildLog.info('All features initialized', { commandCount: allCommands.length });
  // The dashboard's feature panel must know which managers THIS boot
  // constructed: a feature enabled after boot has no manager until restart,
  // and a current global heartbeat alone must not read as 'reachable'.
  // Rewritten every boot so rows always reflect the latest initialization.
  try {
    // Upsert the running set FIRST, then prune stale rows — supabase reports
    // failures via `error`, not throws, and this order never publishes a
    // partial snapshot that under-reports running managers: an upsert
    // failure leaves last boot's rows (checked below), and a prune failure
    // only over-reports features until the next boot.
    if (startedRuntimeFeatures.length > 0) {
      const { error: upsertError } = await supabase
        .from('guild_runtime_features')
        .upsert(
          startedRuntimeFeatures.map((feature) => ({
            guild_id: guild.id,
            feature,
            // Boot identity: the dashboard compares this to the heartbeat's
            // boot_id, so rows stranded by an earlier boot (this upsert or
            // the prune below failing transiently) can never combine with a
            // RECOVERED heartbeat into a false 'operational'.
            boot_id: BOOT_ID,
          })),
          { onConflict: 'guild_id,feature' },
        );
      if (upsertError) {
        guildLog.error('Failed to record runtime feature state', {
          error: upsertError.message,
        });
      } else {
        // Prune by boot identity: anything not written by THIS boot is
        // stale, including features that failed to start this time.
        const { error: pruneError } = await supabase
          .from('guild_runtime_features')
          .delete()
          .eq('guild_id', guild.id)
          .neq('boot_id', BOOT_ID);
        if (pruneError) {
          guildLog.error('Failed to prune stale runtime feature rows', {
            error: pruneError.message,
          });
        }
      }
    } else {
      const { error: clearError } = await supabase
        .from('guild_runtime_features')
        .delete()
        .eq('guild_id', guild.id);
      if (clearError) {
        guildLog.error('Failed to clear runtime feature rows', { error: clearError.message });
      }
    }
  } catch (err) {
    guildLog.error('Failed to record runtime feature state', { error: String(err) });
  }

  return allCommands;
}

/**
 * Register slash commands for a guild via bulk PUT.
 */
export async function registerGuildCommands(
  client: SomniClient,
  guildId: string,
  commands: RESTPostAPIApplicationCommandsJSONBody[],
): Promise<void> {
  if (commands.length === 0) return;
  const rest = new REST({ version: '10' }).setToken(client.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user!.id, guildId),
      { body: commands },
    );
    log.info('Slash commands registered', { guildId, count: commands.length });
  } catch (err) {
    log.error('Slash command registration failed', { guildId, error: String(err) });
  }
}

/**
 * Destroy all services for a guild context (called on guild leave or shutdown).
 */
export interface DestroyGuildServicesOptions {
  /**
   * Test-only lifecycle seam for the loopback fleet: quiesce every background
   * producer while retaining the real action-queue listener long enough for a
   * privacy purge to settle its queued work.
   */
  preserveActionQueue?: boolean;
  /** Do not unregister manager state while the retained queue is still live. */
  preserveRegistries?: boolean;
}

export async function destroyGuildServices(
  ctx: GuildContext,
  options: DestroyGuildServicesOptions = {},
): Promise<void> {
  const services = ctx.getManager<GuildServices>('_services');
  if (!services) return;

  const guildLog = log.child({ guildId: ctx.guildId });
  guildLog.info('Destroying guild services');
  const stopFailures: Array<{ name: string; error: unknown }> = [];
  const pendingProducerStops: Array<{ name: string; promise: Promise<void> }> = [];
  const stopSyncProducer = (name: string, stop: () => void): void => {
    try {
      stop();
    } catch (error) {
      stopFailures.push({ name, error });
    }
  };

  // Phase 1: quiesce every producer while AuditService is still subscribed and
  // accepting. Any final shutdown events therefore enter its serialized drain.
  if (services.snapshotTimer) clearInterval(services.snapshotTimer);
  if (services.voiceXpTimer) clearInterval(services.voiceXpTimer);
  if (!options.preserveActionQueue && services.actionQueueStaleTimer) {
    clearInterval(services.actionQueueStaleTimer);
  }
  if (!options.preserveActionQueue && services.actionQueueStop) {
    try {
      pendingProducerStops.push({
        name: 'action queue',
        promise: services.actionQueueStop(),
      });
    } catch (error) {
      stopFailures.push({ name: 'action queue', error });
    }
  }
  if (services.reconciliationSchedule) {
    pendingProducerStops.push({
      name: 'entitlement reconciliation',
      promise: services.reconciliationSchedule.stop(),
    });
  }
  if (services.ticketCleanupTimer) clearInterval(services.ticketCleanupTimer);
  if (services.syncHandle) {
    try {
      pendingProducerStops.push({
        name: 'sync handle',
        promise: services.syncHandle.stop(),
      });
    } catch (error) {
      stopFailures.push({ name: 'sync handle', error });
    }
  }

  // Services with stop(), excluding AuditService: audit is the final consumer
  // and is stopped only after every producer below has settled.
  // V10 Audit M-5: Added notificationService and giveawayFulfillment.
  // V11 Audit H-3: Added automationEngine and forumTicketService —
  // both were started but not tracked for shutdown, leaking timers/listeners.
  const producerServices: Array<[string, unknown]> = [
    ['automation engine', services.automationEngine],
    ['temp channel manager', services.tempChannelManager],
    ['stats manager', services.statsManager],
    ['scheduled runner', services.scheduledRunner],
    ['trivia schedule runner', services.triviaScheduleRunner],
    ['giveaway manager', services.giveawayManager],
    ['diagnostics service', services.diagnosticsService],
    ['heartbeat service', services.heartbeatService],
    ['config watcher', services.configWatcher],
    ['presence manager', services.presenceManager],
    ['cross-feature bridge', services.crossFeatureBridge],
    ['auto-mod sync', services.autoModSync],
    ['guild onboarding sync', services.guildOnboardingSync],
    ['notification service', services.notificationService],
    ['giveaway fulfillment', services.giveawayFulfillment],
    ['forum ticket service', services.forumTicketService],
  ];
  for (const [name, svc] of producerServices) {
    if (typeof svc === 'object' && svc !== null && 'stop' in svc && typeof svc.stop === 'function') {
      try {
        const result = (svc as { stop: () => void | Promise<void> }).stop();
        if (result && typeof (result as Promise<void>).then === 'function') {
          pendingProducerStops.push({ name, promise: Promise.resolve(result) });
        }
      } catch (error) {
        stopFailures.push({ name, error });
      }
    }
  }

  if (services.musicPlayer) {
    stopSyncProducer('music player', () => services.musicPlayer!.shutdown());
  }
  if (services.musicStatusReporter) {
    stopSyncProducer('music status reporter', () => services.musicStatusReporter!.stop());
  }

  // Economy managers with timers are also producers and must be quiesced
  // before the audit listener is detached.
  const lottery = ctx.getManager<LotteryManager>('lottery');
  if (lottery && typeof lottery.stopDrawTimer === 'function') {
    stopSyncProducer('lottery draw timer', () => lottery.stopDrawTimer());
  }
  const pets = ctx.getManager<PetsManager>('pets');
  if (pets && typeof pets.stopDecayTimer === 'function') {
    stopSyncProducer('pet decay timer', () => pets.stopDecayTimer());
  }
  const quests = ctx.getManager<QuestsManager>('quests');
  if (quests && typeof quests.stopResetTimer === 'function') {
    stopSyncProducer('quest reset timer', () => quests.stopResetTimer());
  }
  const games = ctx.getManager<GamesManager>('games');
  if (games && typeof games.stopDailyResetTimer === 'function') {
    stopSyncProducer('game daily reset timer', () => games.stopDailyResetTimer());
  }
  const heist = ctx.getManager<HeistManager>('heist');
  if (heist && typeof heist.cleanup === 'function') {
    stopSyncProducer('heist manager', () => heist.cleanup());
  }
  const trivia = ctx.getManager<TriviaManager>('trivia');
  if (trivia && typeof trivia.stopAll === 'function') {
    stopSyncProducer('trivia manager', () => trivia.stopAll());
  }

  const producerResults = await Promise.allSettled(
    pendingProducerStops.map(({ promise }) => promise),
  );
  producerResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      stopFailures.push({
        name: pendingProducerStops[index]!.name,
        error: result.reason,
      });
    }
  });

  // Phase 2: producers are quiet; detach and fully drain audit last.
  if (services.auditService) {
    try {
      await services.auditService.stop();
    } catch (error) {
      stopFailures.push({ name: 'audit service', error });
    }
  }

  for (const failure of stopFailures) {
    guildLog.warn('Guild service stop failed', {
      service: failure.name,
      error: String(failure.error),
    });
  }
  if (stopFailures.length > 0) {
    throw new AggregateError(
      stopFailures.map(({ error }) => error),
      `Failed to stop ${stopFailures.length} guild service(s) for ${ctx.guildId}`,
    );
  }

  if (options.preserveRegistries) {
    guildLog.info('Guild producers quiesced while retaining action queue for privacy purge');
    return;
  }

  // Phase 3: only a fully successful audit drain authorizes irreversible
  // registry/state removal. On failure, the context and these handles remain
  // available for an explicit teardown retry.
  // V11 Audit M-2: Remove per-guild manager references from module-level Maps
  // to prevent unbounded memory growth over the bot's lifetime.
  unregisterEconomyManager(ctx.guildId);
  unregisterGatheringManager(ctx.guildId);
  unregisterCraftingManager(ctx.guildId);
  unregisterFarmingManager(ctx.guildId);
  unregisterFishingManager(ctx.guildId);
  unregisterAdventureManager(ctx.guildId);
  unregisterMarketManager(ctx.guildId);
  unregisterTriviaManager(ctx.guildId);
  unregisterGamesManager(ctx.guildId);
  unregisterLotteryManager(ctx.guildId);
  unregisterPollsManager(ctx.guildId);
  unregisterPetsManager(ctx.guildId);
  unregisterQuestsManager(ctx.guildId);
  unregisterAchievementsManager(ctx.guildId);
  unregisterProfilesManager(ctx.guildId);
  unregisterHeistManager(ctx.guildId);

  // V11 Audit M-3: Clear anti-raid in-memory state for this guild.
  clearAntiRaidGuildState(ctx.guildId);

  guildLog.info('Guild services destroyed');
}
