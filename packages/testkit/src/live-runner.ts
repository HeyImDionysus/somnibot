/**
 * live-runner — boots the REAL SomniBot stack against the LOCAL disposable rig
 * so a DB-observable slash command can be driven end-to-end WITHOUT any Discord
 * credentials.
 *
 * This is the PR3 counterpart to the PR2 injector (inject.ts). Where the
 * injector is the guarded ingress that feeds a synthetic interaction into the
 * production dispatcher, this module stands up the client that dispatcher needs:
 *   - a real `SomniClient` (real `client.supabase` against LOCAL Supabase, real
 *     `client.valkey` created lazily, real `client.eventBus`, real `guildId`),
 *   - a real `GuildRouter` for one guild, and
 *   - the per-guild feature managers wired by the REAL production
 *     `initGuildFeatures` — the exact code path production runs.
 *
 * It deliberately does NOT call `client.login()` — there is no DISCORD_TOKEN and
 * no gateway. A DB-backed command (e.g. /balance, /daily) needs none of that: it
 * writes through the real `client.supabase`, so the REAL database effect is
 * observable and assertable. Real Discord-side readback (roles, channel
 * messages) is a LATER, credentialed phase — see the gated block in the live
 * test.
 *
 * ── Why drive the REAL `initGuildFeatures` (not an inline re-implementation)? ──
 * `initGuildFeatures` (packages/bot/src/guild-init.ts:118) is THE production
 * per-guild bootstrap: it reads `guild_config`, honours the
 * `if (guildCfg?.economy_enabled)` gate, constructs the `EconomyManager`,
 * `registerEconomyManager`s it, and `ctx.setManager('economy', …)` — the exact
 * wiring the dispatcher resolves through
 * `client.router.getContextSync(guildId).getManager('economy')`
 * (events/interaction-handler.ts). An earlier draft re-implemented those three
 * lines inline; that left the harness GREEN even if production's init regressed
 * (gate dropped, exception, registration change). Driving the real function
 * closes that fidelity gap: a regression in production init now turns this proof
 * RED.
 *
 * Running the real init in a gateway-less harness is made safe by two things the
 * production code already provides:
 *   1. Every Discord-REST-heavy feature (`temp_channels`, `stats`,
 *      `scheduled_messages`, `giveaways`, `music`, `commerce`, `sync`) is
 *      config-gated. We seed `guild_config` with those flags OFF and only
 *      `economy_enabled` ON, so their `.start()`s never run.
 *   2. The unconditional always-on services (guild snapshot timer, action-queue
 *      Realtime listener, automation engine, audit/diagnostics/alerts, config
 *      watcher, owner notifications, …) each do a fast DB read + register
 *      listeners/timers, and every Discord-REST or Valkey touch is either
 *      event-driven or fire-and-forget `.catch()`-guarded. With no local Redis
 *      the Valkey socket refuses fast (`maxRetriesPerRequest: 3`) and is caught;
 *      nothing blocks init. Teardown is the REAL `destroyGuildServices`
 *      (via `router.destroyAll()`), so the same timers/listeners production stops
 *      on guild-leave are stopped here. The one resource with no production stop
 *      API — the action-queue Realtime channel (process-lifetime by design,
 *      auto-reconnects on CLOSE) — is torn down best-effort in `cleanup()`; the
 *      vitest fork worker is terminated after the suite regardless (the test
 *      equivalent of production's process exit).
 *
 * The returned commands array from `initGuildFeatures` is intentionally NOT
 * registered to Discord (no gateway / dummy token) — the caller (index.ts) is
 * what does `registerGuildCommands`, which this harness deliberately omits.
 */

import { assertLoopbackAllowed, assertSupabaseUrlIsLocal } from './guard.js';
import { SomniClient } from '@somnibot/bot/dist/client.js';
import { loadConfig } from '@somnibot/bot/dist/config.js';
import { GuildRouter } from '@somnibot/bot/dist/guild-router.js';
import { initGuildFeatures } from '@somnibot/bot/dist/guild-init.js';
import type { GuildContext } from '@somnibot/bot/dist/guild-context.js';
import { Collection, type Guild } from 'discord.js';

/** The concrete Supabase client type, derived from the real client field so
 *  testkit takes no direct dependency on @supabase/supabase-js. */
type LiveSupabase = SomniClient['supabase'];

/** Raised when the live stack cannot be stood up (e.g. local Supabase down, or
 *  the bot env fails validation). Distinct class so tests can assert on a boot
 *  failure specifically. It is the SINGLE fail-loud channel — even a
 *  `loadConfig()` `process.exit(1)` on bad env is surfaced through it. */
