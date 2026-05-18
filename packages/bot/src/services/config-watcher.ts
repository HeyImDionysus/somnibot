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
 * - 'settings' → reload instance-wide settings (full reload)
 * - 'all' → full config reload
 */
import type { Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from './event-bus.js';
import type Valkey from 'iovalkey';

interface ConfigCache {
  guildConfig: Record<string, unknown> | null;
  lastReload: number;
}

export class ConfigWatcher {
  private cache: ConfigCache = { guildConfig: null, lastReload: 0 };
  private reloadCooldownMs = 2000; // Don't reload more than once every 2 seconds

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

      // Cooldown to prevent rapid reloads
      if (now - this.cache.lastReload < this.reloadCooldownMs) {
        console.log(`[ConfigWatcher] Skipping reload (cooldown) — section: ${section}`);
        return;
      }

      console.log(`[ConfigWatcher] Config changed: ${section} (by ${event.data.changedBy})`);
      this.cache.lastReload = now;

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
          case 'all':
            await this.reloadAll();
            break;
          default:
            // Unknown section — do a full reload to be safe
            await this.reloadGuildConfig();
            break;
        }
      } catch (err) {
        console.error(`[ConfigWatcher] Failed to reload ${section}:`, err);
      }
    });

    console.log('[ConfigWatcher] Watching for config changes');
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
      ).catch(() => {});
      console.log('[ConfigWatcher] ✅ Guild config reloaded');
    }
  }

  private async reloadModeration(): Promise<void> {
    await this.reloadGuildConfig();
    // Clear cached automod rules
    await this.valkey.del(`automod:rules:${this.guild.id}`).catch(() => {});
    // Clear cached infraction config
    await this.valkey.del(`infraction:config:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Moderation config reloaded');
  }

  private async reloadLevels(): Promise<void> {
    await this.reloadGuildConfig();
    // Clear cached level config
    await this.valkey.del(`levels:config:${this.guild.id}`).catch(() => {});
    await this.valkey.del(`levels:rewards:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Levels config reloaded');
  }

  private async reloadWelcome(): Promise<void> {
    await this.reloadGuildConfig();
    // Clear cached welcome messages
    await this.valkey.del(`welcome:config:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Welcome config reloaded');
  }

  private async reloadCommerce(): Promise<void> {
    // Clear cached product data
    await this.valkey.del(`commerce:products:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Commerce config reloaded');
  }

  private async reloadMusic(): Promise<void> {
    await this.reloadGuildConfig();
    await this.valkey.del(`music:config:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Music config reloaded');
  }

  private async reloadTickets(): Promise<void> {
    // Clear cached ticket panel data
    await this.valkey.del(`tickets:panels:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Tickets config reloaded');
  }

  private async reloadAutomations(): Promise<void> {
    // Automations are loaded from DB on each event via AutomationEngine
    // Just clear any cached rules
    await this.valkey.del(`automations:rules:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Automations config reloaded');
  }

  private async reloadOnboarding(): Promise<void> {
    await this.reloadGuildConfig();
    await this.valkey.del(`onboarding:config:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Onboarding config reloaded');
  }

  private async reloadReactionRoles(): Promise<void> {
    await this.valkey.del(`reaction-roles:${this.guild.id}`).catch(() => {});
    // Delete all individual reaction role cache keys for this guild
    const keys = await this.valkey.keys(`rr:${this.guild.id}:*`).catch(() => [] as string[]);
    if (keys.length > 0) {
      await this.valkey.del(...keys).catch(() => {});
    }
    console.log('[ConfigWatcher] ✅ Reaction roles reloaded');
  }

  private async reloadGiveaways(): Promise<void> {
    await this.valkey.del(`giveaways:active:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Giveaways config reloaded');
  }

  private async reloadTempChannels(): Promise<void> {
    await this.valkey.del(`temp-channels:hubs:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Temp channels config reloaded');
  }

  private async reloadScheduledMessages(): Promise<void> {
    await this.valkey.del(`scheduled-messages:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Scheduled messages config reloaded');
  }

  private async reloadCustomCommands(): Promise<void> {
    await this.valkey.del(`custom-commands:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Custom commands config reloaded');
  }

  private async reloadStatsChannels(): Promise<void> {
    await this.valkey.del(`stats-channels:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Stats channels config reloaded');
  }

  private async reloadEmbeds(): Promise<void> {
    await this.valkey.del(`embeds:${this.guild.id}`).catch(() => {});
    console.log('[ConfigWatcher] ✅ Embeds config reloaded');
  }

  private async reloadAll(): Promise<void> {
    await this.reloadGuildConfig();
    await this.reloadModeration();
    await this.reloadLevels();
    await this.reloadWelcome();
    await this.reloadOnboarding();
    await this.reloadCommerce();
    await this.reloadMusic();
    await this.reloadTickets();
    await this.reloadAutomations();
    await this.reloadReactionRoles();
    await this.reloadGiveaways();
    await this.reloadTempChannels();
    await this.reloadScheduledMessages();
    await this.reloadCustomCommands();
    await this.reloadStatsChannels();
    await this.reloadEmbeds();
    console.log('[ConfigWatcher] ✅ Full config reload complete');
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
