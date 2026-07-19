/**
 * Compile-time tie between the ambient live-stack declarations
 * (bot-live-stack.d.ts) and the exact shapes the live runner (live-runner.ts)
 * relies on. Companion to dispatcher-contract.ts.
 *
 * @somnibot/bot ships no `.d.ts` (declaration: false), so testkit hand-mirrors
 * each construct it drives in bot-live-stack.d.ts. Those mirrors can silently
 * drift from what the runner actually calls — and the live lane (the only thing
 * that loads the real bot JS) proves runtime shape but only in the gated CI job.
 * These assertions turn any *type* drift into a loud compile error under
 * `type-check` / `build` for every construct the runner touches:
 *   - SomniClient            (constructed, platform fields read, torn down),
 *   - GuildRouter            (constructed with the init callback; getContext,
 *                             getContextSync, destroyAll),
 *   - GuildContext           (guild/guildId read; setManager/getManager),
 *   - EconomyManager         (the manager the real init constructs),
 *   - registerEconomyManager (the module-level registry the real init calls),
 *   - initGuildFeatures      (the REAL per-guild bootstrap the runner drives).
 *
 * Each construct is pinned in BOTH directions (mirroring dispatcher-contract):
 *   - forward: the ambient-declared construct must SATISFY the shape the runner
 *     uses (a removed field / widened return / changed signature breaks here);
 *   - reverse: that shape must stay assignable BACK to the ambient declaration,
 *     so an added required parameter or a narrowed signature in
 *     bot-live-stack.d.ts also breaks compilation rather than passing vacuously.
 *
 * EconomyManager + registerEconomyManager are pinned even though the runner no
 * longer constructs them by hand (the REAL initGuildFeatures does) — they remain
 * the wiring the proof depends on, so their signatures must not drift unnoticed.
 */
import type { Client, Guild } from 'discord.js';
import { SomniClient } from '@somnibot/bot/dist/client.js';
import { GuildRouter } from '@somnibot/bot/dist/guild-router.js';
import { GuildContext } from '@somnibot/bot/dist/guild-context.js';
import { EconomyManager, registerEconomyManager } from '@somnibot/bot/dist/features/economy/index.js';
import { initGuildFeatures } from '@somnibot/bot/dist/guild-init.js';

// ── SomniClient — the platform surface the runner reads + tears down ──────────
export interface SomniClientContract {
  readonly supabase: unknown;
  readonly valkey: { disconnect(): void };
  readonly eventBus: unknown;
  guildId: string;
  router: GuildRouter;
}
// Forward: a real SomniClient instance must provide the contract surface.
const _clientForward = null as unknown as SomniClient;
void (_clientForward satisfies SomniClientContract);
// Reverse: each contract field must stay a real ambient field of the same type
// (removing/renaming one makes the Pick a compile error).
const _clientReverse: Pick<SomniClient, keyof SomniClientContract> =
  null as unknown as SomniClientContract;
void _clientReverse;

// ── GuildRouter — constructor shape + the methods the runner calls ────────────
export type GuildRouterCtor = new (
  client: Client,
  supabase: unknown,
  valkey: unknown,
  eventBus: unknown,
  initCallback?: (ctx: GuildContext) => Promise<void>,
) => GuildRouter;
const _routerCtorForward = GuildRouter satisfies GuildRouterCtor;
const _routerCtorReverse: typeof GuildRouter = null as unknown as GuildRouterCtor;
void _routerCtorForward;
void _routerCtorReverse;

export interface GuildRouterContract {
  getContext(guildId: string): Promise<GuildContext>;
  getContextSync(guildId: string): GuildContext | undefined;
  destroyAll(): void;
}
const _routerForward = null as unknown as GuildRouter;
void (_routerForward satisfies GuildRouterContract);
const _routerReverse: Pick<GuildRouter, keyof GuildRouterContract> =
  null as unknown as GuildRouterContract;
void _routerReverse;

// ── GuildContext — guild/guildId read + manager get/set ───────────────────────
export interface GuildContextContract {
  readonly guildId: string;
  readonly guild: Guild;
  setManager<T>(key: string, manager: T): void;
  getManager<T>(key: string): T | undefined;
}
const _ctxForward = null as unknown as GuildContext;
void (_ctxForward satisfies GuildContextContract);
const _ctxReverse: Pick<GuildContext, keyof GuildContextContract> =
  null as unknown as GuildContextContract;
void _ctxReverse;

// ── EconomyManager — the manager the real init constructs ─────────────────────
export type EconomyManagerCtor = new (guild: Guild, supabase: unknown, valkey: unknown) => object;
const _econForward = EconomyManager satisfies EconomyManagerCtor;
const _econReverse: typeof EconomyManager =
  null as unknown as (new (guild: Guild, supabase: unknown, valkey: unknown) => EconomyManager);
void _econForward;
void _econReverse;

// ── registerEconomyManager — the module-level registry the real init calls ────
export type RegisterEconomyManagerContract = (mgr: EconomyManager, guildId: string) => void;
const _regForward = registerEconomyManager satisfies RegisterEconomyManagerContract;
const _regReverse: typeof registerEconomyManager = null as unknown as RegisterEconomyManagerContract;
void _regForward;
void _regReverse;

// ── initGuildFeatures — the REAL per-guild bootstrap the runner drives ────────
export type InitGuildFeaturesContract = (ctx: GuildContext, client: SomniClient) => Promise<unknown[]>;
const _initForward = initGuildFeatures satisfies InitGuildFeaturesContract;
const _initReverse: typeof initGuildFeatures = null as unknown as InitGuildFeaturesContract;
void _initForward;
void _initReverse;