export class LiveRunnerError extends Error {
  constructor(message: string) {
    super(`Live runner: ${message}`);
    this.name = 'LiveRunnerError';
  }
}

export interface BootstrapLiveOptions {
  /** Guild id to boot. Defaults to `process.env.DISCORD_GUILD_ID` (which the
   *  loopback guard already forces to equal the disposable guild id). */
  guildId?: string;
  /** Human-readable guild name for logs/records. */
  guildName?: string;
  /** Whether to seed `guild_config.economy_enabled`. Defaults to `true` (the
   *  economy is wired so /balance succeeds). Pass `false` to prove the REAL
   *  production gate — `initGuildFeatures` then does NOT wire the manager and
   *  /balance takes the "economy is not enabled" reply path. */
  economyEnabled?: boolean;
  /** Seeded into `guild_config.economy_starting_balance`; the wallet-init RPC
   *  (`economy_get_or_create_wallet`) uses it as the new wallet's balance, so a
   *  distinctive value lets a test assert the SAME number in the DB and reply. */
  economyStartingBalance?: number;
  /** Seeded currency display fields (asserted in the reply embed). */
  currencyEmoji?: string;
  currencyName?: string;
  /**
   * Extra `guild_config` columns merged into (and overriding) the seed this
   * runner writes before running the REAL `initGuildFeatures`. The bidirectional
   * validator (PR5) uses this to flip EVERY command-gating feature flag ON so it
   * can capture the full exposed slash set. Values here win over the runner's
   * own defaults (including the gateway-less `music/giveaways/... = false` seeds),
   * so a caller can deliberately opt into a feature the default keeps off.
   */
  guildConfigOverrides?: Record<string, unknown>;
}

/** The seeded economy config, echoed back so tests assert against known values. */
export interface SeededEconomy {
  readonly startingBalance: number;
  readonly currencyEmoji: string;
  readonly currencyName: string;
}

/**
 * A single application-command JSON body as returned by the REAL
 * `initGuildFeatures` (the authoritative EXPOSED set the caller would register
 * to Discord). Only the two fields the bidirectional validator reads are
 * modeled: the top-level command `name` (what the dispatcher matches — for a
 * subcommand-group command this is the parent name, its subcommands living in
 * nested `options`) and the `type` discriminator (ChatInput slash = 1 or
 * undefined; User/Message context menus = 2/3). The real bodies carry many more
 * fields; this is a structural subset the runtime objects satisfy.
 */
export interface ExposedCommand {
  readonly name: string;
  readonly type?: number;
}

export interface LiveClientHandle {
  /** The real, wired SomniClient (NOT logged in). */
  readonly client: SomniClient;
  /** The booted guild id. */
  readonly guildId: string;
  /** The real Supabase client (LOCAL), for DB-effect assertions. */
  readonly supabase: LiveSupabase;
  /** Whether this boot seeded `economy_enabled = true`. */
  readonly economyEnabled: boolean;
  /** The economy config this boot seeded into `guild_config`. */
  readonly economy: SeededEconomy;
  /**
   * The command bodies the REAL `initGuildFeatures` returned for this guild —
   * the authoritative EXPOSED set (exactly what index.ts would bulk-PUT to
   * Discord, minus the registration step this harness omits). Captured straight
   * from the production function's return value, so a drift between what the bot
   * registers and what its dispatcher handles surfaces here. Empty only if init
   * pushed nothing (which never happens: several commands are unconditional).
   */
  readonly commands: readonly ExposedCommand[];
  /** Dispose all resources: real per-guild teardown, router timers, Realtime
   *  channel, discord.js client, Valkey socket. */
  cleanup(): Promise<void>;
}

/**
 * Run the real `loadConfig()` (BotEnvSchema validation + memoization) but turn
 * its `process.exit(1)`-on-invalid-env into a `LiveRunnerError` so an invalid
 * env fails through the SAME loud channel as every other boot failure, instead
 * of tearing down the whole vitest process (finding 5). `loadConfig` calls
 * `process.exit` synchronously, so intercepting it around the call is safe and
 * fully restored in `finally`.
 */
function loadConfigOrThrow(): void {
  const realExit = process.exit;
  try {
    process.exit = ((code?: number): never => {
      throw new LiveRunnerError(
        `bot env validation failed — loadConfig() called process.exit(${code ?? 0}); ` +
          'check the loopback env (SUPABASE_URL, DISCORD_TOKEN, DISCORD_APPLICATION_ID, …)',
      );
    }) as typeof process.exit;
    loadConfig();
  } finally {
    process.exit = realExit;
  }
}

