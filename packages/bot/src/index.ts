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
import { SomniClient, getPrimaryDiscordGuildId } from './client.js';
import { registerEvents } from './events/handler.js';
import { connectValkey } from './services/valkey.js';
import { startDeployListener } from './deploy/deploy-listener.js';
import { GuildRouter } from './guild-router.js';
import { runMigrations } from './services/migration-runner.js';
import { requireSuccessfulMigrations } from './services/migration-startup-gate.js';
import { initGuildFeatures, registerGuildCommands } from './guild-init.js';
import { startHealthServer, setAwaitingSetup } from './services/health-server.js';
import { startDashboardSupervisor, stopDashboardSupervisor } from './services/dashboard-supervisor.js';
import { HeartbeatService } from './services/heartbeat.js';
import { evaluateSetupGate, createBootstrapSupabase } from './services/setup-gate.js';
import {
  runSetupVerificationBoot,
  writeGuildRecord,
  writeVerificationHealthSnapshot,
  resolveFinalizedGuildId,
} from './services/setup-verification-boot.js';
import {
  startSetupCompletionWatcher as startWatcher,
  startAwaitingSetupWatcher,
  type SetupCompletionWatcher,
} from './services/setup-completion-watcher.js';
import { decideBoot } from './services/boot-decision.js';
import { startLauncherIpcHeartbeat, stopLauncherIpcHeartbeat } from './services/launcher-ipc.js';
import { startAntiRaidPruner, stopAntiRaidPruner } from './features/anti-raid/index.js';
import {
  startTeamInvitationSweeper,
  stopTeamInvitationSweeper,
} from './features/team-invitations/index.js';
import { startPortalRequestNotifier } from './features/commerce/portal-request-notifier.js';
import { BotPresenceManager } from './features/discord-ux/index.js';
import { shutdownBot, type BotLevelServices } from './services/bot-shutdown.js';
import { acquireRuntimeLease, resolveRuntimeHolderId } from './services/runtime-lease.js';
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
  const migrationResult = await runMigrations();
  requireSuccessfulMigrations(migrationResult.errors);

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

  // 0.9. Startup setup gate — do not spam errors before owner setup is done.
  // Classify setup state (complete / in_progress / not_started) from
  // instance_settings so we can decide how far to boot. This runs BEFORE
  // loadConfig(): the 'not_started' case has no Discord token, and loadConfig()
  // would process.exit(1) on it — we want a clear, single, actionable message
  // and a clean "awaiting setup" idle instead.
  let setupGate = null as Awaited<ReturnType<typeof evaluateSetupGate>> | null;
  try {
    const bootstrapSupabase = createBootstrapSupabase();
    if (bootstrapSupabase) {
      setupGate = await evaluateSetupGate(bootstrapSupabase);
    }
  } catch (err) {
    log.warn('Setup gate evaluation failed (non-fatal, continuing)', { error: String(err) });
  }

  // ── Boot decision matrix ──
  // Reduce the setup-gate state to a single boot action + its transition-out
  // (see services/boot-decision.ts). Every non-terminal action wires exactly
  // one watcher so there is no terminal idle that never re-checks.
  const decision = setupGate ? decideBoot(setupGate) : null;

  if (decision && decision.action === 'idle_awaiting_setup') {
    // No Discord token yet — the bot has nothing to log in with. Log one clear
    // line and idle in an "awaiting setup" health state so a health watcher
    // sees a clean waiting status (rather than a crash loop from loadConfig
    // exiting on the missing token).
    //
    // Composition note: the desktop launcher forks the bot only AFTER Discord
    // credentials are collected, so a launcher-driven boot is never
    // 'not_started' — it's 'in_progress' or 'complete'. This branch is the
    // defensive path for a standalone `node dist/index.js` started with only
    // Supabase creds; we intentionally do NOT send the launcher IPC ready
    // signal here (there is no Discord client and the bot is not truly online).
    log.warn(setupGate!.message ?? 'Setup not complete — finish setup before the bot can run.');
    setAwaitingSetup({
      reason: 'Setup not complete — no Discord bot token configured yet.',
      dashboardUrl: setupGate!.dashboardUrl,
    });
    // The listening health server keeps the event loop alive so the process
    // idles (reporting awaiting_setup) until credentials arrive.
    startHealthServer(null);

    // This branch is precisely the one that waits for the DASHBOARD to supply
    // the missing Discord token, so it is the branch that most needs the
    // dashboard running. Starting it only on the configured-boot path meant a
    // first-time launch with just Supabase credentials idled forever behind a
    // dashboard the operator had to start themselves — the gap the supervisor
    // exists to close.
    await startDashboardSupervisor();

    // ── Transition-out: await_credentials (codex round-4 finding #2) ──
    // Do NOT idle forever. The dashboard's verify-discord step writes
    // `discord_bot_token` to instance_settings while this process is running;
    // because health is 200, a supervisor won't restart it, so without this
    // watcher first-time setup is stuck. Poll the gate; the moment a token
    // appears (state leaves 'not_started') reload it from the DB into env and
    // continue the boot in-process — no manual restart.
    startAwaitingSetupTransition();
    return;
  }

  // Credentials are present (in_progress or complete) — proceed into the
  // configured boot. Clear any stale awaiting-setup health flag first (this
  // path is also re-entered by the await_credentials watcher above once a token
  // arrives, so a prior idle state must not linger).
  setAwaitingSetup(null);
  await runConfiguredBoot();

  // ── Await-credentials transition wiring ──
  // Poll for a Discord token while idling in 'not_started'. When one appears,
  // reload config (DB→env) so loadConfig() below can see it, then continue into
  // the configured boot exactly once. Reuses the completion-watcher's
  // once-fire/stopped-guard lifecycle.
  function startAwaitingSetupTransition(): void {
    const bootstrapSupabase = createBootstrapSupabase();
    if (!bootstrapSupabase) {
      log.warn('Cannot watch for credentials — no bootstrap Supabase; a manual restart will be needed after setup.');
      return;
    }
    awaitingSetupWatcher = startAwaitingSetupWatcher(bootstrapSupabase, async () => {
      // A token arrived in instance_settings. Pull it (and any co-written
      // config) into process.env so loadConfig() sees a valid token instead of
      // exiting, then run the same configured-boot path a normally-credentialed
      // start would.
      try {
        await loadConfigFromDatabase();
      } catch (err) {
        log.warn('Config reload after credentials arrived failed (non-fatal)', { error: String(err) });
      }
      // Re-evaluate the gate now that the token is loaded so the configured boot
      // picks the right action (verification vs full) for the freshly-arrived
      // credentials.
      try {
        const refreshed = createBootstrapSupabase();
        if (refreshed) setupGate = await evaluateSetupGate(refreshed);
      } catch (err) {
        log.warn('Setup gate re-evaluation after credentials arrived failed (non-fatal)', { error: String(err) });
      }
      setAwaitingSetup(null);
      await runConfiguredBoot();
    });
  }

  /**
   * The credential-dependent boot: validate env, verify Supabase, connect
   * Valkey, create the client, log in, and wire post-ready init. Runs once
   * credentials are present — either directly on a normally-configured start or
   * from the await_credentials watcher after a token arrives mid-idle.
   */
  async function runConfiguredBoot(): Promise<void> {
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
    stopTeamInvitationSweeper,
  };
  let shutdownStarted = false;
  const shutdown = async (signal: string, exitCode: 0 | 1 = 0) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    stopSetupCompletionWatcher();
    stopAwaitingSetupWatcher();
    stopLauncherIpcHeartbeat();
    await stopDashboardSupervisor();
    await shutdownBot({ signal, client, botLevelServices, exitCode, dependencies: { log } });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const runtimeHolderId = resolveRuntimeHolderId(
    config.SOMNIBOT_RUNTIME_HOLDER_ID,
    config.DISCORD_APPLICATION_ID,
    config.SOMNIBOT_RUNTIME_MODE,
  );
  const runtimeLease = await acquireRuntimeLease({
    supabase: client.supabase,
    holderId: runtimeHolderId,
    mode: config.SOMNIBOT_RUNTIME_MODE,
    onLost: (reason) => {
      log.error(reason);
      // Stop Discord intake before draining services. The lease may expire
      // while cleanup runs, so a successor must not overlap gateway work.
      client.destroy();
      void shutdown('RUNTIME_LEASE_LOST', 1);
    },
  });
  botLevelServices.runtimeLease = runtimeLease;

  try {
    // 4. Register events
    registerEvents(client);

    // 5. Login
    log.info('Connecting to Discord gateway...');
    await client.login(config.DISCORD_TOKEN);
  } catch (error) {
    // A failed boot never leaves the alternate runtime waiting for TTL expiry.
    await runtimeLease.release();
    throw error;
  }

  // 5.5. Start health check HTTP server (V5 audit remediation — Finding 9.1)
  startHealthServer(client);

  // 5.6. Bring the web dashboard up alongside the bot. Setup configures a
  // dashboard URL (and points Supabase auth + PayPal callbacks at it), so the
  // dashboard needs to actually be running there — expecting the operator to
  // start a second process by hand is not workable when the bot lives on a VPS
  // and they are looking at it from a phone. No-ops when something is already
  // serving the port or when a container orchestrator owns that lifecycle.
  void startDashboardSupervisor();

  // 6. Post-ready initialization
  client.once(Events.ClientReady, async () => {
    log.info('Discord ready — initializing systems...');
    startLauncherIpcHeartbeat(client);

    // ── Setup gate: verification-only boot ──
    // Setup exists in the DB but is not finalized. The wizard needs the bot
    // reachable to verify "bot online" + "guild detected" before it can
    // finalize — so we DO come online, write the guild record, and heartbeat,
    // but we SKIP the heavy per-guild feature init that would spam errors
    // while config is incomplete. Once the owner finalizes setup, a poller
    // (started here) detects it and transitions this SAME process into the
    // full boot below — no manual restart required.
    //
    // Recompute the boot action from the current gate (the await_credentials
    // watcher may have refreshed setupGate after a token arrived), so this
    // branch is driven by the same decision function as the rest of the matrix.
    const readyDecision = setupGate ? decideBoot(setupGate) : null;
    if (readyDecision && readyDecision.action === 'verification_boot') {
      log.warn(setupGate!.message ?? 'Setup not complete — running in setup-verification mode.');

      // Flag verification mode so the normal Discord event handlers registered
      // in registerEvents() bail out. They are wired up (login must succeed for
      // the wizard's "bot online" check) but running member/message/reaction
      // pipelines now — against an empty router and missing guild_config — only
      // reproduces the pre-setup error noise this gate exists to suppress. The
      // full-boot transition clears this flag before enabling real features.
      client.setupVerificationMode = true;

      // Provide a real (empty) GuildRouter before returning. registerEvents()
      // has already scheduled periodic crons that unconditionally call
      // client.router.all() (see events/handler.ts). Without a router those
      // sweeps throw "Cannot read properties of undefined" every interval —
      // reintroducing the error spam this gate is meant to prevent. An empty
      // router's all() yields nothing, so the crons are harmless no-ops until
      // full boot replaces it. It is torn down on transition/shutdown.
      client.router = createGuildRouter(client);
      log.info('Empty GuildRouter installed for setup-verification mode (crons safe)');

      try {
        const verifyServices = await runSetupVerificationBoot(client);
        if (verifyServices) botLevelServices.heartbeat = verifyServices;
      } catch (err) {
        log.error('Setup-verification boot failed', { error: String(err) });
      }

      // ── Transition watcher: full boot once setup finalizes ──
      // The desktop launcher does NOT restart the bot when the dashboard writes
      // setup_completed_at, and the setup page only advances to its "done" step.
      // So without this, the owner finishes setup but the bot stays gated (no
      // GuildRouter features, commands, presence, diagnostics) until a manual
      // restart. Poll the gate; when it reports 'complete', tear down the
      // verification-only services and run the full boot in-process.
      startSetupCompletionWatcher(client, botLevelServices);
      return;
    }

    await runFullBoot(client, botLevelServices);
  });

  // ── New guild joined: auto-initialize via GuildRouter ──
  client.on('guildCreate', async (guild) => {
    log.info('Bot joined new guild', { name: guild.name, id: guild.id });

    // Setup-verification mode: full feature init is gated off (the router is
    // an empty placeholder). The owner commonly invites the bot mid-setup, so
    // we still write the guild record here — otherwise the wizard's "guild
    // detected" check would never see the just-invited guild and setup could
    // not finish. Keyed on the LIVE verification flag (not the static startup
    // gate) so that after the completion watcher transitions us out of
    // verification, a first guild joining drives the full boot below instead of
    // looping back into verification-only mode.
    if (client.setupVerificationMode && !fullBootStarted) {
      try {
        await writeGuildRecord(guild, client.supabase);
        // If the bot booted with no guilds, no verification heartbeat was
        // started. Now that a guild exists, start one so the wizard's
        // "bot online" check (which reads the bot-level heartbeat) can pass.
        // runSetupVerificationBoot also writes an immediate health row for this
        // guild, so the snapshot below is only needed on the else branch.
        if (!botLevelServices.heartbeat) {
          const verifyServices = await runSetupVerificationBoot(client);
          if (verifyServices) botLevelServices.heartbeat = verifyServices;
        } else {
          // A heartbeat already exists (an earlier guild started verification),
          // so runSetupVerificationBoot is NOT re-run here — which means the
          // periodic health refresher would not cover this newly-invited guild
          // until its next 60s tick. Write an immediate health snapshot for it
          // (codex round-3 finding #3): otherwise, with Valkey unavailable to
          // the dashboard, the setup route's Supabase fallback would see
          // guildDetected:true but botOnline:false for this guild right after
          // the invite and reject finalize until the refresher catches up.
          await writeVerificationHealthSnapshot(client.supabase, guild.id);
        }
      } catch (err) {
        log.error('Failed to record guild during setup verification', { id: guild.id, error: String(err) });
      }
      return;
    }

    // Deferred-boot case: a finalized bot that reached ClientReady with zero
    // guilds ran runFullBoot(), which installed a router and returned WITHOUT
    // starting the bot-level services (deploy listener, heartbeat, anti-raid
    // pruner, presence) or resolving a primary guild — it reset fullBootStarted
    // so a later guildCreate could complete boot. Now that the first guild has
    // joined, re-enter the full boot so those global services actually start;
    // otherwise the dashboard heartbeat and friends stay absent until a manual
    // restart. runFullBoot auto-detects the guild and is idempotent (guarded by
    // fullBootStarted), so a normal per-guild add still just gets its context.
    if (!fullBootStarted) {
      log.info('First guild joined after a guildless boot — completing full boot now', { id: guild.id });
      await runFullBoot(client, botLevelServices);
      return;
    }

    try {
      await client.router.getContext(guild.id);
      log.info('New guild initialized', { name: guild.name, id: guild.id });
    } catch (err) {
      log.error('Failed to initialize new guild', { name: guild.name, id: guild.id, error: String(err) });
    }
  });

  // ── Guild removed: destroy context ──
  client.on('guildDelete', async (guild) => {
    log.info('Bot removed from guild', { name: guild.name, id: guild.id });
    // In setup-verification mode the router is an empty placeholder with no
    // contexts to tear down.
    if (!client.router) return;
    try {
      await client.router.remove(guild.id);
    } catch (err) {
      log.error('Failed to destroy removed guild context', {
        guildId: guild.id,
        error: String(err),
      });
    }
  });

  } // end runConfiguredBoot
} // end main

