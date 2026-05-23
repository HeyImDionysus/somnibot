/**
 * GuildContext — Per-guild state container for multi-guild support.
 *
 * V53 Phase 4 (Finding 4.3 — S-2)
 *
 * Holds guild-specific config, Supabase guild_id, Valkey prefix,
 * and references to per-guild feature managers. Created lazily by
 * GuildRouter on first event for a guild.
 */

import type { Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { PlatformEventBus } from './services/event-bus.js';

export interface GuildConfig {
  [key: string]: unknown;
}

export class GuildContext {
  public readonly guildId: string;
  public readonly guild: Guild;
  public readonly supabase: SupabaseClient;
  public readonly valkey: Valkey;
  public readonly eventBus: PlatformEventBus;
  public config: GuildConfig = {};

  /** Per-guild feature managers stored loosely — typed access via getManager() */
  private managers = new Map<string, unknown>();

  constructor(
    guild: Guild,
    supabase: SupabaseClient,
    valkey: Valkey,
    eventBus: PlatformEventBus,
  ) {
    this.guildId = guild.id;
    this.guild = guild;
    this.supabase = supabase;
    this.valkey = valkey;
    this.eventBus = eventBus;
  }

  /** Valkey key prefix for this guild */
  get valkeyPrefix(): string {
    return `guild:${this.guildId}:`;
  }

  /** Register a feature manager */
  setManager<T>(key: string, manager: T): void {
    this.managers.set(key, manager);
  }

  /** Retrieve a feature manager */
  getManager<T>(key: string): T | undefined {
    return this.managers.get(key) as T | undefined;
  }

  /** Load guild config from Supabase */
  async loadConfig(): Promise<void> {
    const { data } = await this.supabase
      .from('guild_config')
      .select('*')
      .eq('guild_id', this.guildId)
      .maybeSingle();

    if (data) {
      this.config = data;
    }
  }

  /** Destroy context — clean up timers, managers.
   *  Note: For full cleanup including service shutdown, use
   *  destroyGuildServices() from guild-init.ts before calling this.
   */
  destroy(): void {
    this.managers.clear();
  }
}
