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
import { scheduleReconciliation } from './services/reconciliation.js';
import { AutoModSync } from './features/discord-native/automod-sync.js';
import { GuildOnboardingSync } from './features/discord-native/guild-onboarding-sync.js';
import { startAntiRaidPruner, stopAntiRaidPruner } from './features/anti-raid/index.js';
import { ForumTicketService } from './features/discord-native/forum-tickets.js';
import { buildSetupCommand } from './features/setup-wizard/index.js';
import { startSyncScheduler, type SyncConfig } from './sync/sync-engine.js';
import { checkBotRolePosition } from './guards/bot-role-guard.js';
import { ticketCommand } from './features/tickets/ticket-commands.js';
import { EconomyManager, buildEconomyCommands, registerEconomyManager, buildTimersCommand } from './features/economy/index.js';
import { GatheringManager, buildGatheringCommands, registerGatheringManager } from './features/gathering/index.js';
import { CraftingManager, buildCraftingCommands, registerCraftingManager } from './features/crafting/index.js';
import { FarmingManager, buildFarmingCommands, registerFarmingManager } from './features/farming/index.js';
import { FishingManager, buildFishingCommands, registerFishingManager } from './features/fishing/index.js';
import { AdventureManager, buildAdventureCommands, registerAdventureManager } from './features/adventures/index.js';
import { MarketManager, buildMarketCommands, registerMarketManager } from './features/market/index.js';
import { TriviaManager, buildTriviaCommands, registerTriviaManager } from './features/trivia/index.js';
import { GamesManager, buildGameCommands, registerGamesManager } from './features/games/index.js';
import { LotteryManager, buildLotteryCommands, registerLotteryManager } from './features/lottery/index.js';
import { PollsManager, buildPollCommands, registerPollsManager } from './features/polls/index.js';
import { PetsManager, buildPetCommands, registerPetsManager } from './features/pets/index.js';
import { QuestsManager, buildQuestCommands, registerQuestsManager } from './features/quests/index.js';
import { AchievementsManager, buildAchievementCommands, registerAchievementsManager } from './features/achievements/index.js';
import { ProfilesManager, buildProfileCommands, registerProfilesManager } from './features/profiles/index.js';
import { HeistManager, buildHeistCommands, registerHeistManager } from './features/heist/index.js';

const log = createLogger('GuildInit');

/**
 * All per-guild timers and services stored in the context for cleanup.
 */
interface GuildServices {
  snapshotTimer?: ReturnType<typeof setInterval>;
  voiceXpTimer?: ReturnType<typeof setInterval>;
  actionQueueStaleTimer?: ReturnType<typeof setInterval>;
  syncHandle?: { stop: () => void };
  reconTimer?: ReturnType<typeof setInterval>;
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
  giveawayManager?: GiveawayManager;
  giveawayFulfillment?: GiveawayFulfillmentService;
  forumTicketService?: ForumTicketService;
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
  const { data: guildCfg } = await supabase
    .from('guild_config')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (guildCfg) {
    ctx.config = guildCfg;
    guildLog.info('Guild config loaded (1 query)');
  }

  // ── Snapshots + Action Queue ──
  services.snapshotTimer = startPeriodicSnapshots(guild, supabase, 60_000);
  guildLog.info('Guild snapshots started (60s)');
  const aqHandle = await startActionQueueListener(guild, supabase);
  services.actionQueueStaleTimer = aqHandle.staleRecoveryTimer;
  guildLog.info('Action queue listener started');

  // ── Sync engine ──
  const syncConfig: SyncConfig = {
    enabled: guildCfg?.sync_enabled ?? true,
    intervalMinutes: guildCfg?.sync_interval_minutes ?? 15,
    autoRepair: guildCfg?.sync_auto_repair ?? false,
    autoRepairEveryone: guildCfg?.sync_auto_repair_everyone ?? true,
  };
  if (syncConfig.enabled) {
    services.syncHandle = startSyncScheduler(guild, supabase, eventBus, syncConfig);
    guildLog.info('Sync engine started', { interval: syncConfig.intervalMinutes });
  }

