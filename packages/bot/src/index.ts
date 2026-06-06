// Provide WebSocket for Node.js < 22 (Electron's bundled Node 20).
// ws is a transitive dependency from discord.js — we polyfill globalThis.WebSocket
// so @supabase/realtime-js can find it without requiring the transport option on
// every createClient() call. This must be the first import to run before any
// Supabase client is created.
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    globalThis.WebSocket = _require('ws');
  } catch {
    // ws not available — Supabase realtime will error later if needed
  }
}

import { loadConfig } from './config.js';
import { loadConfigFromDatabase, syncConfigToDatabase } from './services/config-loader.js';
import { SomniClient } from './client.js';
import { registerEvents } from './events/handler.js';
import { connectValkey } from './services/valkey.js';
import { startDeployListener } from './deploy/deploy-listener.js';
import { GuildRouter } from './guild-router.js';
import { runMigrations } from './services/migration-runner.js';
import { initGuildFeatures, registerGuildCommands, destroyGuildServices } from './guild-init.js';
import { startHealthServer } from './services/health-server.js';
import { HeartbeatService } from './services/heartbeat.js';
import { startAntiRaidPruner, stopAntiRaidPruner } from './features/anti-raid/index.js';
import { BotPresenceManager } from './features/discord-ux/index.js';
import { shutdownBot, type BotLevelServices } from './services/bot-shutdown.js';
import { EmbedBuilder, Events } from 'discord.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Boot');

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
 * 6. Post-ready: GuildRouter initializes features per-guild
 *
 * Multi-guild: The GuildRouter lazily initializes feature managers for
 * each guild the bot is in. The primary guild is initialized at startup;
 * additional guilds are initialized on first event via the initCallback.
 * New guilds joined after boot are initialized via the guildCreate event.
 */
