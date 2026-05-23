/**
 * AutoModSync — Sync dashboard moderation rules with Discord's native AutoMod API.
 *
 * When rules are created/updated/deleted in the dashboard, this service
 * pushes them to Discord's AutoMod system so enforcement happens at the
 * gateway level (faster, lower latency, works even if bot is restarting).
 *
 * GAP 5: Discord Native Potential — AutoMod rules sync
 */

import { Guild, AutoModerationRuleManager, AutoModerationActionType, AutoModerationRuleTriggerType, AutoModerationRuleEventType } from 'discord.js';
import { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('AutoModSync');

/**
 * Matches the actual `automod_rules` DB schema.
 * `type` maps to Discord trigger types; `config` is a JSONB with
 * trigger-specific fields (keywords, regex_patterns, mention_limit, etc.).
 */
export interface AutoModRule {
  id: string;
  name: string;
  enabled: boolean;
  type: 'word_filter' | 'link_filter' | 'invite_filter' | 'spam_filter' | 'duplicate_filter' | 'caps_filter' | 'mention_spam' | 'newline_spam';
  config: {
    keywords?: string[];
    regex_patterns?: string[];
    keyword_preset?: ('profanity' | 'sexual_content' | 'slurs')[];
    mention_limit?: number;
    alert_channel_id?: string;
    timeout_seconds?: number;
  };
  action: 'delete' | 'warn' | 'mute' | 'kick' | 'ban';
  mute_duration_minutes?: number;
  exempt_roles: string[];
  exempt_channels: string[];
  sync_to_discord: boolean;
}

/** Map DB rule `type` to Discord trigger types (only types that have a Discord equivalent). */
const TRIGGER_TYPE_MAP: Record<string, AutoModerationRuleTriggerType> = {
  word_filter: AutoModerationRuleTriggerType.Keyword,
  link_filter: AutoModerationRuleTriggerType.Keyword,
  invite_filter: AutoModerationRuleTriggerType.Keyword,
  spam_filter: AutoModerationRuleTriggerType.Spam,
  mention_spam: AutoModerationRuleTriggerType.MentionSpam,
};

export class AutoModSync {
  private syncInterval: NodeJS.Timeout | null = null;

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus,
  ) {}

  /**
   * Start listening for moderation config changes and sync to Discord.
   */
  start(): void {
    // Listen for config reload events targeting moderation
    this.eventBus.on('config.changed', (event) => {
      if (event.data.section === 'moderation') {
        this.syncRules().catch((err) =>
          log.error('Sync failed:', { error: String(err) }),
        );
      }
    });

    // Initial sync on startup
    this.syncRules().catch((err) =>
      log.error('Initial sync failed:', { error: String(err) }),
    );

    // Periodic sync every 15 minutes as safety net
    this.syncInterval = setInterval(() => {
      this.syncRules().catch((e: unknown) => { log.warn('Sync failed:', (e as Error)?.message ?? e); });
    }, 15 * 60 * 1000);

    log.info('AutoMod sync service started');
  }

  stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  /**
   * Push dashboard automod rules to Discord's native AutoMod API.
   */
  async syncRules(): Promise<void> {
    const { data: dbRules, error } = await this.supabase
      .from('automod_rules')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('sync_to_discord', true);

    if (error || !dbRules) {
      log.warn('Failed to fetch rules from DB:', error?.message);
      return;
    }

    // Fetch existing Discord AutoMod rules
    let existingRules;
    try {
      existingRules = await this.guild.autoModerationRules.fetch();
    } catch (err) {
      log.warn('Cannot fetch Discord AutoMod rules (missing perms?):', { error: String(err) });
      return;
    }

    // Map DB rules to Discord format and sync
    for (const rule of dbRules as AutoModRule[]) {
      try {
        const triggerType = TRIGGER_TYPE_MAP[rule.type];
        if (!triggerType) continue; // types like caps_filter, duplicate_filter, newline_spam have no Discord equivalent

        const cfg = rule.config ?? {};

        // Build actions array
        const actions: Array<{ type: AutoModerationActionType; metadata?: Record<string, unknown> }> = [];

        if (rule.action === 'delete' || rule.action === 'warn') {
          actions.push({
            type: AutoModerationActionType.BlockMessage,
            metadata: { customMessage: `Blocked by ${rule.name}` },
          });
        }

        if (rule.action === 'mute' && rule.mute_duration_minutes) {
          actions.push({
            type: AutoModerationActionType.Timeout,
            metadata: { durationSeconds: rule.mute_duration_minutes * 60 },
          });
        }

        if (cfg.alert_channel_id) {
          actions.push({
            type: AutoModerationActionType.SendAlertMessage,
            metadata: { channelId: cfg.alert_channel_id },
          });
        }

        // Build trigger metadata from config JSONB
        const triggerMetadata: Record<string, unknown> = {};
        if (cfg.keywords?.length) triggerMetadata.keywordFilter = cfg.keywords;
        if (cfg.regex_patterns?.length) triggerMetadata.regexPatterns = cfg.regex_patterns;
        if (cfg.mention_limit) triggerMetadata.mentionTotalLimit = cfg.mention_limit;

        // Check if rule already exists in Discord (by name match)
        const existingRule = existingRules.find((r) => r.name === `SB: ${rule.name}`);

        if (existingRule) {
          // Update existing rule
          await existingRule.edit({
            name: `SB: ${rule.name}`,
            enabled: rule.enabled,
            actions,
            triggerMetadata,
            exemptRoles: rule.exempt_roles ?? [],
            exemptChannels: rule.exempt_channels ?? [],
          });
        } else if (rule.enabled) {
          // Create new rule
          await this.guild.autoModerationRules.create({
            name: `SB: ${rule.name}`,
            eventType: AutoModerationRuleEventType.MessageSend,
            triggerType,
            triggerMetadata,
            actions,
            enabled: true,
            exemptRoles: rule.exempt_roles ?? [],
            exemptChannels: rule.exempt_channels ?? [],
          });
        }
      } catch (err) {
        log.error(`Failed to sync rule "${rule.name}":`, err);
      }
    }

    log.info(`Synced ${dbRules.length} rules to Discord AutoMod`);
  }
}
