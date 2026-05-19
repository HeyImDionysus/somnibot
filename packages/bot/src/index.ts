import { loadConfig } from './config.js';
import { loadConfigFromDatabase, syncConfigToDatabase } from './services/config-loader.js';
import { SomniClient } from './client.js';
import { registerEvents } from './events/handler.js';
import { connectValkey } from './services/valkey.js';
import { startDeployListener } from './deploy/deploy-listener.js';
import { checkBotRolePosition } from './guards/bot-role-guard.js';
import { startSyncScheduler, type SyncConfig } from './sync/sync-engine.js';
import { registerTicketCommands } from './features/tickets/register-commands.js';
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
import { runMigrations } from './services/migration-runner.js';
import { startPeriodicSnapshots } from './services/guild-snapshot.js';
import { startActionQueueListener } from './services/action-queue.js';
import { buildModerationCommands } from './features/moderation/commands.js';
import { buildHelpCommand } from './features/help/index.js';
import { buildContextMenuCommands, BotPresenceManager } from './features/discord-ux/index.js';
import { ConfigWatcher } from './services/config-watcher.js';
import { OwnerNotificationService } from './services/owner-notifications.js';
import { GiveawayFulfillmentService } from './services/giveaway-fulfillment.js';
import { MusicStatusReporter } from './services/music-status-reporter.js';
import { CrossFeatureBridge } from './services/cross-feature-bridge.js';
import { AutoModSync } from './features/discord-native/automod-sync.js';
import { GuildOnboardingSync } from './features/discord-native/guild-onboarding-sync.js';
import { ForumTicketService } from './features/discord-native/forum-tickets.js';
import { REST, Routes } from 'discord.js';

/**
 * SomniBot entry point.
 *
 * Boot sequence:
 * 0. Run database migrations (first boot only)
 * 1. Validate environment
 * 2. Connect Valkey
 * 3. Create SomniClient (Supabase + Shoukaku initialized)
 * 4. Register event handlers
 * 5. Login to Discord gateway
 * 6. Post-ready: auto-detect guild ID + initialize all systems
 */
