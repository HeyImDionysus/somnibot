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
const LEASE_SECONDS = 90;
const LEASE_RENEWAL_MS = 30_000;
const RECONCILIATION_RETRY_MS = 250;

type OnboardingSyncResult = 'done' | 'reconcile' | 'wait';

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
  managed?: boolean;
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
    ...(typeof state.managed === 'boolean' ? { managed: state.managed } : {}),
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
        ...(option.emoji ? { emoji: normalizeEmojiIdentifier(option.emoji.identifier) } : {}),
        role_ids: [...option.roles.keys()].sort(),
        channel_ids: [...option.channels.keys()].sort(),
      })),
    })),
  };
}

function normalizeEmojiIdentifier(identifier: string): string {
  let decoded = identifier;
  try {
    decoded = decodeURIComponent(identifier);
  } catch {
    decoded = identifier;
  }
  const customMention = decoded.match(/^<(a?):([^:>]+):(\d+)>$/);
  if (!customMention) return decoded;
  return `${customMention[1] ? 'a:' : ''}${customMention[2]}:${customMention[3]}`;
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
          ...(option.emoji ? { emoji: normalizeEmojiIdentifier(option.emoji) } : {}),
          role_ids: [...new Set([...(option.role_ids ?? []), ...(mappedRole ? [mappedRole] : [])])].sort(),
          channel_ids: [...(option.channel_ids ?? [])].sort(),
        };
      }),
    })),
  };
}

