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
import type { GuildOnboarding, GuildOnboardingEditOptions } from 'discord.js';
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

type OnboardingSyncStatus = 'idle' | 'pending' | 'synced' | 'drifted' | 'failed';

interface OnboardingSyncState {
  status: OnboardingSyncStatus;
  request_id?: string;
  requested_at?: string;
  observed_at?: string;
  error?: string;
  live_config?: OnboardingConfig;
}

function readSyncState(value: unknown): OnboardingSyncState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'idle' };
  }
  const state = value as Record<string, unknown>;
  const status = typeof state.status === 'string' ? state.status : 'idle';
  if (!['idle', 'pending', 'synced', 'drifted', 'failed'].includes(status)) {
    return { status: 'idle' };
  }
  return {
    status: status as OnboardingSyncStatus,
    ...(typeof state.request_id === 'string' ? { request_id: state.request_id } : {}),
    ...(typeof state.requested_at === 'string' ? { requested_at: state.requested_at } : {}),
  };
}

function serializeOnboarding(onboarding: GuildOnboarding): OnboardingConfig {
  return {
    enabled: onboarding.enabled,
    default_channel_ids: [...onboarding.defaultChannels.keys()].sort(),
    prompts: [...onboarding.prompts.values()].map((prompt) => ({
      title: prompt.title,
      type: prompt.type === GuildOnboardingPromptType.Dropdown ? 'dropdown' : 'multiple_choice',
      required: prompt.required,
      single_select: prompt.singleSelect,
      options: [...prompt.options.values()].map((option) => ({
        title: option.title,
        ...(option.description ? { description: option.description } : {}),
        ...(option.emoji ? { emoji: option.emoji.identifier } : {}),
        role_ids: [...option.roles.keys()].sort(),
        channel_ids: [...option.channels.keys()].sort(),
      })),
    })),
  };
}

function requestedConfig(
  config: OnboardingConfig,
  interestRoleMapping: Record<string, string>,
): OnboardingConfig {
  return {
    enabled: config.enabled,
    default_channel_ids: [...config.default_channel_ids].sort(),
    prompts: config.prompts.map((prompt) => ({
      ...prompt,
      options: prompt.options.map((option) => {
        const mappedRole = interestRoleMapping[option.title];
        return {
          title: option.title,
          ...(option.description ? { description: option.description } : {}),
          ...(option.emoji ? { emoji: option.emoji } : {}),
          role_ids: [...new Set([...(option.role_ids ?? []), ...(mappedRole ? [mappedRole] : [])])].sort(),
          channel_ids: [...(option.channel_ids ?? [])].sort(),
        };
      }),
    })),
  };
}

export class GuildOnboardingSync {
  private started = false;

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    // Listen for onboarding config changes
    this.eventBus.on('config.changed', (event: PlatformEvent<'config.changed', ConfigChangedData>) => {
      if (event.data.section === 'onboarding' || event.data.section === 'welcome') {
        this.syncOnboarding().catch((err) =>
          log.error('Sync failed:', { error: String(err) }),
        );
      }
    });

    void this.syncOnboarding().catch((err) =>
      log.error('Sync failed:', { error: String(err) }),
    );

    log.info('Guild onboarding sync started');
  }

  /**
   * Push dashboard onboarding config to Discord's Guild Onboarding API.
   */
  async syncOnboarding(): Promise<void> {
    const { data: config } = await this.supabase
      .from('guild_config')
      .select('onboarding_config, onboarding_enabled, interest_role_mapping, onboarding_sync_state')
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (!config) {
      return;
    }

    const onboardingConfig = config.onboarding_config as OnboardingConfig | null;
    const interestRoleMapping = (config.interest_role_mapping ?? {}) as Record<string, string>;
    const syncState = readSyncState(config.onboarding_sync_state);
    let observed: GuildOnboarding | null = null;

    try {
      // Fail before editing if the guild cannot expose its native onboarding
      // surface (for example, Community is not enabled or the bot lacks access).
      // This also proves the edit is targeting a real Discord onboarding object.
      observed = await this.guild.fetchOnboarding();

      if (!config.onboarding_enabled) {
        const edited = await this.guild.editOnboarding({ enabled: false });
        await this.persistSyncState(syncState, {
          ...syncState,
          status: 'synced',
          observed_at: new Date().toISOString(),
          live_config: serializeOnboarding(edited),
        });
        log.info('Disabled Discord onboarding');
        return;
      }

      if (!onboardingConfig) {
        throw new Error('Discord onboarding is enabled without an onboarding configuration');
      }

      const normalizedRequest = requestedConfig(onboardingConfig, interestRoleMapping);

      // Build prompts for Discord API
      const prompts: NonNullable<GuildOnboardingEditOptions['prompts']> = normalizedRequest.prompts.map((prompt) => ({
        title: prompt.title,
        type: prompt.type === 'dropdown'
          ? GuildOnboardingPromptType.Dropdown
          : GuildOnboardingPromptType.MultipleChoice,
        singleSelect: prompt.single_select,
        required: prompt.required,
        options: prompt.options.map((opt) => {
          return {
            title: opt.title,
            description: opt.description ?? null,
            emoji: opt.emoji ?? undefined,
            roles: opt.role_ids ?? [],
            channels: opt.channel_ids ?? [],
          };
        }),
      }));

      // Edit guild onboarding
      const edited = await this.guild.editOnboarding({
        enabled: normalizedRequest.enabled,
        prompts,
        defaultChannels: normalizedRequest.default_channel_ids,
      });

      const liveConfig = serializeOnboarding(edited);
      const matchesRequested = JSON.stringify(liveConfig) === JSON.stringify(normalizedRequest);
      await this.persistSyncState(syncState, {
        ...syncState,
        status: matchesRequested ? 'synced' : 'drifted',
        observed_at: new Date().toISOString(),
        live_config: liveConfig,
      });

      log.info(`Synced ${prompts.length} onboarding prompts to Discord`);
    } catch (err) {
      const error = String(err);
      await this.persistSyncState(syncState, {
        ...syncState,
        status: 'failed',
        observed_at: new Date().toISOString(),
        error,
        ...(observed ? { live_config: serializeOnboarding(observed) } : {}),
      }).catch((persistError) => {
        log.error('Failed to persist onboarding sync failure:', { error: String(persistError) });
      });
      log.error('Failed to sync onboarding:', { error });
      this.eventBus.emit('sync.failed', this.guild.id, {
        stage: 'discord-native-onboarding',
        error,
      });
    }
  }

  private async persistSyncState(
    previous: OnboardingSyncState,
    next: OnboardingSyncState,
  ): Promise<void> {
    let query = this.supabase
      .from('guild_config')
      .update({ onboarding_sync_state: next })
      .eq('guild_id', this.guild.id);
    if (previous.request_id) {
      query = query.contains('onboarding_sync_state', { request_id: previous.request_id });
    } else {
      query = query.contains('onboarding_sync_state', { status: previous.status });
    }
    const { error } = await query;
    if (error) {
      throw new Error(`Onboarding sync receipt write failed: ${error.message}`);
    }
  }
}