async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  SomniBot v0.5.0 — Starting...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 0. Auto-migrate database on first boot
  try {
    const migrationResult = await runMigrations();
    if (migrationResult.ran && migrationResult.errors.length > 0) {
      console.error('[Boot] ⚠️  Migration errors — some features may not work');
    }
  } catch (err) {
    console.warn('[Boot] Migration check failed (non-fatal):', err);
  }

  // 0.5. Load missing config from instance_settings DB table
  try {
    await loadConfigFromDatabase();
  } catch (err) {
    console.warn('[Boot] Config DB fallback failed (non-fatal):', err);
  }

  // 0.75. Sync current env vars → instance_settings (so dashboard can see them)
  try {
    await syncConfigToDatabase();
  } catch (err) {
    console.warn('[Boot] Config sync-to-DB failed (non-fatal):', err);
  }

  // 1. Validate environment
  const config = loadConfig();
  console.log(`[Boot] Environment: ${config.NODE_ENV}`);
  console.log(`[Boot] Guild: ${config.DISCORD_GUILD_ID || '(auto-detect on ready)'}`);

  // 2. Connect Valkey
  try {
    await connectValkey();
  } catch (error) {
    console.warn('[Boot] Valkey connection failed — continuing without cache:', error);
  }

  // 3. Create client
  const client = new SomniClient();

  // 4. Register events
  registerEvents(client);

  // 5. Login
  console.log('[Boot] Connecting to Discord gateway...');
  await client.login(config.DISCORD_TOKEN);

  // 6. Post-ready initialization (wait for ready event)
  client.once('ready', async () => {
    console.log('[Boot] Discord ready — initializing systems...');

    // Auto-detect guild ID if not set
    if (!client.guildId) {
      const guilds = client.guilds.cache;
      if (guilds.size === 0) {
        console.error('[Boot] ❌ Bot is not in any guild. Invite the bot first, then restart.');
        console.log('[Boot] Waiting for guild... (bot will remain online for setup wizard)');
        return;
      }
      const detectedGuild = guilds.first()!;
      (client as unknown as Record<string, string>)._guildId = detectedGuild.id;
      // Override the guildId property
      Object.defineProperty(client, 'guildId', { value: detectedGuild.id, writable: false });
      console.log(`[Boot] 🔍 Auto-detected guild: ${detectedGuild.name} (${detectedGuild.id})`);
    }

    // Check bot role position
    const guild = client.guilds.cache.get(client.guildId);
    if (guild) {
      const roleCheck = await checkBotRolePosition(guild);
      if (roleCheck.isTopPosition) {
        console.log('[Boot] ✅ Bot role is at position #1');
      } else {
        console.warn(`[Boot] ⚠️  Bot role is NOT at position #1 (${roleCheck.rolesAboveBot.length} roles above)`);
        console.warn('[Boot] Features that modify roles/channels will be blocked.');
      }

      // Record bot role position to Supabase
      const botMember = guild.members.me;
      if (botMember) {
        await client.supabase
          .from('guild')
          .upsert({
            id: client.guildId,
            name: guild.name,
            owner_discord_id: guild.ownerId,
            bot_role_position: botMember.roles.highest.position,
            total_roles: guild.roles.cache.size,
          }, { onConflict: 'id' })
          .then(({ error }) => {
            if (error) console.error('[Boot] Failed to update guild record:', error.message);
            else console.log('[Boot] Guild record updated in Supabase');
          });
      }
    }

    // Register community-required channels in id_map so they don't appear as drift
    if (guild) {
      try {
        const communityIds: { key: string; discordId: string }[] = [];
        if (guild.rulesChannelId) {
          communityIds.push({ key: 'channel:rules', discordId: guild.rulesChannelId });
        }
        if (guild.publicUpdatesChannelId) {
          communityIds.push({ key: 'channel:public-updates', discordId: guild.publicUpdatesChannelId });
        }
        const modOnly = guild.channels.cache.find(
          (c) => c.name === 'moderator-only',
        );
        if (modOnly) {
          communityIds.push({ key: 'channel:moderator-only', discordId: modOnly.id });
        }

        if (communityIds.length > 0) {
          const rows = communityIds.map((c) => ({
            guild_id: guild.id,
            entity_type: 'channel',
            template_key: c.key,
            discord_id: c.discordId,
          }));

          await client.supabase
            .from('discord_id_map')
            .upsert(rows, { onConflict: 'guild_id,template_key' })
            .then(({ error }) => {
              if (error) console.warn('[Boot] Failed to register community channels:', error.message);
              else console.log(`[Boot] ✅ Registered ${communityIds.length} community channel(s) in id_map`);
            });
        }
      } catch (err) {
        console.warn('[Boot] Community channel registration failed (non-fatal):', err);
      }
    }

    // Start deploy listener
    startDeployListener(client);

    // Start guild live state snapshots + action queue listener
    if (guild) {
      const snapshotTimer = startPeriodicSnapshots(guild, client.supabase, 60_000);
      (client as unknown as Record<string, unknown>)._snapshotTimer = snapshotTimer;
      console.log('[Boot] ✅ Guild live state snapshots started (60s interval)');

      await startActionQueueListener(guild, client.supabase);
      console.log('[Boot] ✅ Bot action queue listener started');
    }

    // Start sync engine (Phase 5)
    if (guild) {
      const { data: syncConfigData } = await client.supabase
        .from('guild_config')
        .select('sync_enabled, sync_interval_minutes, sync_auto_repair, sync_auto_repair_everyone')
        .eq('guild_id', client.guildId)
        .maybeSingle();

      const syncConfig: SyncConfig = {
        enabled: syncConfigData?.sync_enabled ?? true,
        intervalMinutes: syncConfigData?.sync_interval_minutes ?? 15,
        autoRepair: syncConfigData?.sync_auto_repair ?? false,
        autoRepairEveryone: syncConfigData?.sync_auto_repair_everyone ?? true,
      };

      if (syncConfig.enabled) {
        const syncHandle = startSyncScheduler(guild, client.supabase, client.eventBus, syncConfig);
        console.log(`[Boot] ✅ Sync engine started (interval: ${syncConfig.intervalMinutes}m, auto-repair: ${syncConfig.autoRepair})`);

        // Store handle for cleanup
        (client as unknown as Record<string, unknown>)._syncHandle = syncHandle;
      } else {
        console.log('[Boot] ⏸️  Sync engine disabled in config');
      }
    }

    // Register slash commands (Phase 7: Tickets)
    await registerTicketCommands(client);

    // Phase 8: Automation Engine
    if (guild) {
      try {
        const automationEngine = new AutomationEngine(
          guild,
          client.supabase,
          client.valkey,
          client.eventBus,
        );
        await automationEngine.start();
        // Store reference for event handlers to use
        (client as unknown as Record<string, unknown>)._automationEngine = automationEngine;
        console.log('[Boot] ✅ Automation engine started');
      } catch (err) {
        console.error('[Boot] ⚠️  Automation engine failed to start:', err);
      }
    }

    // Phase 9: Levels, Reaction Roles, Custom Commands
    if (guild) {
      try {
        // Register /rank and /leaderboard slash commands
        const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
        const { rankCmd, leaderboardCmd } = buildLevelCommands();

        // Register level commands as guild commands
        try {
          await rest.post(
            Routes.applicationGuildCommands(client.user!.id, client.guildId),
            { body: rankCmd.toJSON() },
          );
          await rest.post(
            Routes.applicationGuildCommands(client.user!.id, client.guildId),
            { body: leaderboardCmd.toJSON() },
          );
          console.log('[Boot] ✅ Level commands registered (/rank, /leaderboard)');
        } catch (err) {
          console.error('[Boot] ⚠️  Failed to register level commands:', err);
        }

        // Initialize voice XP tracking
        await initVoiceTracking(guild);
        const voiceXpTimer = startVoiceXpTicker(
          guild,
          client.supabase,
          client.valkey,
          client.eventBus,
        );
        (client as unknown as Record<string, unknown>)._voiceXpTimer = voiceXpTimer;
        console.log('[Boot] ✅ Voice XP ticker started');

        // Load reaction roles into Valkey cache
        await loadReactionRoles(client.supabase, client.valkey, client.guildId);
        console.log('[Boot] ✅ Reaction roles cached');

        // Load custom commands and register with Discord
        await loadCustomCommands(client.supabase, guild, rest);
        console.log('[Boot] ✅ Custom commands loaded');
      } catch (err) {
        console.error('[Boot] ⚠️  Phase 9 initialization error:', err);
      }
    }

    // Phase 10: Community Features
    if (guild) {
      try {
        // Load guild config for Phase 10 feature flags
        const { data: guildConfig } = await client.supabase
          .from('guild_config')
          .select('temp_channels_enabled, stats_enabled, stats_update_interval_minutes, scheduled_messages_enabled, giveaways_enabled')
          .eq('guild_id', client.guildId)
          .maybeSingle();

        const rest10 = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

        // 10a: Temp Channels
        if (guildConfig?.temp_channels_enabled !== false) {
          const tempChannelManager = new TempChannelManager(guild, client.supabase);
          await tempChannelManager.start();
          (client as unknown as Record<string, unknown>)._tempChannelManager = tempChannelManager;

          // Register /voice command
          const voiceCmd = buildTempChannelCommands();
          await rest10.post(
            Routes.applicationGuildCommands(client.user!.id, client.guildId),
            { body: voiceCmd.toJSON() },
          );
          console.log('[Boot] ✅ Temp channels started + /voice command registered');
        }

        // 10b: Stats Channels
        if (guildConfig?.stats_enabled !== false) {
          const intervalMins = guildConfig?.stats_update_interval_minutes ?? 10;
          const statsManager = new StatsChannelManager(guild, client.supabase, intervalMins);
          await statsManager.start();
          (client as unknown as Record<string, unknown>)._statsManager = statsManager;
          console.log('[Boot] ✅ Stats channels started');
        }

        // 10c: Scheduled Messages
        if (guildConfig?.scheduled_messages_enabled !== false) {
          const scheduledRunner = new ScheduledMessageRunner(guild, client.supabase);
          await scheduledRunner.start();
          (client as unknown as Record<string, unknown>)._scheduledRunner = scheduledRunner;
          console.log('[Boot] ✅ Scheduled message runner started');
        }

        // 10d: Giveaways
        if (guildConfig?.giveaways_enabled !== false) {
          const giveawayManager = new GiveawayManager(
            guild,
            client.supabase,
            client.valkey,
            client.eventBus,
          );
          await giveawayManager.start();
          (client as unknown as Record<string, unknown>)._giveawayManager = giveawayManager;

          // Register /giveaway command
          const giveawayCmd = buildGiveawayCommands();
          await rest10.post(
            Routes.applicationGuildCommands(client.user!.id, client.guildId),
            { body: giveawayCmd.toJSON() },
          );
          console.log('[Boot] ✅ Giveaway manager started + /giveaway command registered');

          // Start giveaway prize fulfillment service
          const giveawayFulfillment = new GiveawayFulfillmentService(
            guild,
            client.supabase,
            client.eventBus,
          );
          giveawayFulfillment.start();
          (client as unknown as Record<string, unknown>)._giveawayFulfillment = giveawayFulfillment;
          console.log('[Boot] ✅ Giveaway fulfillment service started');
        }
      } catch (err) {
        console.error('[Boot] ⚠️  Phase 10 initialization error:', err);
      }
    }

    // Phase 11: Music System
    if (guild) {
      try {
        const { data: musicConfig } = await client.supabase
          .from('guild_config')
          .select('music_enabled')
          .eq('guild_id', client.guildId)
          .maybeSingle();

        if (musicConfig?.music_enabled !== false) {
          const musicPlayer = new MusicPlayerManager(
            guild,
            client.shoukaku,
            client.supabase,
            client.valkey,
            client.eventBus,
          );
          await musicPlayer.init();
          (client as unknown as Record<string, unknown>)._musicPlayer = musicPlayer;

          // Register music slash commands (individual POST to avoid clobbering other commands)
          const rest11 = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
          const musicCmds = buildMusicCommands();
          let registered = 0;
          for (const cmd of musicCmds) {
            try {
              await rest11.post(
                Routes.applicationGuildCommands(client.user!.id, client.guildId),
                { body: cmd.toJSON() },
              );
              registered++;
            } catch (regErr) {
              console.warn(`[Boot] ⚠️  Failed to register /${cmd.name}:`, regErr);
            }
          }
          console.log(`[Boot] ✅ Music system started + ${registered}/${musicCmds.length} commands registered (/play, /skip, /stop, /queue, /np, /volume, /loop, /shuffle, /seek, /remove, /pause, /filter)`);

          // Start music status reporter for dashboard now-playing widget
          const musicStatusReporter = new MusicStatusReporter(
            musicPlayer,
            client.supabase,
            client.guildId,
          );
          musicStatusReporter.start();
          (client as unknown as Record<string, unknown>)._musicStatusReporter = musicStatusReporter;
          console.log('[Boot] ✅ Music status reporter started (15s interval)');
        } else {
          console.log('[Boot] ⏸️  Music system disabled in config');
        }
      } catch (err) {
        console.error('[Boot] ⚠️  Phase 11 (Music) initialization error:', err);
      }
    }

    // Phase 12: Commerce & Universal Licensing
    if (guild) {
      try {
        const { data: commerceConfig } = await client.supabase
          .from('guild_config')
          .select('paypal_enabled')
          .eq('guild_id', client.guildId)
          .maybeSingle();

        if (commerceConfig?.paypal_enabled !== false) {
          const entitlementService = new EntitlementService(
            guild,
            client.supabase,
            client.eventBus,
          );
          (client as unknown as Record<string, unknown>)._entitlementService = entitlementService;

          // Register commerce slash commands
          const rest12 = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
          const commerceCmds = [buildStoreCommand(), buildLicenseCommand()];
          let registered = 0;
          for (const cmd of commerceCmds) {
            try {
              await rest12.post(
                Routes.applicationGuildCommands(client.user!.id, client.guildId),
                { body: cmd.toJSON() },
              );
              registered++;
            } catch (regErr) {
              console.warn(`[Boot] ⚠️  Failed to register /${cmd.name}:`, regErr);
            }
          }
          console.log(`[Boot] ✅ Commerce system started + ${registered}/${commerceCmds.length} commands registered (/store, /license)`);
        } else {
          console.log('[Boot] ⏸️  Commerce system disabled in config');
        }
      } catch (err) {
        console.error('[Boot] ⚠️  Phase 12 (Commerce) initialization error:', err);
      }
    }

    // Phase 13: Audit & Diagnostics
    try {
      const auditService = new AuditService(
        client.guildId,
        client.supabase,
        client.eventBus,
      );
      auditService.start();
      (client as unknown as Record<string, unknown>)._auditService = auditService;

      // Log bot start
      await auditService.log({
        action: 'bot.started',
        actorType: 'system',
        actorId: 'system',
        details: { version: '0.5.0' },
      });

      const diagnosticsService = new DiagnosticsService(client, client.supabase);
      diagnosticsService.start();
      (client as unknown as Record<string, unknown>)._diagnosticsService = diagnosticsService;

      console.log('[Boot] ✅ Phase 13 (Audit & Diagnostics) initialized');
    } catch (err) {
      console.error('[Boot] ⚠️  Phase 13 (Audit & Diagnostics) initialization error:', err);
    }

    // Phase 14: Moderation commands, Help, Context Menus, Config Watcher, Notifications
    if (guild) {
      try {
        const rest14 = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

        // 14a: Register moderation slash commands (/warn, /mute, /kick, /ban, /pardon, /infractions)
        const modCmds = buildModerationCommands();
        for (const cmd of Object.values(modCmds)) {
          try {
            await rest14.post(
              Routes.applicationGuildCommands(client.user!.id, client.guildId),
              { body: cmd.toJSON() },
            );
          } catch (regErr) {
            console.warn(`[Boot] ⚠️  Failed to register /${cmd.name}:`, regErr);
          }
        }
        console.log('[Boot] ✅ Moderation commands registered (/warn, /mute, /kick, /ban, /pardon, /infractions)');

        // 14b: Register /help command
        const helpCmd = buildHelpCommand();
        try {
          await rest14.post(
            Routes.applicationGuildCommands(client.user!.id, client.guildId),
            { body: helpCmd.toJSON() },
          );
          console.log('[Boot] ✅ /help command registered');
        } catch (regErr) {
          console.warn('[Boot] ⚠️  Failed to register /help:', regErr);
        }

        // 14c: Register context menu commands (View Profile, Warn User, View Purchases, Create Ticket, Report Message)
        const contextMenuCmds = buildContextMenuCommands();
        for (const cmd of contextMenuCmds) {
          try {
            await rest14.post(
              Routes.applicationGuildCommands(client.user!.id, client.guildId),
              { body: cmd.toJSON() },
            );
          } catch (regErr) {
            console.warn(`[Boot] ⚠️  Failed to register context menu "${cmd.name}":`, regErr);
          }
        }
        console.log(`[Boot] ✅ ${contextMenuCmds.length} context menu commands registered`);

        // 14d: Start ConfigWatcher for hot-reload from dashboard changes
        const configWatcher = new ConfigWatcher(
          guild,
          client.supabase,
          client.eventBus,
          client.valkey,
        );
        configWatcher.start();
        (client as unknown as Record<string, unknown>)._configWatcher = configWatcher;
        console.log('[Boot] ✅ ConfigWatcher started — dashboard changes hot-reload');

        // 14e: Start BotPresenceManager (rotating status)
        const presenceManager = new BotPresenceManager(
          client,
          client.guildId,
          client.supabase,
        );
        presenceManager.start();
        (client as unknown as Record<string, unknown>)._presenceManager = presenceManager;
        console.log('[Boot] ✅ BotPresenceManager started');

        // 14f: Start CrossFeatureBridge (GAP 3)
        const crossFeatureBridge = new CrossFeatureBridge(
          guild,
          client.supabase,
          client.eventBus,
          client.valkey,
        );
        crossFeatureBridge.start();
        (client as unknown as Record<string, unknown>)._crossFeatureBridge = crossFeatureBridge;
        console.log('[Boot] ✅ CrossFeatureBridge started — cross-feature events wired');

        // 14g: Start Discord Native services (GAP 5)
        const autoModSync = new AutoModSync(guild, client.supabase, client.eventBus);
        autoModSync.start();
        (client as unknown as Record<string, unknown>)._autoModSync = autoModSync;

        const guildOnboardingSync = new GuildOnboardingSync(guild, client.supabase, client.eventBus);
        guildOnboardingSync.start();
        (client as unknown as Record<string, unknown>)._guildOnboardingSync = guildOnboardingSync;

        const forumTicketService = new ForumTicketService(guild, client.supabase);
        (client as unknown as Record<string, unknown>)._forumTicketService = forumTicketService;
        console.log('[Boot] ✅ Discord Native services started (AutoMod sync, Onboarding sync, Forum tickets)');

        // 14h: Start OwnerNotificationService (DMs owner on critical events)
        const notificationService = new OwnerNotificationService(
          client,
          client.guildId,
          client.supabase,
          client.eventBus,
        );
        await notificationService.start();
        (client as unknown as Record<string, unknown>)._notificationService = notificationService;
        console.log('[Boot] ✅ Owner notification service started');
      } catch (err) {
        console.error('[Boot] ⚠️  Phase 14 initialization error:', err);
      }
    }

    console.log('[Boot] ✅ All systems initialized (Phases 3-14)');
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Bot] Received ${signal}, shutting down gracefully...`);
    // Stop snapshot timer
    const snapshotTimer = (client as unknown as Record<string, unknown>)._snapshotTimer as NodeJS.Timeout | undefined;
    if (snapshotTimer) clearInterval(snapshotTimer);
    // Stop sync scheduler
    const syncHandle = (client as unknown as Record<string, unknown>)._syncHandle as { stop: () => void } | undefined;
    if (syncHandle) syncHandle.stop();
    // Stop voice XP ticker
    const voiceXpTimer = (client as unknown as Record<string, unknown>)._voiceXpTimer as NodeJS.Timeout | undefined;
    if (voiceXpTimer) clearInterval(voiceXpTimer);
    // Stop Phase 10 managers
    const tempMgr = (client as unknown as Record<string, unknown>)._tempChannelManager as { stop?: () => void } | undefined;
    if (tempMgr?.stop) tempMgr.stop();
    const statsMgr = (client as unknown as Record<string, unknown>)._statsManager as { stop?: () => void } | undefined;
    if (statsMgr?.stop) statsMgr.stop();
    const schedRunner = (client as unknown as Record<string, unknown>)._scheduledRunner as { stop?: () => void } | undefined;
    if (schedRunner?.stop) schedRunner.stop();
    const giveawayMgr = (client as unknown as Record<string, unknown>)._giveawayManager as { stop?: () => void } | undefined;
    if (giveawayMgr?.stop) giveawayMgr.stop();
    // Phase 11: Stop music player + status reporter
    const musicPlayer = (client as unknown as Record<string, unknown>)._musicPlayer as { shutdown?: () => void } | undefined;
    if (musicPlayer?.shutdown) musicPlayer.shutdown();
    const musicReporter = (client as unknown as Record<string, unknown>)._musicStatusReporter as { stop?: () => void } | undefined;
    if (musicReporter?.stop) musicReporter.stop();
    // Phase 13: Stop audit & diagnostics
    const auditSvc = (client as unknown as Record<string, unknown>)._auditService as { stop?: () => void } | undefined;
    if (auditSvc?.stop) auditSvc.stop();
    const diagSvc = (client as unknown as Record<string, unknown>)._diagnosticsService as { stop?: () => void } | undefined;
    if (diagSvc?.stop) diagSvc.stop();
    // Cross-feature bridge + Discord native services
    const crossBridge = (client as unknown as Record<string, unknown>)._crossFeatureBridge as { stop?: () => void } | undefined;
    if (crossBridge?.stop) crossBridge.stop();
    const autoModSync = (client as unknown as Record<string, unknown>)._autoModSync as { stop?: () => void } | undefined;
    if (autoModSync?.stop) autoModSync.stop();
    client.shoukaku.nodes.forEach((node) => node.disconnect(1000, 'shutdown'));
    client.destroy();
    await client.valkey.quit().catch(() => {});
    console.log('[Bot] Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[Fatal] Failed to start SomniBot:', error);
  process.exit(1);
});