/**
 * Best-effort cross-check that the client's REAL Supabase target is local. The
 * env guard proves `process.env.SUPABASE_URL` is local; this proves the client
 * we actually built points there too (defense-in-depth, mirroring inject.ts).
 */
function assertClientSupabaseLocal(client: SomniClient): void {
  const supabase = client.supabase as unknown as {
    supabaseUrl?: unknown;
    rest?: { url?: unknown };
    realtimeUrl?: unknown;
  };
  const candidates = [supabase?.supabaseUrl, supabase?.rest?.url, supabase?.realtimeUrl];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      assertSupabaseUrlIsLocal(candidate, 'client.supabase target');
      return;
    }
  }
}

/**
 * Build a minimal discord.js-shaped `Guild` stand-in sufficient for the REAL
 * `initGuildFeatures` to run gateway-less. Without a login there is no real
 * guild in `client.guilds.cache`; the GuildRouter's `initContext` reads
 * `client.guilds.cache.get(guildId)`.
 *
 * The always-on services touch the guild only through caches + `.fetch()`:
 *   - `checkBotRolePosition` / the guild-record upsert short-circuit on
 *     `members.me === null` (no bot member without a gateway);
 *   - `startPeriodicSnapshots` → `writeGuildSnapshot` calls `roles.fetch()` /
 *     `channels.fetch()` then iterates the (empty) caches;
 *   - `initVoiceTracking` iterates `voiceStates.cache`;
 *   - `AutoModSync` reads `autoModerationRules`.
 * Empty `Collection`s + no-op `.fetch()`s keep every one of those on its
 * "nothing here" branch without a live connection. `members.me = null` is the
 * load-bearing field: it makes the role/permission and guild-record paths no-op.
 */
function makeMinimalGuild(guildId: string, guildName: string): Guild {
  const empty = <V>() => new Collection<string, V>();
  return {
    id: guildId,
    name: guildName,
    ownerId: 'e2e-live-owner',
    members: { me: null, cache: empty(), fetch: async () => empty() },
    channels: { cache: empty(), fetch: async () => empty() },
    roles: { cache: empty(), fetch: async () => empty() },
    voiceStates: { cache: empty() },
    autoModerationRules: { cache: empty(), fetch: async () => empty() },
  } as unknown as Guild;
}

/**
 * Stand up the live stack for one guild — driving the REAL production
 * `initGuildFeatures` — and return a handle.
 *
 * @throws LoopbackGuardError if the environment is not a disposable local rig.
 * @throws LiveRunnerError    on invalid bot env, or if the local Supabase is
 *                            unreachable (fail loud — NEVER a silent skip).
 */
