/**
 * Automation loader — loads automations from Supabase and subscribes to Realtime.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
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
  };
}

export class AutomationLoader {
  private automations: Map<string, LoadedAutomation> = new Map();
  private onChange: (() => void) | null = null;

  constructor(
    private supabase: SupabaseClient,
    private guildId: string,
  ) {}

  /**
   * Load all automations from Supabase.
   */
  async load(): Promise<void> {
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

  /**
   * Subscribe to Supabase Realtime for automation changes.
   */
  subscribe(): void {
    this.supabase
      .channel('automation-changes')
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
   * Get all enabled automations for a specific trigger type.
   */
  getForTrigger(triggerType: string): LoadedAutomation[] {
    if (!isTriggerType(triggerType)) return [];
    const results: LoadedAutomation[] = [];
    for (const auto of this.automations.values()) {
      if (auto.enabled && auto.triggerType === triggerType) {
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

  /**
   * Set a callback for when automations change.
   */
  onUpdate(callback: () => void): void {
    this.onChange = callback;
  }
}
