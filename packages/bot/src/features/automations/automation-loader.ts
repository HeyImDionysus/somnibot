/**
 * Automation loader — loads automations from Supabase and subscribes to Realtime.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import type {
  ActionType,
  ConditionType,
  DbAutomation,
  TriggerType,
} from '@somnibot/shared';
import {
  AUTOMATION_LIMITS,
  createLogger,
  isActionType,
  isConditionType,
  isTriggerType,
} from '@somnibot/shared';

const log = createLogger('AutomationLoader');

export interface LoadedAutomation {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: TriggerType;
  triggerConfig: Record<string, unknown>;
  conditions: { type: ConditionType; config: Record<string, unknown> }[];
  actions: { type: ActionType; config: Record<string, unknown> }[];
  scopeTargetUserIds: string[];
  scopeTargetChannelIds: string[];
  scopeExcludeUserIds: string[];
  scopeExcludeChannelIds: string[];
  rateLimitPerUser: number | null;
  rateLimitWindowSeconds: number | null;
  /** SHA-256 of the definition last shown in the dashboard dry-run preview. */
  previewHash: string | null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function automationPreviewHash(row: {
  name: string;
  description: string | null;
  description?: string | null;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  conditions: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  target_user_ids?: string[];
  target_channel_ids?: string[];
  exclude_user_ids?: string[];
  exclude_channel_ids?: string[];
}): string {
  const payload = {
    name: row.name,
    description: row.description ?? null,
    description: row.description ?? null,
    trigger_type: row.trigger_type,
    trigger_config: row.trigger_config ?? {},
    conditions: row.conditions ?? [],
    actions: row.actions ?? [],
    target_user_ids: row.target_user_ids ?? [],
    target_channel_ids: row.target_channel_ids ?? [],
    exclude_user_ids: row.exclude_user_ids ?? [],
    exclude_channel_ids: row.exclude_channel_ids ?? [],
  };
  return createHash('sha256')
    .update(JSON.stringify(stableValue(payload)))
    .digest('hex');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseConditions(
  value: unknown,
): LoadedAutomation['conditions'] | null {
  if (
    !Array.isArray(value)
    || value.length > AUTOMATION_LIMITS.MAX_CONDITIONS_PER_AUTOMATION
  ) {
    return null;
  }
  const parsed: LoadedAutomation['conditions'] = [];
  for (const entry of value) {
    if (
      !isPlainRecord(entry)
      || !isConditionType(entry.type)
      || !isPlainRecord(entry.config)
    ) {
      return null;
    }
    parsed.push({ type: entry.type, config: entry.config });
  }
  return parsed;
}

function parseActions(value: unknown): LoadedAutomation['actions'] | null {
  if (
    !Array.isArray(value)
    || value.length > AUTOMATION_LIMITS.MAX_ACTIONS_PER_AUTOMATION
  ) {
    return null;
  }
  const parsed: LoadedAutomation['actions'] = [];
  for (const entry of value) {
    if (
      !isPlainRecord(entry)
      || !isActionType(entry.type)
      || !isPlainRecord(entry.config)
    ) {
      return null;
    }
    parsed.push({ type: entry.type, config: entry.config });
  }
  return parsed;
}

function toLoaded(row: DbAutomation): LoadedAutomation | null {
  const conditions = parseConditions(row.conditions);
  const actions = parseActions(row.actions);
  if (
    !isTriggerType(row.trigger_type)
    || !isPlainRecord(row.trigger_config)
    || conditions === null
    || actions === null
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    triggerType: row.trigger_type,
    triggerConfig: row.trigger_config,
    conditions,
    actions,
    scopeTargetUserIds: row.target_user_ids ?? [],
    scopeTargetChannelIds: row.target_channel_ids ?? [],
    scopeExcludeUserIds: row.exclude_user_ids ?? [],
    scopeExcludeChannelIds: row.exclude_channel_ids ?? [],
    rateLimitPerUser: row.rate_limit_per_user ?? null,
    rateLimitWindowSeconds: row.rate_limit_window_seconds ?? null,
    previewHash: typeof (row as unknown as { preview_hash?: unknown }).preview_hash === 'string'
      ? (row as unknown as { preview_hash: string }).preview_hash
      : null,
  };
}

export class AutomationLoader {
  private automations: Map<string, LoadedAutomation> = new Map();
  private onChange: (() => void) | null = null;
  private channel: RealtimeChannel | null = null;
  private previewRequired = false;

  constructor(
    private supabase: SupabaseClient,
    private guildId: string,
  ) {}

  /**
   * Load all automations from Supabase.
   */
  async load(): Promise<void> {
    await this.refreshPreviewRequirement();
    const { data, error } = await this.supabase
      .from('automations')
      .select('*')
      .eq('guild_id', this.guildId)
      .limit(1000);

    if (error) {
      log.error('Failed to load automations:', error.message);
      return;
    }

    this.automations.clear();
    for (const row of (data ?? []) as DbAutomation[]) {
      const loaded = toLoaded(row);
      if (!loaded) {
        log.warn(`Rejected malformed automation contract: ${row.id}`);
        continue;
      }
      this.automations.set(row.id, loaded);
    }

    log.info(`Loaded ${this.automations.size} automations`);
  }

  async refreshPreviewRequirement(): Promise<void> {
    try {
      const { data, error } = await this.supabase
        .from('guild_config')
        .select('automation_preview_required')
        .eq('guild_id', this.guildId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      // A deployed guild_config row carries the migration default (true).
      // Missing config is treated as legacy/test mode rather than disabling
      // every pre-migration automation unexpectedly.
      this.previewRequired = data?.automation_preview_required === true;
    } catch (error) {
      this.previewRequired = false;
      log.warn('Could not read automation preview requirement; keeping legacy mode:', error);
    }
  }

  /**
   * Subscribe to Supabase Realtime for automation changes.
   */
  subscribe(): void {
    // A fixed channel name collides across guilds that share one Supabase
    // client: realtime-js returns the first guild's already-subscribed
    // channel, and `.on('postgres_changes')` on a non-'closed' channel throws
    // "cannot add postgres_changes callbacks ... after subscribe()", silently
    // breaking Realtime automation reloads for every guild after the first.
    // Scope the name per guild + instance so each gets a fresh channel.
    this.channel = this.supabase
      .channel(`automation-changes-${this.guildId}-${Date.now()}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'automations',
          filter: `guild_id=eq.${this.guildId}`,
        },
        (payload) => {
          const eventType = payload.eventType;
          if (eventType === 'DELETE') {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) {
              this.automations.delete(oldRow.id);
              log.info(`Automation deleted: ${oldRow.id}`);
            }
          } else {
            // INSERT or UPDATE
            const newRow = payload.new as DbAutomation;
            const loaded = toLoaded(newRow);
            if (!loaded) {
              this.automations.delete(newRow.id);
              log.warn(`Rejected malformed automation contract: ${newRow.id}`);
            } else {
              this.automations.set(newRow.id, loaded);
              log.info(`Automation ${eventType === 'INSERT' ? 'created' : 'updated'}: ${newRow.name}`);
            }
          }
          this.onChange?.();
        },
      )
      .subscribe();
  }

  /**
   * Tear down the Realtime subscription. Removes the channel from the shared
   * client so it doesn't leak, and so a re-init doesn't collide with a stale
   * subscribed channel.
   */
  unsubscribe(): void {
    if (this.channel) {
      this.supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }

  /**
   * Get all enabled automations for a specific trigger type.
   */
  getForTrigger(triggerType: string): LoadedAutomation[] {
    if (!isTriggerType(triggerType)) return [];
    const results: LoadedAutomation[] = [];
    for (const auto of this.automations.values()) {
      if (
        auto.enabled
        && auto.triggerType === triggerType
        && (!this.previewRequired || auto.previewHash === automationPreviewHash({
          name: auto.name,
          description: auto.description,
          trigger_type: auto.triggerType,
          trigger_config: auto.triggerConfig,
          conditions: auto.conditions,
          actions: auto.actions,
          target_user_ids: auto.scopeTargetUserIds,
          target_channel_ids: auto.scopeTargetChannelIds,
          exclude_user_ids: auto.scopeExcludeUserIds,
          exclude_channel_ids: auto.scopeExcludeChannelIds,
        }))
      ) {
        results.push(auto);
      }
    }
    return results;
  }

  /**
   * Get all loaded automations.
   */
  getAll(): LoadedAutomation[] {
    return Array.from(this.automations.values());
  }

  isPreviewCurrent(automationId: string): boolean {
    const auto = this.automations.get(automationId);
    if (!auto) return false;
    if (!this.previewRequired) return true;
    return auto.previewHash === automationPreviewHash({
      name: auto.name,
      description: auto.description,
      trigger_type: auto.triggerType,
      trigger_config: auto.triggerConfig,
      conditions: auto.conditions,
      actions: auto.actions,
      target_user_ids: auto.scopeTargetUserIds,
      target_channel_ids: auto.scopeTargetChannelIds,
      exclude_user_ids: auto.scopeExcludeUserIds,
      exclude_channel_ids: auto.scopeExcludeChannelIds,
    });
  }

  /**
   * Set a callback for when automations change.
   */
  onUpdate(callback: () => void): void {
    this.onChange = callback;
  }
}