export async function bootstrapLiveClient(
  options: BootstrapLiveOptions = {},
): Promise<LiveClientHandle> {
  // Gate: never build the live stack outside a disposable local rig.
  assertLoopbackAllowed();

  const guildId = options.guildId ?? process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    // The guard already requires DISCORD_GUILD_ID === the disposable guild id,
    // so this only trips if a caller passed an empty override.
    throw new LiveRunnerError('no guildId (set DISCORD_GUILD_ID or pass options.guildId)');
  }
  const guildName = options.guildName ?? 'SomniBot E2E Disposable Guild';
  const economyEnabled = options.economyEnabled ?? true;
  const economy: SeededEconomy = {
    startingBalance: options.economyStartingBalance ?? 500,
    currencyEmoji: options.currencyEmoji ?? '🪙',
    currencyName: options.currencyName ?? 'Coins',
  };

  // 1. Validate + memoize the bot env (BotEnvSchema). This is what the real boot
  //    (index.ts) does before `new SomniClient()`; SomniClient's constructor
  //    calls getConfig() which requires loadConfig() to have run. A bad env
  //    surfaces as a LiveRunnerError, not a process exit (finding 5).
  loadConfigOrThrow();

  // 2. Real client: real supabase (getSupabase → LOCAL), real valkey (getValkey,
  //    lazyConnect — no socket opened here), real eventBus, guildId. NO login.
  const client = new SomniClient();
  assertClientSupabaseLocal(client);

  // 3. Seed guild + guild_config. `economy_enabled` is the flag under test; the
  //    Discord-REST-heavy features that default ON in the schema
  //    (music/scheduled_messages/giveaways) and the sync scheduler are seeded
  //    OFF so real `initGuildFeatures` skips their gated `.start()`s in this
  //    gateway-less harness. (temp_channels/stats/paypal default OFF already.)
  //    This upsert is also the fail-loud reachability probe: if local Supabase
  //    is down the upsert errors and we throw a descriptive LiveRunnerError
  //    (never a silent skip), mirroring the bot integration helpers.
  const { error: guildErr } = await client.supabase
    .from('guild')
    .upsert({ id: guildId, name: guildName, owner_discord_id: 'e2e-live-owner' }, { onConflict: 'id' });
  if (guildErr) {
    await disposeClient(client);
    throw new LiveRunnerError(
      `failed seeding guild row — is local Supabase reachable at ${process.env.SUPABASE_URL}? (${guildErr.message})`,
    );
  }
  const { error: cfgErr } = await client.supabase
    .from('guild_config')
    .upsert(
      {
        guild_id: guildId,
        economy_enabled: economyEnabled,
        economy_starting_balance: economy.startingBalance,
        currency_emoji: economy.currencyEmoji,
        currency_name: economy.currencyName,
        // Keep the gateway-less harness to the economy path only — UNLESS a
        // caller (e.g. the bidirectional validator) opts back in via
        // guildConfigOverrides, which is spread last and therefore wins.
        music_enabled: false,
        scheduled_messages_enabled: false,
        giveaways_enabled: false,
        sync_enabled: false,
        ...(options.guildConfigOverrides ?? {}),
      },
      { onConflict: 'guild_id' },
    );
  if (cfgErr) {
    await disposeClient(client);
    throw new LiveRunnerError(`failed seeding guild_config: ${cfgErr.message}`);
  }

  // 4. Put the minimal guild in the cache so the router can resolve it (there is
  //    no gateway to populate it).
  client.guilds.cache.set(guildId, makeMinimalGuild(guildId, guildName));

  // 5. Real GuildRouter whose init callback is the REAL production per-guild
  //    bootstrap — the SAME closure index.ts installs (minus registerGuildCommands,
  //    which needs a gateway). initGuildFeatures reads guild_config, honours the
  //    economy_enabled gate, and — when enabled — constructs + registers the
  //    EconomyManager and stores it under `ctx.setManager('economy', …)`.
  // Capture the commands the REAL initGuildFeatures returns (the exposed set).
  // The init callback normally discards the return value the way index.ts hands
  // it to registerGuildCommands; we keep it so the bidirectional validator can
  // compare it against the dispatch manifest without re-implementing anything.
  let capturedCommands: readonly ExposedCommand[] = [];
  const router = new GuildRouter(
    client,
    client.supabase,
    client.valkey,
    client.eventBus,
    async (ctx: GuildContext) => {
      capturedCommands = (await initGuildFeatures(ctx, client)) as readonly ExposedCommand[];
    },
  );
  client.router = router;

  // 6. Initialize the guild context (runs the real init above). After this,
  //    `client.router.getContextSync(guildId).getManager('economy')` — the exact
  //    lookup the production dispatcher performs — resolves the manager IFF the
  //    real gate wired it.
  try {
    await router.getContext(guildId);
  } catch (err) {
    await disposeRouter(router, client);
    await disposeClient(client);
    throw new LiveRunnerError(`guild context init failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let cleaned = false;
  return {
    client,
    guildId,
    supabase: client.supabase,
    economyEnabled,
    economy,
    commands: capturedCommands,
    async cleanup(): Promise<void> {
      if (cleaned) return;
      cleaned = true;
      await disposeRouter(router, client);
      await disposeClient(client);
    },
  };
}

/**
 * Tear down the router via the REAL `destroyGuildServices` (router.destroyAll()):
 * clears the eviction interval, stops every tracked per-guild timer/service, and
 * unregisters the module-level managers — identical to a production guild-leave.
 *
 * The action-queue listener additionally opens a Supabase Realtime channel that
 * has NO production stop API (it is process-lifetime by design and auto-
 * reconnects on CLOSE). Best-effort remove-channels + transport disconnect keeps
 * the socket from lingering; the vitest fork worker is terminated after the
 * suite regardless (the test-time equivalent of production's process exit).
 */
async function disposeRouter(router: GuildRouter, client: SomniClient): Promise<void> {
  try {
    router.destroyAll();
  } catch {
    // Best-effort teardown — a failure here must not mask a test result.
  }
  try {
    await client.supabase.removeAllChannels();
  } catch {
    /* no channels / already torn down */
  }
  try {
    client.supabase.realtime?.disconnect();
  } catch {
    /* transport not connected */
  }
}

/** Tear down the client + Valkey socket. `disconnect()` is safe whether or not
 *  the lazy Valkey connection was ever opened (unlike `quit()`, which needs a
 *  live socket). */
async function disposeClient(client: SomniClient): Promise<void> {
  try {
    client.valkey.disconnect();
  } catch {
    /* not connected — nothing to close */
  }
  try {
    await client.destroy();
  } catch {
    /* client was never logged in — destroy is best-effort */
  }
}
