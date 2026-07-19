/**
 * Ambient typing for the compiled @somnibot/bot modules the LIVE-STACK runner
 * (live-runner.ts) drives. Companion to bot-dispatcher.d.ts.
 *
 * @somnibot/bot is built with `declaration: false` (packages/bot/tsconfig.json),
 * so its `dist/` ships no `.d.ts`. testkit deliberately depends on the COMPILED
 * output (deep `dist/` imports, allowed because @somnibot/bot declares no
 * `exports` map), so these ambient declarations supply exactly the surface the
 * runner relies on — no more. Heavy infrastructure types testkit does not
 * itself depend on (the Supabase client, Valkey, the platform event bus) are
 * intentionally modeled loosely; the real contracts are exercised at runtime
 * against the live stack.
 *
 * This is the permitted testkit->bot edge (the isolation check forbids only the
 * reverse, bot->testkit).
 */

declare module '@somnibot/bot/dist/config.js' {
  /** Validates + memoizes the bot env (BotEnvSchema); throws/exits on invalid. */
  export function loadConfig(): unknown;
  export function getConfig(): unknown;
}

declare module '@somnibot/bot/dist/guild-context.js' {
  import type { Guild } from 'discord.js';
  export class GuildContext {
    readonly guildId: string;
    readonly guild: Guild;
    setManager<T>(key: string, manager: T): void;
    getManager<T>(key: string): T | undefined;
  }
}

declare module '@somnibot/bot/dist/guild-router.js' {
  import type { Client } from 'discord.js';
  import type { GuildContext } from '@somnibot/bot/dist/guild-context.js';
  export class GuildRouter {
    constructor(
      client: Client,
      supabase: unknown,
      valkey: unknown,
      eventBus: unknown,
      initCallback?: (ctx: GuildContext) => Promise<void>,
    );
    getContext(guildId: string): Promise<GuildContext>;
    getContextSync(guildId: string): GuildContext | undefined;
    destroyAll(): void;
  }
}

declare module '@somnibot/bot/dist/guild-init.js' {
  import type { GuildContext } from '@somnibot/bot/dist/guild-context.js';
  import type { SomniClient } from '@somnibot/bot/dist/client.js';
  /**
   * The REAL production per-guild bootstrap. Reads guild_config, honours the
   * economy_enabled gate, wires the per-guild managers (economy et al.), and
   * returns the slash commands the caller registers. The live runner drives this
   * directly so the proof exercises production wiring, not a re-implementation.
   */
  export function initGuildFeatures(ctx: GuildContext, client: SomniClient): Promise<unknown[]>;
}

declare module '@somnibot/bot/dist/client.js' {
  import type { Client } from 'discord.js';
  import type { GuildRouter } from '@somnibot/bot/dist/guild-router.js';
  /**
   * The real SomniClient — a discord.js Client plus platform infrastructure.
   * `supabase` is typed loosely (the runner/tests build real PostgREST queries
   * off it); `valkey` exposes only the socket teardown the runner calls.
   */
  export class SomniClient extends Client {
    constructor();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped here: testkit takes no direct @supabase/supabase-js dependency
    readonly supabase: any;
    readonly valkey: { disconnect(): void };
    readonly eventBus: unknown;
    guildId: string;
    router: GuildRouter;
  }
}

declare module '@somnibot/bot/dist/features/economy/index.js' {
  import type { Guild } from 'discord.js';
  /** The real fake-economy manager (wallets, rewards, transactions). */
  export class EconomyManager {
    constructor(guild: Guild, supabase: unknown, valkey: unknown);
  }
  /** Registers a manager in the module-level per-guild registry the dispatcher reads. */
  export function registerEconomyManager(mgr: EconomyManager, guildId: string): void;
}