  // ── Ticket command (always registered) ──
  allCommands.push(ticketCommand);

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
  try {
    if (guildCfg?.temp_channels_enabled !== false) {
      services.tempChannelManager = new TempChannelManager(guild, supabase);
      await services.tempChannelManager.start();
      ctx.setManager('tempChannelManager', services.tempChannelManager);
      const voiceCmd = buildTempChannelCommands();
      allCommands.push(voiceCmd.toJSON());
      guildLog.info('Temp channels started');
    }
    if (guildCfg?.stats_enabled !== false) {
      const intervalMins = guildCfg?.stats_update_interval_minutes ?? 10;
      services.statsManager = new StatsChannelManager(guild, supabase, intervalMins);
      await services.statsManager.start();
      ctx.setManager('statsManager', services.statsManager);
      guildLog.info('Stats channels started');
    }
    if (guildCfg?.scheduled_messages_enabled !== false) {
      services.scheduledRunner = new ScheduledMessageRunner(guild, supabase);
      await services.scheduledRunner.start();
      ctx.setManager('scheduledRunner', services.scheduledRunner);
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
      if (guildCfg.economy_market_enabled) {
        const mgr = new MarketManager(guild, supabase, valkey);
        registerMarketManager(mgr, guildId); ctx.setManager('market', mgr);
        const cmds = buildMarketCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.economy_trivia_enabled) {
        const mgr = new TriviaManager(supabase, valkey);
        registerTriviaManager(mgr, guildId); ctx.setManager('trivia', mgr);
        const cmds = buildTriviaCommands();
        for (const cmd of Object.values(cmds)) allCommands.push(cmd.toJSON());
      }
      if (guildCfg.economy_games_enabled) {
        const mgr = new GamesManager(supabase);
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
        const mgr = new AchievementsManager(supabase);
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
  } catch (err) {
    guildLog.error('Economy system init error', { error: String(err) });
  }

  // ── Entitlement reconciliation ──
  try {
    services.reconTimer = scheduleReconciliation(guild, supabase);
    guildLog.info('Entitlement reconciliation scheduled');
  } catch (err) {
    guildLog.error('Reconciliation scheduler failed', { error: String(err) });
  }

  // ── Audit & Diagnostics ──
  try {
    services.auditService = new AuditService(guildId, supabase, eventBus);
    services.auditService.start();
    ctx.setManager('auditService', services.auditService);

    await services.auditService.log({
      action: 'bot.started',
      actorType: 'system',
      actorId: 'system',
      details: { version: '0.5.0' },
    });

    services.diagnosticsService = new DiagnosticsService(client, supabase);
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

    services.configWatcher = new ConfigWatcher(guild, supabase, eventBus, valkey);
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
export function destroyGuildServices(ctx: GuildContext): void {
  const services = ctx.getManager<GuildServices>('_services');
  if (!services) return;

  const guildLog = log.child({ guildId: ctx.guildId });
  guildLog.info('Destroying guild services');

  // Timers
  if (services.snapshotTimer) clearInterval(services.snapshotTimer);
  if (services.voiceXpTimer) clearInterval(services.voiceXpTimer);
  if (services.actionQueueStaleTimer) clearInterval(services.actionQueueStaleTimer);
  if (services.reconTimer) clearInterval(services.reconTimer);
  if (services.syncHandle) services.syncHandle.stop();

  // Services with stop()
  // V10 Audit M-5: Added notificationService and giveawayFulfillment
  // (both now have stop() methods that remove their event bus listeners).
  const stoppable = [
    services.tempChannelManager,
    services.statsManager,
    services.scheduledRunner,
    services.giveawayManager,
    services.auditService,
    services.diagnosticsService,
    services.heartbeatService,
    services.configWatcher,
    services.presenceManager,
    services.crossFeatureBridge,
    services.autoModSync,
    services.guildOnboardingSync,
    services.notificationService,
    services.giveawayFulfillment,
  ];
  for (const svc of stoppable) {
    if (svc && 'stop' in svc && typeof svc.stop === 'function') {
      svc.stop();
    }
  }

  // Music
  if (services.musicPlayer) {
    services.musicPlayer.shutdown();
  }
  if (services.musicStatusReporter) {
    services.musicStatusReporter.stop();
  }

  // Economy managers with timers
  const lottery = ctx.getManager<LotteryManager>('lottery');
  if (lottery && typeof lottery.stopDrawTimer === 'function') lottery.stopDrawTimer();
  const pets = ctx.getManager<PetsManager>('pets');
  if (pets && typeof pets.stopDecayTimer === 'function') pets.stopDecayTimer();
  const quests = ctx.getManager<QuestsManager>('quests');
  if (quests && typeof quests.stopResetTimer === 'function') quests.stopResetTimer();
  const games = ctx.getManager<GamesManager>('games');
  if (games) {
    games.stopDailyResetTimer();
  }
  const heist = ctx.getManager<HeistManager>('heist');
  if (heist && typeof heist.cleanup === 'function') heist.cleanup();
  const trivia = ctx.getManager<TriviaManager>('trivia');
  if (trivia) {
    trivia.stopAll();
  }

  guildLog.info('Guild services destroyed');
}
