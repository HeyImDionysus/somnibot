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

export interface AutoModRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger_type: 'keyword' | 'spam' | 'keyword_preset' | 'mention_spam';
  keywords?: string[];
  regex_patterns?: string[];
  keyword_preset?: ('profanity' | 'sexual_content' | 'slurs')[];
  mention_limit?: number;
  action: 'block' | 'timeout' | 'alert';
  alert_channel_id?: string;
  timeout_seconds?: number;
  exempt_role_ids?: string[];
  exempt_channel_ids?: string[];
}

const TRIGGER_TYPE_MAP: Record<string, AutoModerationRuleTriggerType> = {
  keyword: AutoModerationRuleTriggerType.Keyword,
  spam: AutoModerationRuleTriggerType.Spam,
  keyword_preset: AutoModerationRuleTriggerType.KeywordPreset,
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
    this.eventBus.on('config.changed' as never, ((data: { section?: string }) => {
      if (data.section === 'moderation') {
        this.syncRules().catch((err) =>
          console.error('[AutoModSync] Sync failed:', err),
        );
      }
    }) as never);

    // Initial sync on startup
    this.syncRules().catch((err) =>
      console.error('[AutoModSync] Initial sync failed:', err),
    );

    // Periodic sync every 15 minutes as safety net
    this.syncInterval = setInterval(() => {
      this.syncRules().catch(() => {});
    }, 15 * 60 * 1000);

    console.log('[AutoModSync] ✅ AutoMod sync service started');
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
      console.warn('[AutoModSync] Failed to fetch rules from DB:', error?.message);
      return;
    }

    // Fetch existing Discord AutoMod rules
    let existingRules;
    try {
      existingRules = await this.guild.autoModerationRules.fetch();
    } catch (err) {
      console.warn('[AutoModSync] Cannot fetch Discord AutoMod rules (missing perms?):', err);
      return;
    }

    // Map DB rules to Discord format and sync
    for (const rule of dbRules as AutoModRule[]) {
      try {
        const triggerType = TRIGGER_TYPE_MAP[rule.trigger_type];
        if (!triggerType) continue;

        // Build actions array
        const actions: Array<{ type: AutoModerationActionType; metadata?: Record<string, unknown> }> = [];

        if (rule.action === 'block') {
          actions.push({
            type: AutoModerationActionType.BlockMessage,
            metadata: { customMessage: `Blocked by ${rule.name}` },
          });
        }

        if (rule.action === 'timeout' && rule.timeout_seconds) {
          actions.push({
            type: AutoModerationActionType.Timeout,
            metadata: { durationSeconds: rule.timeout_seconds },
          });
        }

        if (rule.alert_channel_id) {
          actions.push({
            type: AutoModerationActionType.SendAlertMessage,
            metadata: { channelId: rule.alert_channel_id },
          });
        }

        // Build trigger metadata
        const triggerMetadata: Record<string, unknown> = {};
        if (rule.keywords?.length) triggerMetadata.keywordFilter = rule.keywords;
        if (rule.regex_patterns?.length) triggerMetadata.regexPatterns = rule.regex_patterns;
        if (rule.mention_limit) triggerMetadata.mentionTotalLimit = rule.mention_limit;

        // Check if rule already exists in Discord (by name match)
        const existingRule = existingRules.find((r) => r.name === `SB: ${rule.name}`);

        if (existingRule) {
          // Update existing rule
          await existingRule.edit({
            name: `SB: ${rule.name}`,
            enabled: rule.enabled,
            actions,
            triggerMetadata,
            exemptRoles: rule.exempt_role_ids ?? [],
            exemptChannels: rule.exempt_channel_ids ?? [],
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
            exemptRoles: rule.exempt_role_ids ?? [],
            exemptChannels: rule.exempt_channel_ids ?? [],
          });
        }
      } catch (err) {
        console.error(`[AutoModSync] Failed to sync rule "${rule.name}":`, err);
      }
    }

    console.log(`[AutoModSync] Synced ${dbRules.length} rules to Discord AutoMod`);
  }
}
