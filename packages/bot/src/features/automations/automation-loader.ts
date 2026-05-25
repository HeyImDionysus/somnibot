/**
 * Automation loader — loads automations from Supabase and subscribes to Realtime.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbAutomation } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('AutomationLoader');

export interface LoadedAutomation {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  conditions: { type: string; config: Record<string, unknown> }[];
  actions: { type: string; config: Record<string, unknown> }[];
  scopeTargetUserIds: string[];
  scopeTargetChannelIds: string[];
  scopeExcludeUserIds: string[];
  scopeExcludeChannelIds: string[];
  rateLimitPerUser: number | null;
  rateLimitWindowSeconds: number | null;
}

function toLoaded(row: DbAutomation): LoadedAutomation {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    triggerType: row.trigger_type,
    triggerConfig: row.trigger_config,
    conditions: row.conditions as { type: string; config: Record<string, unknown> }[],
    actions: row.actions as { type: string; config: Record<string, unknown> }[],
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
      this.automations.set(row.id, toLoaded(row));
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
            this.automations.set(newRow.id, toLoaded(newRow));
            log.info(`Automation ${eventType === 'INSERT' ? 'created' : 'updated'}: ${newRow.name}`);
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
