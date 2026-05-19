/**
 * Sync Engine
 *
 * Periodically compares Discord actual state against desired state.
 * Reports drift to the dashboard via Supabase, optionally auto-repairs.
 */

import type { Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeStateDiff, classifyDrift, type DesiredState, type DriftItem } from '@somnibot/shared';
import { takeSnapshot } from './snapshot.js';
import type { PlatformEventBus } from '../services/event-bus.js';

export interface SyncConfig {
  enabled: boolean;
  intervalMinutes: number;
  autoRepair: boolean;
  autoRepairEveryone: boolean;
}

export interface SyncResult {
  driftItems: DriftItem[];
  repaired: number;
  timestamp: string;
}

/**
 * Run a single sync cycle.
 */
export async function runSyncCycle(
  guild: Guild,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
  config: SyncConfig,
): Promise<SyncResult> {
  const timestamp = new Date().toISOString();

  // 1. Get desired state from Supabase
  const { data: desiredData } = await supabase
    .from('guild_desired_state')
    .select('*')
    .eq('guild_id', guild.id)
    .single();

  if (!desiredData) {
    // No desired state configured yet — nothing to sync
    return { driftItems: [], repaired: 0, timestamp };
  }

  const desiredState: DesiredState = {
    everyonePermissions: '0',
    roles: desiredData.roles as DesiredState['roles'],
    categories: [], // Derived from channels
    channels: desiredData.channels as DesiredState['channels'],
  };

  // 2. Take snapshot of current Discord state
  const actualState = await takeSnapshot(guild);

  // 3. Load ID mappings
  const { data: mappings } = await supabase
    .from('discord_id_map')
    .select('*')
    .eq('guild_id', guild.id);

  const idMap = new Map<string, string>();
  for (const m of mappings ?? []) {
    idMap.set(m.template_key, m.discord_id);
  }

  // 4. Compute diff
  const diff = computeStateDiff(desiredState, actualState, idMap);

  // 5. Classify drift
  const rawDriftItems = classifyDrift(diff);

  // Filter out community-required channels and ticket channels.
  // Community channels (rules, moderator-only, public-updates) are created by Discord
  // itself when Community features are enabled — they're not user drift.
  // Ticket channels are dynamically created/closed by the bot.
  const communityNames = new Set<string>();
  const rulesChannel = guild.rulesChannelId ? guild.channels.cache.get(guild.rulesChannelId) : null;
  const updatesChannel = guild.publicUpdatesChannelId ? guild.channels.cache.get(guild.publicUpdatesChannelId) : null;
  if (rulesChannel) communityNames.add(rulesChannel.name);
  if (updatesChannel) communityNames.add(updatesChannel.name);
  communityNames.add('moderator-only');

  const driftItems = rawDriftItems.filter((item) => {
    if (item.entityType !== 'channel') return true;
    // Skip community-required channels
    if (communityNames.has(item.entityName)) return false;
    // Skip ticket channels (ticket-NNN-username pattern)
    if (/^ticket-\d+/.test(item.entityName)) return false;
    return true;
  });

  let repaired = 0;

  // 6. Auto-repair @everyone if configured
  if (config.autoRepairEveryone && diff.everyoneDrift) {
    try {
      const everyoneRole = guild.roles.everyone;
      await everyoneRole.setPermissions(0n, 'SomniBot auto-repair — @everyone must be 0');
      repaired++;
      console.log('[Sync] Auto-repaired @everyone permissions to 0');
    } catch (err) {
      console.error('[Sync] Failed to auto-repair @everyone:', err);
    }
  }

  // 7. Auto-repair other drift if configured
  if (config.autoRepair) {
    // TODO: Implement granular auto-repair for roles/channels
    // This is complex and needs careful ordering — deferred to Phase 5 full implementation
  }

  // 8. Store drift status in Supabase
  await supabase
    .from('guild_desired_state')
    .update({
      last_sync_at: timestamp,
      drift_detected: driftItems.length > 0,
      drift_details: driftItems,
    })
    .eq('guild_id', guild.id);

  // 9. Emit event if drift detected
  if (driftItems.length > 0) {
    eventBus.emit('drift.detected', guild.id, {
      driftCount: driftItems.length,
      criticalCount: driftItems.filter(d => d.severity === 'critical').length,
      autoRepaired: repaired > 0,
      items: driftItems.map(d => ({
        type: d.type,
        entityName: d.entityName,
        severity: d.severity,
      })),
    });
  }

  // 10. Write audit log
  if (driftItems.length > 0) {
    await supabase.from('audit_logs').insert({
      guild_id: guild.id,
      actor_type: 'system',
      action: 'drift.detected',
      target_type: 'guild',
      target_id: guild.id,
      details: {
        driftCount: driftItems.length,
        criticalCount: driftItems.filter(d => d.severity === 'critical').length,
        items: driftItems.map(d => ({
          type: d.type,
          entity: d.entityName,
          severity: d.severity,
        })),
      },
    });
  }

  return { driftItems, repaired, timestamp };
}

/**
 * Start the periodic sync scheduler.
 */
export function startSyncScheduler(
  guild: Guild,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
  initialConfig: SyncConfig,
): { stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;

    try {
      // Reload config from DB each cycle
      const { data: guildConfig } = await supabase
        .from('guild_config')
        .select('sync_enabled, sync_interval_minutes, sync_auto_repair, sync_auto_repair_everyone')
        .eq('guild_id', guild.id)
        .single();

      const config: SyncConfig = {
        enabled: guildConfig?.sync_enabled ?? initialConfig.enabled,
        intervalMinutes: guildConfig?.sync_interval_minutes ?? initialConfig.intervalMinutes,
        autoRepair: guildConfig?.sync_auto_repair ?? initialConfig.autoRepair,
        autoRepairEveryone: guildConfig?.sync_auto_repair_everyone ?? initialConfig.autoRepairEveryone,
      };

      if (!config.enabled) {
        running = false;
        return;
      }

      const result = await runSyncCycle(guild, supabase, eventBus, config);

      if (result.driftItems.length > 0) {
        console.log(
          `[Sync] Drift detected: ${result.driftItems.length} items (${result.repaired} auto-repaired)`,
        );
      }
    } catch (err) {
      console.error('[Sync] Cycle error:', err);
    } finally {
      running = false;
    }
  };

  // Initial run after 30 seconds
  setTimeout(run, 30_000);

  // Schedule periodic runs
  timer = setInterval(run, initialConfig.intervalMinutes * 60 * 1000);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
