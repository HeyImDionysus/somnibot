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
import type { PlatformEvent, ConfigChangedData } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('OnboardingSync');

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
    this.eventBus.on('config.changed', (event: PlatformEvent<'config.changed', ConfigChangedData>) => {
      if (event.data.section === 'onboarding' || event.data.section === 'welcome') {
        this.syncOnboarding().catch((err) =>
          log.error('Sync failed:', { error: String(err) }),
        );
      }
    });

    log.info('Guild onboarding sync started');
  }

  /**
   * Push dashboard onboarding config to Discord's Guild Onboarding API.
   */
  async syncOnboarding(): Promise<void> {
    const { data: config } = await this.supabase
      .from('guild_config')
      .select('onboarding_config, onboarding_enabled, interest_role_mapping')
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (!config?.onboarding_enabled || !config?.onboarding_config) {
      return;
    }

    const onboardingConfig = config.onboarding_config as OnboardingConfig;
    const interestRoleMapping = (config.interest_role_mapping ?? {}) as Record<string, string>;

    try {
      // Fail before editing if the guild cannot expose its native onboarding
      // surface (for example, Community is not enabled or the bot lacks access).
      // This also proves the edit is targeting a real Discord onboarding object.
      await this.guild.fetchOnboarding();

      // Build prompts for Discord API
      const prompts = onboardingConfig.prompts.map((prompt) => ({
        title: prompt.title,
        type: prompt.type === 'dropdown'
          ? GuildOnboardingPromptType.Dropdown
          : GuildOnboardingPromptType.MultipleChoice,
        singleSelect: prompt.single_select,
        required: prompt.required,
        options: prompt.options.map((opt) => {
          const mappedRole = interestRoleMapping[opt.title];
          return {
            title: opt.title,
            description: opt.description ?? null,
            emoji: opt.emoji ?? undefined,
            roles: [...new Set([...(opt.role_ids ?? []), ...(mappedRole ? [mappedRole] : [])])],
            channels: opt.channel_ids ?? [],
          };
        }),
      }));

      // Edit guild onboarding
      await this.guild.editOnboarding({
        enabled: onboardingConfig.enabled,
        prompts,
        defaultChannels: onboardingConfig.default_channel_ids,
      });

      log.info(`Synced ${prompts.length} onboarding prompts to Discord`);
    } catch (err) {
      const error = String(err);
      log.error('Failed to sync onboarding:', { error });
      this.eventBus.emit('sync.failed', this.guild.id, {
        stage: 'discord-native-onboarding',
        error,
      });
    }
  }
}