/**
 * Construct a GuildRouter wired to the client's shared services, with the
 * per-guild feature-init callback. Used for both the normal full boot and the
 * empty placeholder installed during setup-verification mode.
 */
function createGuildRouter(client: SomniClient): GuildRouter {
  return new GuildRouter(
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
}

/** Guard so a mid-setup guildCreate does not double-run once full boot begins. */
let fullBootStarted = false;

/** Active setup-completion watcher (verification mode only), stopped on shutdown. */
let setupCompletionWatcher: SetupCompletionWatcher | null = null;

/**
 * Active awaiting-setup credential watcher (not_started idle only), stopped on
 * shutdown and once it fires the boot continuation. Ensures the 'not_started'
 * idle is never terminal — see startAwaitingSetupTransition in main().
 */
let awaitingSetupWatcher: SetupCompletionWatcher | null = null;

function stopAwaitingSetupWatcher(): void {
  awaitingSetupWatcher?.stop();
  awaitingSetupWatcher = null;
}

/**
 * Start watching for setup finalization while in verification mode. Once the
 * gate reports 'complete', tear down the verification-only services and run the
 * full boot in this same process, so the owner does not have to manually
 * restart the bot to get real features.
 */
function startSetupCompletionWatcher(
  client: SomniClient,
  botLevelServices: BotLevelServices,
): void {
  stopSetupCompletionWatcher();
  const bootstrapSupabase = createBootstrapSupabase();
  if (!bootstrapSupabase) {
    log.warn('Cannot watch for setup completion — no bootstrap Supabase; a manual restart will be needed after setup.');
    return;
  }

  setupCompletionWatcher = startWatcher(bootstrapSupabase, async () => {
    if (fullBootStarted) return;

    // Stop verification-only signals (heartbeat + health-snapshot refresher)
    // and drop the empty placeholder router before the full boot rebuilds it.
    try {
      botLevelServices.heartbeat?.stop();
    } catch (err) {
      log.warn('Failed stopping verification heartbeat during transition', { error: String(err) });
    }
    botLevelServices.heartbeat = null;
    try {
      await client.router?.destroyAll();
    } catch (err) {
      log.warn('Failed tearing down placeholder router during transition', { error: String(err) });
      return;
    }

    // Reload the freshly-finalized settings BEFORE the in-process full boot.
    // When the bot entered verification mode it had already run
    // loadConfigFromDatabase()/loadConfig() and cached process.env. The
    // finalize step then persisted the remaining credentials (PayPal,
    // deployment, guild) into instance_settings. Without re-reading them here,
    // the full boot would start with the stale pre-setup env — features that
    // read process.env (e.g. PAYPAL_CLIENT_ID) would stay unconfigured until a
    // manual restart, defeating the no-restart transition. Reload DB→env now so
    // full boot sees the finalized config.
    try {
      await loadConfigFromDatabase();
    } catch (err) {
      log.warn('Config reload before full-boot transition failed (non-fatal)', { error: String(err) });
    }

    // Re-resolve the primary guild from the FINALIZED config (codex round-3
    // finding #2 + round-4 finding #1). Verification mode may have provisionally
    // auto-detected the first cached guild, but the finalize step can specify a
    // DIFFERENT discord_guild_id. runFullBoot skips its own auto-detection when
    // client.guildId is already set, so without this override the bot-level
    // services (heartbeat, presence, deploy fallback, first-boot DM) would stay
    // anchored to the provisional/stale guild until a manual restart.
    //
    // Round-4 finding #1: we must NOT read the guild from process.env here.
    // loadConfigFromDatabase() only fills env vars that are MISSING, so when the
    // launcher started with DISCORD_GUILD_ID already in env and finalize submits
    // a DIFFERENT guild, the reload above leaves the STALE env value in place.
    // Read the finalized discord_guild_id straight from instance_settings so the
    // transition honors the value the owner actually finalized. Also mirror it
    // into process.env so downstream env readers see the finalized guild. Fall
    // back to whatever env holds only when the row is absent/unreadable.
    const finalizedGuildId =
      (await resolveFinalizedGuildId(client.supabase)) ??
      getPrimaryDiscordGuildId(process.env.DISCORD_GUILD_ID ?? '');
    if (finalizedGuildId) {
      process.env.DISCORD_GUILD_ID = finalizedGuildId;
    }
    if (finalizedGuildId && finalizedGuildId !== client.guildId) {
      log.info('Finalized config names a different primary guild — overriding provisional detection', {
        provisional: client.guildId || '(none)',
        configured: finalizedGuildId,
      });
      client.guildId = finalizedGuildId;
    }

    // Leave verification mode: the normal event handlers gate on this flag, so
    // clearing it lights up real feature processing as full boot builds it out.
    client.setupVerificationMode = false;

    await runFullBoot(client, botLevelServices);
  });
}

function stopSetupCompletionWatcher(): void {
  setupCompletionWatcher?.stop();
  setupCompletionWatcher = null;
}

/**
 * Full post-ready initialization: auto-detect the guild, build the GuildRouter,
 * init every guild's features/commands, and start bot-level services
 * (heartbeat, anti-raid pruner, presence). Runs either directly on ClientReady
 * for an already-finalized instance, or after the setup-completion watcher sees
 * setup finalize in a formerly-verification-mode process.
 */
async function runFullBoot(
  client: SomniClient,
  botLevelServices: BotLevelServices,
): Promise<void> {
  if (fullBootStarted) return;
  fullBootStarted = true;

  // ── Tear down any router installed by an earlier partial boot ──
  // Two placeholders can precede this function's router: the empty
  // verification-mode router (normally already destroyed by the transition
  // path — destroyAll() is idempotent, so re-destroying is harmless and covers
  // a failed transition teardown), and the guildless placeholder installed
  // below on a deferred boot. Codex round-3 finding #3: a later guildCreate
  // re-enters here and previously replaced that placeholder WITHOUT destroying
  // it, leaking its eviction interval for the life of the process. Destroy
  // before replacing — the crons calling client.router.all() stay safe because
  // a destroyed router simply has no contexts, and the real router is
  // installed below only after the prior router's async drains complete.
  if (client.router) {
    try {
      await client.router.destroyAll();
    } catch (err) {
      log.warn('Failed tearing down previous GuildRouter before full boot', { error: String(err) });
      fullBootStarted = false;
      return;
    }
  }

  // ── Auto-detect guild ID if not set ──
  if (!client.guildId) {
    const guilds = client.guilds.cache;
    if (guilds.size === 0) {
      log.error('Bot is not in any guild. Invite the bot first.');
      log.info('Waiting for guild... (bot will remain online; a guildCreate will drive full init)');
      // Ensure a real GuildRouter is present so the guildCreate handler's
      // getContext() path is safe once a guild is invited, and so the periodic
      // crons (which call client.router.all()) never touch an undefined router.
      client.router = createGuildRouter(client);
      // Not fatal: allow a later guildCreate to complete full init. Reset the
      // guard so re-entry can proceed once a guild is present.
      fullBootStarted = false;
      return;
    }
    const detectedGuild = guilds.first()!;
    Object.defineProperty(client, 'guildId', { value: detectedGuild.id, writable: false });
    log.info('Auto-detected guild', { name: detectedGuild.name, id: detectedGuild.id });
  }

  // ── Initialize GuildRouter with per-guild feature init callback ──
  // Replaces any empty placeholder router installed during verification mode.
  client.router = createGuildRouter(client);
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

      // Consent-based dashboard-team invitations: a process-wide worker that
      // delivers invitation DMs, mirrors acceptances to the owner, and expires
      // overdue invitations. Bot-level singleton (sweeps every guild's rows).
      startTeamInvitationSweeper(client, client.supabase);
      log.info('Team-invitation sweeper started');

      // Customer refund/support decisions: the dashboard decides but cannot
      // reach Discord, so the buyer's DM happens here. Without this the queue
      // moved and the customer was never told. Bot-level singleton.
      botLevelServices.portalRequestNotifier =
        startPortalRequestNotifier(client, client.supabase);
      log.info('Portal-request notifier started');

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
}

main().catch((error) => {
  log.error('Failed to start SomniBot', { error: String(error) });
  process.exit(1);
});