async function main(): Promise<void> {
  log.info('━━━ SomniBot v0.5.0 — Starting ━━━');

  // 0. Auto-migrate database on first boot
  try {
    const migrationResult = await runMigrations();
    if (migrationResult.ran && migrationResult.errors.length > 0) {
      log.error('Migration errors — some features may not work');
    }
  } catch (err) {
    log.warn('Migration check failed (non-fatal)', { error: String(err) });
  }

  // 0.5. Load missing config from instance_settings DB table
  try {
    await loadConfigFromDatabase();
  } catch (err) {
    log.warn('Config DB fallback failed (non-fatal)', { error: String(err) });
  }

  // 0.75. Sync current env vars → instance_settings (so dashboard can see them)
  try {
    await syncConfigToDatabase();
  } catch (err) {
    log.warn('Config sync-to-DB failed (non-fatal)', { error: String(err) });
  }

  // 1. Validate environment
  const config = loadConfig();
  log.info('Environment loaded', { env: config.NODE_ENV, guild: config.DISCORD_GUILD_ID || '(auto-detect)' });

  // 1.5. Verify Supabase is reachable before proceeding
  // Without Supabase, every feature (commands, config, heartbeat, deploy) fails
  // individually with cryptic errors. Fail fast with a clear message instead.
  try {
    const healthRes = await fetch(`${config.SUPABASE_URL}/rest/v1/`, {
      method: 'HEAD',
      headers: {
        apikey: config.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${config.SUPABASE_SECRET_KEY}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!healthRes.ok) {
      log.error(
        `Supabase returned ${healthRes.status} — check SUPABASE_URL and SUPABASE_SECRET_KEY`,
      );
      process.exit(1);
    }
    log.info('Supabase reachable');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Cannot reach Supabase at ${config.SUPABASE_URL}: ${msg}`);
    log.error(
      'The bot requires a working Supabase connection. Verify your SUPABASE_URL and network, then restart.',
    );
    process.exit(1);
  }

  // 2. Connect Valkey
  try {
    await connectValkey();
  } catch (error) {
    log.warn('Valkey connection failed — continuing without cache', { error: String(error) });
  }

  // 3. Create client
  const client = new SomniClient();
  const botLevelServices: BotLevelServices = {
    stopAntiRaidPruner,
  };

  // 4. Register events
  registerEvents(client);

  // 5. Login
  log.info('Connecting to Discord gateway...');
  await client.login(config.DISCORD_TOKEN);

  // 5.5. Start health check HTTP server (V5 audit remediation — Finding 9.1)
  startHealthServer(client);

  // 6. Post-ready initialization
  client.once(Events.ClientReady, async () => {
    log.info('Discord ready — initializing systems...');

    // ── Auto-detect guild ID if not set ──
    if (!client.guildId) {
      const guilds = client.guilds.cache;
      if (guilds.size === 0) {
        log.error('Bot is not in any guild. Invite the bot first, then restart.');
        log.info('Waiting for guild... (bot will remain online for setup wizard)');
        return;
      }
      const detectedGuild = guilds.first()!;
      Object.defineProperty(client, 'guildId', { value: detectedGuild.id, writable: false });
      log.info('Auto-detected guild', { name: detectedGuild.name, id: detectedGuild.id });
    }

    // ── Initialize GuildRouter with per-guild feature init callback ──
    client.router = new GuildRouter(
      client,
      client.supabase,
      client.valkey,
      client.eventBus,
      async (ctx) => {
        // This callback runs once per guild when first accessed.
        // It registers all feature managers, timers, and services.
        const commands = await initGuildFeatures(ctx, client);
        await registerGuildCommands(client, ctx.guildId, commands);
      },
    );
    log.info('GuildRouter initialized with multi-guild initCallback');

    // ── Start deploy listener (global, not per-guild) ──
    startDeployListener(client);

    // ── Initialize primary guild through the router ──
    // This triggers the initCallback above, which sets up all feature
    // managers, registers slash commands, and starts services.
    try {
      await client.router.getContext(client.guildId);
      log.info('Primary guild initialized through GuildRouter');

      // V5 Fix #9: Bot-level heartbeat (replaces per-guild heartbeat timers)
      const botHeartbeat = new HeartbeatService(client.valkey, client.supabase, client.guildId, client);
      botHeartbeat.start();
      botLevelServices.heartbeat = botHeartbeat;
      log.info('Bot-level heartbeat started');

      // V10 Audit L-3: Anti-raid pruner is process-wide (idempotent singleton).
      // Start once at bot level instead of per-guild in guild-init.ts.
      startAntiRaidPruner();
      log.info('Anti-raid pruner started');

      // V10 Audit L-4: BotPresenceManager sets client-wide presence.
      // Create once at bot level (using primary guild for config/member count).
      const botPresence = new BotPresenceManager(client, client.guildId, client.supabase);
      botPresence.start();
      botLevelServices.presence = botPresence;
      log.info('Bot-level presence rotation started');
    } catch (err) {
      log.error('Primary guild initialization failed', { error: String(err) });
    }

    // ── Initialize all other guilds the bot is already in ──
    const otherGuilds = client.guilds.cache.filter((g) => g.id !== client.guildId);
    if (otherGuilds.size > 0) {
      log.info('Initializing additional guilds', { count: otherGuilds.size });
      for (const [guildId, guild] of otherGuilds) {
        try {
          await client.router.getContext(guildId);
          log.info('Additional guild initialized', { name: guild.name, id: guildId });
        } catch (err) {
          log.error('Failed to initialize guild', { name: guild.name, id: guildId, error: String(err) });
        }
      }
    }

    // Store command registry for /help (from primary guild context)
    const primaryCtx = client.router.getContextSync(client.guildId);
    if (primaryCtx) {
      const commands = primaryCtx.getManager<import('discord.js').RESTPostAPIApplicationCommandsJSONBody[]>('_commands');
      if (commands) {
        client._registeredCommands = commands;
      }
    }

    log.info('All guilds initialized', { totalGuilds: client.router.size });

    // ── First-boot DM to guild owner ──
    try {
      const { data: dmFlag } = await client.supabase
        .from('instance_settings')
        .select('value')
        .eq('key', 'first_boot_dm_sent')
        .single();

      if (!dmFlag) {
        const ownerGuild = client.guilds.cache.get(client.guildId);
        if (ownerGuild) {
          const owner = await ownerGuild.fetchOwner().catch(() => null);
          if (owner) {
            const embed = new EmbedBuilder()
              .setColor(0xFF1493)
              .setTitle('🌙 SomniBot is Online!')
              .setDescription(
                `Your bot is now running in **${ownerGuild.name}**. Here's what to do next:`,
              )
              .addFields(
                {
                  name: '1️⃣  Run the Setup Wizard',
                  value: 'Type `/setup` in any channel to configure optional services like PayPal and deployment.',
                },
                {
                  name: '2️⃣  Open the Dashboard',
                  value: 'Visit **http://localhost:3456** in your browser to manage everything from a web UI.',
                },
                {
                  name: '3️⃣  Explore Commands',
                  value: 'Type `/help` to see all available commands, or check the dashboard for a full overview.',
                },
              )
              .setFooter({ text: 'This message is sent once on first boot.' })
              .setTimestamp();

            await owner.send({ embeds: [embed] }).catch(() => {
              log.warn('Could not DM guild owner (DMs may be disabled)');
            });
            log.info('Sent first-boot welcome DM to guild owner');
          }
        }

        await Promise.resolve(
          client.supabase
            .from('instance_settings')
            .upsert({ key: 'first_boot_dm_sent', value: 'true', section: 'boot' }),
        ).catch((e: unknown) => {
          log.warn('Failed to mark first-boot DM as sent', { error: String(e) });
        });
      }
    } catch (err) {
      log.warn('First-boot DM check skipped', { error: (err as Error).message });
    }
  });

  // ── New guild joined: auto-initialize via GuildRouter ──
  client.on('guildCreate', async (guild) => {
    log.info('Bot joined new guild', { name: guild.name, id: guild.id });
    try {
      await client.router.getContext(guild.id);
      log.info('New guild initialized', { name: guild.name, id: guild.id });
    } catch (err) {
      log.error('Failed to initialize new guild', { name: guild.name, id: guild.id, error: String(err) });
    }
  });

  // ── Guild removed: destroy context ──
  client.on('guildDelete', (guild) => {
    log.info('Bot removed from guild', { name: guild.name, id: guild.id });
    const ctx = client.router.getContextSync(guild.id);
    if (ctx) {
      destroyGuildServices(ctx);
      client.router.remove(guild.id);
    }
  });

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    await shutdownBot({ signal, client, botLevelServices, dependencies: { log } });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  log.error('Failed to start SomniBot', { error: String(error) });
  process.exit(1);
});
