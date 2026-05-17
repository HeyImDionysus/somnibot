import { loadConfig } from './config.js';
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
import { REST, Routes } from 'discord.js';

/**
 * SomniBot entry point.
 *
 * Boot sequence:
 * 1. Validate environment
 * 2. Connect Valkey
 * 3. Create SomniClient (Supabase + Shoukaku initialized)
 * 4. Register event handlers
 * 5. Login to Discord gateway
 * 6. Post-ready: bot role guard + deploy listener
 */
async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  SomniBot v0.3.0 — Starting...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Validate environment
  const config = loadConfig();
  console.log(`[Boot] Environment: ${config.NODE_ENV}`);
  console.log(`[Boot] Guild: ${config.DISCORD_GUILD_ID}`);

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
    console.log('[Boot] Discord ready — initializing Phase 3 systems...');

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

    // Start deploy listener
    startDeployListener(client);

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

    console.log('[Boot] ✅ All Phase 3-9 systems initialized');
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Bot] Received ${signal}, shutting down gracefully...`);
    // Stop sync scheduler
    const syncHandle = (client as unknown as Record<string, unknown>)._syncHandle as { stop: () => void } | undefined;
    if (syncHandle) syncHandle.stop();
    // Stop voice XP ticker
    const voiceXpTimer = (client as unknown as Record<string, unknown>)._voiceXpTimer as NodeJS.Timeout | undefined;
    if (voiceXpTimer) clearInterval(voiceXpTimer);
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
