/**
 * Config Watcher — Hot-reload bot configuration when dashboard makes changes.
 *
 * Listens for `config.changed` events from the event bus (triggered by
 * the action queue's `config_reload` action) and reloads the relevant
 * configuration section without requiring a bot restart.
 *
 * Sections:
 * - 'moderation' → reload automod rules, infraction config
 * - 'levels' → reload XP rates, level-up rewards
 * - 'welcome' → reload welcome/goodbye messages
 * - 'onboarding' → reload onboarding / member role config
 * - 'commerce' → reload store config
 * - 'music' → reload music config
 * - 'tickets' → reload ticket panels
 * - 'automations' → reload automation rules
 * - 'reaction-roles' → reload reaction role mappings
 * - 'giveaways' → reload giveaway config
 * - 'temp-channels' → reload temp channel hubs
 * - 'scheduled-messages' → reload scheduled message rules
 * - 'custom-commands' → reload custom command definitions
 * - 'stats-channels' → reload stats channel config
 * - 'embeds' → reload saved embed templates
 * - 'branding' → invalidate the white-label brand kit cache
 * - 'settings' → reload instance-wide settings (full reload)
 * - 'all' → full config reload
 */
import type { Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from './event-bus.js';
import type Valkey from 'iovalkey';
import { invalidateLevelCaches } from '../features/levels/index.js';
import { invalidateAntiRaidCache } from '../features/anti-raid/index.js';
import { invalidateStarboardCache } from '../features/starboard/index.js';
import { invalidateMessageLogCache } from '../features/message-log/index.js';
import { invalidateEconomyCache } from '../features/economy/index.js';
import { invalidateGatheringCache } from '../features/gathering/index.js';
import { invalidateCraftingCache } from '../features/crafting/index.js';
import { invalidateFarmingCache } from '../features/farming/index.js';
import { invalidateFishingCache } from '../features/fishing/index.js';
import { invalidateAdventureCache } from '../features/adventures/index.js';
import { invalidateMarketCache } from '../features/market/index.js';
import { invalidateTriviaCache } from '../features/trivia/index.js';
import { invalidateGamesCache } from '../features/games/index.js';
import { invalidateLotteryCache } from '../features/lottery/index.js';
import { invalidatePollsCache } from '../features/polls/index.js';
import { invalidatePetsCache } from '../features/pets/index.js';
import { invalidateQuestsCache } from '../features/quests/index.js';
import { invalidateAchievementsCache } from '../features/achievements/index.js';
import { invalidateProfilesCache } from '../features/profiles/index.js';
import { invalidateHeistCache } from '../features/heist/index.js';
import { invalidateBrandKitCache } from '../features/branding/index.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('ConfigWatcher');

interface ConfigCache {
  guildConfig: Record<string, unknown> | null;
  /** Per-section last-reload timestamps — prevents dropping reloads for different sections */
  sectionLastReload: Map<string, number>;
}

export class ConfigWatcher {
  private cache: ConfigCache = { guildConfig: null, sectionLastReload: new Map() };
  private reloadCooldownMs = 2000; // Don't reload same section more than once every 2 seconds

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus,
    private valkey: Valkey,
  ) {}

  /**
   * Start listening for config changes.
   */
  start(): void {
    this.eventBus.on('config.changed', async (event) => {
      if (event.guildId !== this.guild.id) return;

      const section = event.data.section;
      const now = Date.now();

      // Per-section cooldown to prevent rapid reloads of the SAME section,
      // while still processing different sections that arrive close together.
      const lastReload = this.cache.sectionLastReload.get(section) ?? 0;
      if (now - lastReload < this.reloadCooldownMs) {
        log.info(`Skipping reload (cooldown) — section: ${section}`);
        return;
      }

      log.info(`Config changed: ${section} (by ${event.data.changedBy})`);
      this.cache.sectionLastReload.set(section, now);

      try {
        switch (section) {
          case 'moderation':
            await this.reloadModeration();
            break;
          case 'levels':
            await this.reloadLevels();
            break;
          case 'welcome':
            await this.reloadWelcome();
            break;
          case 'commerce':
            await this.reloadCommerce();
            break;
          case 'music':
            await this.reloadMusic();
            break;
          case 'tickets':
            await this.reloadTickets();
            break;
          case 'automations':
            await this.reloadAutomations();
            break;
          case 'onboarding':
            await this.reloadOnboarding();
            break;
          case 'reaction-roles':
            await this.reloadReactionRoles();
            break;
          case 'giveaways':
            await this.reloadGiveaways();
            break;
          case 'temp-channels':
            await this.reloadTempChannels();
            break;
          case 'scheduled-messages':
            await this.reloadScheduledMessages();
            break;
          case 'custom-commands':
            await this.reloadCustomCommands();
            break;
          case 'stats-channels':
            await this.reloadStatsChannels();
            break;
          case 'embeds':
            await this.reloadEmbeds();
            break;
          case 'settings':
            await this.reloadAll();
            break;
          case 'economy':
            invalidateEconomyCache(this.guild.id);
            invalidateGatheringCache(this.guild.id);
            invalidateCraftingCache(this.guild.id);
            invalidateFarmingCache(this.guild.id);
            invalidateFishingCache(this.guild.id);
            invalidateAdventureCache(this.guild.id);
            invalidateMarketCache(this.guild.id);
            invalidateTriviaCache(this.guild.id);
            invalidateGamesCache(this.guild.id);
            invalidateLotteryCache(this.guild.id);
            invalidatePollsCache(this.guild.id);
            invalidatePetsCache(this.guild.id);
            invalidateQuestsCache(this.guild.id);
            invalidateAchievementsCache(this.guild.id);
            invalidateProfilesCache(this.guild.id);
            invalidateHeistCache(this.guild.id);
            log.info('Economy/Gathering/Crafting/Farming config cache invalidated');
            break;
          case 'branding':
            invalidateBrandKitCache(this.guild.id);
            log.info('Brand kit cache invalidated');
            break;
          case 'all':
            await this.reloadAll();
            break;
          default:
            // Unknown section — do a full reload to be safe
            await this.reloadGuildConfig();
            break;
        }
      } catch (err) {
        log.error(`Failed to reload ${section}:`, err);
      }
    });

    log.info('Watching for config changes');
  }

  // ── Section Reloaders ──────────────────────────────────

  private async reloadGuildConfig(): Promise<void> {
    const { data } = await this.supabase
      .from('guild_config')
      .select('*')
      .eq('guild_id', this.guild.id)
      .single();

    if (data) {
      this.cache.guildConfig = data;
      // Cache in Valkey for fast access
      await this.valkey.set(
        `config:${this.guild.id}`,
        JSON.stringify(data),
        'EX',
        300, // 5 min TTL
      ).catch((e: unknown) => { log.warn('Suppressed error:', (e as Error)?.message ?? e); });
      log.info('Guild config reloaded');
    }
  }

  private async reloadModeration(): Promise<void> {
    // Guild config already loaded by reloadAll() caller
    // Clear cached automod rules
    await this.valkey.del('automod:rules').catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    // Clear cached infraction config
    await this.valkey.del(`infraction:config:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Moderation config reloaded');
  }

  private async reloadLevels(): Promise<void> {
    // Guild config already loaded by reloadAll() caller
    // Clear cached level config (Valkey)
    await this.valkey.del(`levels:config:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    await this.valkey.del(`levels:rewards:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    // Clear in-memory caches in xp-tracker (config, multipliers, rewards)
    invalidateLevelCaches();
    log.info('Levels config reloaded');
  }

  private async reloadWelcome(): Promise<void> {
    // Guild config already loaded by reloadAll() caller
    // Clear cached welcome messages
    await this.valkey.del(`welcome:config:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Welcome config reloaded');
  }

  private async reloadCommerce(): Promise<void> {
    // Clear cached product data
    await this.valkey.del(`commerce:products:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Commerce config reloaded');
  }

  private async reloadMusic(skipGuildConfig = false): Promise<void> {
    if (!skipGuildConfig) await this.reloadGuildConfig();
    await this.valkey.del(`music:config:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Music config reloaded');
  }

  private async reloadTickets(): Promise<void> {
    // Clear cached ticket panel data
    await this.valkey.del(`tickets:panels:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Tickets config reloaded');
  }

  private async reloadAutomations(): Promise<void> {
    // Automations are loaded from DB on each event via AutomationEngine
    // Just clear any cached rules
    await this.valkey.del(`automations:rules:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Automations config reloaded');
  }

  private async reloadOnboarding(skipGuildConfig = false): Promise<void> {
    if (!skipGuildConfig) await this.reloadGuildConfig();
    await this.valkey.del(`onboarding:config:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    // Also invalidate the guild_config cache used by the onboarding handler
    await this.valkey.del(`guild_config:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Onboarding config reloaded');
  }

  private async reloadReactionRoles(): Promise<void> {
    await this.valkey.del(`reaction-roles:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    // Delete all individual reaction role cache keys for this guild (SCAN instead of KEYS — V5 audit 6.1)
    try {
      let cursor = '0';
      do {
        const [next, batch] = await this.valkey.scan(cursor, 'MATCH', `rr:${this.guild.id}:*`, 'COUNT', '100');
        cursor = next;
        if (batch.length > 0) await this.valkey.del(...batch);
      } while (cursor !== '0');
    } catch (e: unknown) { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); }
    log.info('Reaction roles reloaded');
  }

  private async reloadGiveaways(): Promise<void> {
    await this.valkey.del(`giveaways:active:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Giveaways config reloaded');
  }

  private async reloadTempChannels(): Promise<void> {
    await this.valkey.del(`temp-channels:hubs:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Temp channels config reloaded');
  }

  private async reloadScheduledMessages(): Promise<void> {
    await this.valkey.del(`scheduled-messages:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Scheduled messages config reloaded');
  }

  private async reloadCustomCommands(): Promise<void> {
    await this.valkey.del(`custom-commands:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Custom commands config reloaded');
  }

  private async reloadStatsChannels(): Promise<void> {
    await this.valkey.del(`stats-channels:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Stats channels config reloaded');
  }

  private async reloadEmbeds(): Promise<void> {
    await this.valkey.del(`embeds:${this.guild.id}`).catch((e: unknown) => { log.warn('Valkey operation failed:', (e as Error)?.message ?? e); });
    log.info('Embeds config reloaded');
  }

  private async reloadAll(): Promise<void> {
    // Load guild config once — sub-reloaders skip their own call
    await this.reloadGuildConfig();
    await this.reloadModeration();
    await this.reloadLevels();
    await this.reloadWelcome();
    await this.reloadOnboarding(true);
    await this.reloadCommerce();
    await this.reloadMusic(true);
    await this.reloadTickets();
    await this.reloadAutomations();
    await this.reloadReactionRoles();
    await this.reloadGiveaways();
    await this.reloadTempChannels();
    await this.reloadScheduledMessages();
    await this.reloadCustomCommands();
    await this.reloadStatsChannels();
    await this.reloadEmbeds();
    // Invalidate V17 feature in-memory caches so they re-read from DB
    invalidateAntiRaidCache();
    invalidateStarboardCache(this.guild.id);
    invalidateMessageLogCache(this.guild.id);
    // Invalidate V31 economy in-memory caches
    invalidateEconomyCache(this.guild.id);
    invalidateGatheringCache(this.guild.id);
    invalidateCraftingCache(this.guild.id);
    invalidateFarmingCache(this.guild.id);
    invalidateFishingCache(this.guild.id);
    invalidateAdventureCache(this.guild.id);
    invalidateMarketCache(this.guild.id);
    invalidateTriviaCache(this.guild.id);
    invalidateGamesCache(this.guild.id);
    invalidateLotteryCache(this.guild.id);
    invalidatePollsCache(this.guild.id);
    invalidatePetsCache(this.guild.id);
    invalidateQuestsCache(this.guild.id);
    invalidateAchievementsCache(this.guild.id);
    invalidateProfilesCache(this.guild.id);
    invalidateHeistCache(this.guild.id);
    // Invalidate the white-label brand kit cache
    invalidateBrandKitCache(this.guild.id);
    log.info('Full config reload complete (incl. economy caches)');
  }

  /**
   * Get the cached guild config (avoids DB hit on every request).
   */
  async getConfig(): Promise<Record<string, unknown> | null> {
    if (this.cache.guildConfig) return this.cache.guildConfig;

    // Try Valkey first
    const cached = await this.valkey.get(`config:${this.guild.id}`).catch(() => null);
    if (cached) {
      this.cache.guildConfig = JSON.parse(cached);
      return this.cache.guildConfig;
    }

    // Fall back to DB
    await this.reloadGuildConfig();
    return this.cache.guildConfig;
  }
}