export class GuildOnboardingSync {
  private started = false;
  private syncQueue: Promise<void> = Promise.resolve();

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    // Listen for onboarding config changes
    this.eventBus.on('config.changed', async (event: PlatformEvent<'config.changed', ConfigChangedData>) => {
      if (event.data.section === 'onboarding' || event.data.section === 'welcome') {
        await this.syncOnboarding(event.data.syncRequestId);
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
  syncOnboarding(expectedRequestId?: string): Promise<void> {
    const run = this.syncQueue.then(async () => {
      let requestId = expectedRequestId;
      let forceManagedReconciliation = false;
      for (;;) {
        const result = await this.performSync(requestId, forceManagedReconciliation);
        if (result === 'done') return;
        if (result === 'wait') {
          await new Promise((resolve) => setTimeout(resolve, RECONCILIATION_RETRY_MS));
        }
        requestId = undefined;
        forceManagedReconciliation = true;
      }
    });
    this.syncQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async performSync(
    expectedRequestId?: string,
    forceManagedReconciliation = false,
  ): Promise<OnboardingSyncResult> {
    const { data: config, error: configError } = await this.supabase
      .from('guild_config')
      .select('onboarding_config, onboarding_enabled, interest_role_mapping, onboarding_sync_state')
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (configError) {
      const error = `Onboarding configuration read failed: ${configError.message}`;
      log.error(error);
      const receiptResult = expectedRequestId
        ? await this.supabase.rpc('fail_pending_onboarding_sync', {
            p_guild_id: this.guild.id,
            p_request_id: expectedRequestId,
            p_error: error,
          })
        : { error: null };
      this.eventBus.emit('sync.failed', this.guild.id, {
        stage: 'discord-native-onboarding',
        error,
      });
      if (receiptResult.error) {
        throw new Error(`${error}; receipt write failed: ${receiptResult.error.message}`);
      }
      throw new Error(error);
    }

    if (!config) {
      return 'done';
    }

    const onboardingConfig = config.onboarding_config as OnboardingConfig | null;
    const interestRoleMapping = (config.interest_role_mapping ?? {}) as Record<string, string>;
    const syncState = readSyncState(config.onboarding_sync_state);
    if (expectedRequestId && syncState.request_id !== expectedRequestId) {
      log.info('Skipped superseded onboarding synchronization request', {
        expectedRequestId,
        currentRequestId: syncState.request_id ?? null,
      });
      return 'reconcile';
    }
    let observed: GuildOnboarding | null = null;
    let leaseToken: string | null = null;
    let leaseRenewalTimer: ReturnType<typeof setInterval> | undefined;
    let leaseLost = false;
    let leaseRenewalError: Error | null = null;
    const managedRequest = syncState.managed !== false && Boolean(syncState.request_id);
    const shouldMutate = managedRequest && (
      syncState.status === 'pending'
      || forceManagedReconciliation
      || (Boolean(expectedRequestId) && syncState.status === 'failed')
    );

    if (shouldMutate && syncState.request_id) {
      const { data: lease, error: leaseError } = await this.supabase.rpc(
        'acquire_onboarding_sync_lease',
        {
          p_guild_id: this.guild.id,
          p_request_id: syncState.request_id,
          p_lease_seconds: LEASE_SECONDS,
        },
      );
      if (leaseError) {
        throw new Error(`Onboarding synchronization lease failed: ${leaseError.message}`);
      }
      if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
        throw new Error('Onboarding synchronization lease returned malformed evidence');
      }
      const disposition = lease.disposition;
      if (disposition === 'stale') return 'reconcile';
      if (disposition === 'busy') {
        if (forceManagedReconciliation) return 'wait';
        throw new Error('Onboarding synchronization is already running for this guild');
      }
      if (disposition !== 'acquired' || typeof lease.lease_token !== 'string') {
        throw new Error('Onboarding synchronization lease returned malformed evidence');
      }
      const renewalLeaseToken = lease.lease_token;
      leaseToken = renewalLeaseToken;
      const renewalRequestId = syncState.request_id;
      leaseRenewalTimer = setInterval(() => {
        void this.renewLease(renewalRequestId, renewalLeaseToken).then((renewed) => {
          if (!renewed) leaseLost = true;
        }).catch((error: unknown) => {
          leaseRenewalError = error instanceof Error ? error : new Error(String(error));
        });
      }, LEASE_RENEWAL_MS);
      leaseRenewalTimer.unref?.();
    }

    try {
      // Fail before editing if the guild cannot expose its native onboarding
      // surface (for example, Community is not enabled or the bot lacks access).
      // This also proves the edit is targeting a real Discord onboarding object.
      observed = await this.guild.fetchOnboarding();

      if (!shouldMutate) {
        const liveConfig = serializeOnboarding(observed);
        const requested = config.onboarding_enabled && onboardingConfig
          ? requestedConfig(onboardingConfig, interestRoleMapping)
          : null;
        const matchesSaved = config.onboarding_enabled
          ? requested !== null && JSON.stringify(liveConfig) === JSON.stringify(requested)
          : !liveConfig.enabled;
        const persisted = await this.persistSyncState(syncState, {
          ...syncState,
          status: matchesSaved ? 'synced' : 'drifted',
          managed: syncState.status === 'idle' || syncState.managed === false ? false : true,
          observed_at: new Date().toISOString(),
          live_config: liveConfig,
        });
        return persisted ? 'done' : 'reconcile';
      }

      if (!leaseToken || !syncState.request_id) {
        throw new Error('Onboarding synchronization lease is unavailable');
      }
      if (leaseRenewalError) throw leaseRenewalError;
      if (leaseLost || !(await this.renewLease(syncState.request_id, leaseToken))) return 'reconcile';

      if (!config.onboarding_enabled) {
        const edited = await this.guild.editOnboarding({ enabled: false });
        if (leaseRenewalError) throw leaseRenewalError;
        if (leaseLost || !(await this.renewLease(syncState.request_id, leaseToken))) return 'reconcile';
        const liveConfig = serializeOnboarding(edited);
        const persisted = await this.persistSyncState(syncState, {
          ...syncState,
          status: liveConfig.enabled ? 'drifted' : 'synced',
          observed_at: new Date().toISOString(),
          live_config: liveConfig,
        }, leaseToken);
        if (persisted) {
          log.info(liveConfig.enabled
            ? 'Discord onboarding remained enabled after disable request'
            : 'Disabled Discord onboarding');
        }
        return persisted ? 'done' : 'reconcile';
      }

      if (!onboardingConfig) {
        throw new Error('Discord onboarding is enabled without an onboarding configuration');
      }

      const normalizedRequest = requestedConfig({
        ...onboardingConfig,
        enabled: config.onboarding_enabled,
      }, interestRoleMapping);

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
      if (leaseRenewalError) throw leaseRenewalError;
      if (leaseLost || !(await this.renewLease(syncState.request_id, leaseToken))) return 'reconcile';

      const liveConfig = serializeOnboarding(edited);
      const matchesRequested = JSON.stringify(liveConfig) === JSON.stringify(normalizedRequest);
      const persisted = await this.persistSyncState(syncState, {
        ...syncState,
        status: matchesRequested ? 'synced' : 'drifted',
        observed_at: new Date().toISOString(),
        live_config: liveConfig,
      }, leaseToken);

      if (persisted) {
        log.info(`Synced ${prompts.length} onboarding prompts to Discord`);
      }
      return persisted ? 'done' : 'reconcile';
    } catch (err) {
      const error = String(err);
      let persisted: boolean;
      try {
        persisted = await this.persistSyncState(syncState, {
          ...syncState,
          status: 'failed',
          observed_at: new Date().toISOString(),
          error,
          ...(observed ? { live_config: serializeOnboarding(observed) } : {}),
        }, leaseToken);
      } catch (persistError) {
        throw new Error(`${error}; receipt write failed: ${String(persistError)}`);
      }
      log.error('Failed to sync onboarding:', { error });
      this.eventBus.emit('sync.failed', this.guild.id, {
        stage: 'discord-native-onboarding',
        error,
      });
      if (!persisted) return 'reconcile';
      throw err instanceof Error ? err : new Error(error);
    } finally {
      if (leaseRenewalTimer) clearInterval(leaseRenewalTimer);
      if (leaseToken) {
        const { error: releaseError } = await this.supabase.rpc('release_onboarding_sync_lease', {
          p_guild_id: this.guild.id,
          p_lease_token: leaseToken,
        });
        if (releaseError) {
          log.error('Failed to release onboarding synchronization lease:', {
            error: releaseError.message,
          });
        }
      }
    }
  }

  private async persistSyncState(
    previous: OnboardingSyncState,
    next: OnboardingSyncState,
    leaseToken?: string | null,
  ): Promise<boolean> {
    if (previous.request_id && leaseToken) {
      const { data, error } = await this.supabase.rpc(
        'persist_onboarding_sync_state_if_leased',
        {
          p_guild_id: this.guild.id,
          p_request_id: previous.request_id,
          p_lease_token: leaseToken,
          p_state: next,
        },
      );
      if (error) {
        throw new Error(`Onboarding sync receipt write failed: ${error.message}`);
      }
      if (data !== true) {
        log.info('Skipped stale onboarding sync receipt', {
          requestId: previous.request_id,
        });
        return false;
      }
      return true;
    }
    let query = this.supabase
      .from('guild_config')
      .update({ onboarding_sync_state: next })
      .eq('guild_id', this.guild.id);
    if (previous.request_id) {
      query = query.contains('onboarding_sync_state', { request_id: previous.request_id });
    } else {
      query = query.contains('onboarding_sync_state', { status: previous.status });
    }
    const { data, error } = await query.select('guild_id').maybeSingle();
    if (error) {
      throw new Error(`Onboarding sync receipt write failed: ${error.message}`);
    }
    if (!data) {
      log.info('Skipped stale onboarding sync receipt', {
        requestId: previous.request_id ?? null,
      });
      return false;
    }
    return true;
  }

  private async renewLease(requestId: string, leaseToken: string): Promise<boolean> {
    const { data, error } = await this.supabase.rpc('renew_onboarding_sync_lease', {
      p_guild_id: this.guild.id,
      p_request_id: requestId,
      p_lease_token: leaseToken,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (error) {
      throw new Error(`Onboarding synchronization lease renewal failed: ${error.message}`);
    }
    return data === true;
  }
}
