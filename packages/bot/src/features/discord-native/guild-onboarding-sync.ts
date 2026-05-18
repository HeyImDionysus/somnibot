/**
 * GuildOnboardingSync — Sync dashboard onboarding config with Discord's
 * native Guild Onboarding API (community onboarding prompts).
 *
 * When the operator configures welcome roles, prompts, and channels in the
 * dashboard, this pushes them to Discord's native onboarding flow so new
 * members see them immediately upon joining.
 *
 * GAP 5: Discord Native Potential — Guild Onboarding API sync
 */

import { Guild, GuildOnboardingPromptType } from 'discord.js';
import { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from '../../services/event-bus.js';

export interface OnboardingConfig {
  enabled: boolean;
  prompts: OnboardingPrompt[];
  default_channel_ids: string[];
}

export interface OnboardingPrompt {
  title: string;
  type: 'multiple_choice' | 'dropdown';
  required: boolean;
  single_select: boolean;
  options: {
    title: string;
    description?: string;
    emoji?: string;
    role_ids?: string[];
    channel_ids?: string[];
  }[];
}

export class GuildOnboardingSync {
  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus,
  ) {}

  start(): void {
    // Listen for onboarding config changes
    this.eventBus.on('config.changed' as never, ((data: { section?: string }) => {
      if (data.section === 'onboarding' || data.section === 'welcome') {
        this.syncOnboarding().catch((err) =>
          console.error('[GuildOnboardingSync] Sync failed:', err),
        );
      }
    }) as never);

    console.log('[GuildOnboardingSync] ✅ Guild onboarding sync started');
  }

  /**
   * Push dashboard onboarding config to Discord's Guild Onboarding API.
   */
  async syncOnboarding(): Promise<void> {
    const { data: config } = await this.supabase
      .from('guild_config')
      .select('onboarding_config, onboarding_enabled')
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (!config?.onboarding_enabled || !config?.onboarding_config) {
      return;
    }

    const onboardingConfig = config.onboarding_config as OnboardingConfig;

    try {
      // Fetch current onboarding to check if it exists
      const currentOnboarding = await this.guild.fetchOnboarding().catch(() => null);

      // Build prompts for Discord API
      const prompts = onboardingConfig.prompts.map((prompt) => ({
        title: prompt.title,
        type: prompt.type === 'dropdown'
          ? GuildOnboardingPromptType.Dropdown
          : GuildOnboardingPromptType.MultipleChoice,
        singleSelect: prompt.single_select,
        required: prompt.required,
        options: prompt.options.map((opt) => ({
          title: opt.title,
          description: opt.description ?? null,
          emoji: opt.emoji ? { name: opt.emoji } : undefined,
          roleIds: opt.role_ids ?? [],
          channelIds: opt.channel_ids ?? [],
        })),
      }));

      // Edit guild onboarding
      await this.guild.editOnboarding({
        enabled: onboardingConfig.enabled,
        prompts,
        defaultChannelIds: onboardingConfig.default_channel_ids,
      });

      console.log(`[GuildOnboardingSync] Synced ${prompts.length} onboarding prompts to Discord`);
    } catch (err) {
      console.error('[GuildOnboardingSync] Failed to sync onboarding:', err);
    }
  }
}
