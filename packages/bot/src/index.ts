import { loadConfig } from './config.js';
import { SomniClient } from './client.js';
import { registerEvents } from './events/handler.js';
import { connectValkey } from './services/valkey.js';
import { startDeployListener } from './deploy/deploy-listener.js';
import { checkBotRolePosition } from './guards/bot-role-guard.js';
import { startSyncScheduler, type SyncConfig } from './sync/sync-engine.js';

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

    console.log('[Boot] ✅ All Phase 3-5 systems initialized');
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Bot] Received ${signal}, shutting down gracefully...`);
    // Stop sync scheduler
    const syncHandle = (client as unknown as Record<string, unknown>)._syncHandle as { stop: () => void } | undefined;
    if (syncHandle) syncHandle.stop();
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
