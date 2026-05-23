/**
 * GuildRouter — Maps guild IDs to GuildContext instances.
 *
 * V53 Phase 4 (Finding 4.3 — S-2)
 *
 * Lazy initialization: contexts are created on first access.
 * For single-guild deployments, this is transparent — only one
 * context is ever created. For multi-guild, each guild gets its
 * own isolated context.
 *
 * Usage:
 *   const ctx = await router.getContext(guildId);
 *   const econMgr = ctx.getManager<EconomyManager>('economy');
 */

import type { Client, Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { PlatformEventBus } from './services/event-bus.js';
import { GuildContext } from './guild-context.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('GuildRouter');

/**
 * V5 Audit [14.2]: Idle timeout for guild contexts. Guilds with no events
 * for this duration are eligible for eviction to bound memory usage.
 * On next event, the context is re-created via the existing lazy-init path.
 */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const EVICTION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

export class GuildRouter {
  private contexts = new Map<string, GuildContext>();
  private initializing = new Map<string, Promise<GuildContext>>();
  /** Tracks last-access time per guild for LRU eviction */
  private lastAccess = new Map<string, number>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private client: Client,
    private supabase: SupabaseClient,
    private valkey: Valkey,
    private eventBus: PlatformEventBus,
    private initCallback?: (ctx: GuildContext) => Promise<void>,
  ) {
    // Start periodic eviction of idle guild contexts
    this.evictionTimer = setInterval(() => this.evictIdle(), EVICTION_CHECK_INTERVAL_MS);
  }

  /**
   * Get or create a GuildContext for the given guild ID.
   * Thread-safe: concurrent calls for the same guild will await
   * the same initialization promise.
   */
  async getContext(guildId: string): Promise<GuildContext> {
    // V5 Audit [14.2]: Update last-access timestamp for LRU eviction
    this.lastAccess.set(guildId, Date.now());

    const existing = this.contexts.get(guildId);
    if (existing) return existing;

    // Check if initialization is already in progress
    const pending = this.initializing.get(guildId);
    if (pending) return pending;

    // Start initialization
    const promise = this.initContext(guildId);
    this.initializing.set(guildId, promise);

    try {
      const ctx = await promise;
      this.contexts.set(guildId, ctx);
      return ctx;
    } finally {
      this.initializing.delete(guildId);
    }
  }

  /**
   * Get context synchronously — returns undefined if not yet initialized.
   * Use only when you know the guild has already been seen.
   */
  getContextSync(guildId: string): GuildContext | undefined {
    return this.contexts.get(guildId);
  }

  /**
   * Check if a context exists for a guild.
   */
  has(guildId: string): boolean {
    return this.contexts.has(guildId);
  }

  /**
   * Iterate over all active guild contexts.
   */
  all(): IterableIterator<GuildContext> {
    return this.contexts.values();
  }

  /**
   * Number of active guilds.
   */
  get size(): number {
    return this.contexts.size;
  }

  /**
   * Remove and destroy a guild context (e.g., bot removed from guild).
   */
  remove(guildId: string): void {
    const ctx = this.contexts.get(guildId);
    if (ctx) {
      ctx.destroy();
      this.contexts.delete(guildId);
      this.lastAccess.delete(guildId);
    }
  }

  /**
   * Destroy all contexts (shutdown).
   */
  destroyAll(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const ctx of this.contexts.values()) {
      ctx.destroy();
    }
    this.contexts.clear();
    this.lastAccess.clear();
  }

  /**
   * V5 Audit [14.2]: Evict idle guild contexts that haven't received
   * any events within IDLE_TIMEOUT_MS. Contexts are re-created lazily
   * on next event via getContext().
   */
  private evictIdle(): void {
    const now = Date.now();
    const toEvict: string[] = [];

    for (const [guildId, lastTime] of this.lastAccess) {
      if (now - lastTime > IDLE_TIMEOUT_MS && this.contexts.has(guildId)) {
        toEvict.push(guildId);
      }
    }

    for (const guildId of toEvict) {
      log.info('Evicting idle guild context', { guildId, idleMinutes: Math.round(IDLE_TIMEOUT_MS / 60_000) });
      this.remove(guildId);
    }
  }

  private async initContext(guildId: string): Promise<GuildContext> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      throw new Error(`Guild ${guildId} not in cache`);
    }

    const ctx = new GuildContext(guild, this.supabase, this.valkey, this.eventBus);
    await ctx.loadConfig();

    // Run init callback (registers feature managers etc.)
    if (this.initCallback) {
      await this.initCallback(ctx);
    }

    log.info('Initialized context', { guild: guild.name, guildId });
    return ctx;
  }
}

/**
 * Extract guild ID from a Discord.js interaction or event object.
 * Works for ChatInputCommandInteraction, ButtonInteraction, Message, etc.
 */
export function getGuildId(interactionOrEvent: { guildId?: string | null; guild?: Guild | null }): string {
  const guildId = interactionOrEvent.guildId ?? interactionOrEvent.guild?.id;
  if (!guildId) {
    throw new Error('Cannot determine guild ID from interaction/event — not in a guild context');
  }
  return guildId;
}
