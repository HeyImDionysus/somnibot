/**
 * Sync Engine
 *
 * Periodically compares Discord actual state against desired state.
 * Reports drift to the dashboard via Supabase, optionally auto-repairs.
 */

import type { Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeStateDiff, classifyDrift, type DesiredState, type DriftItem , createLogger } from '@somnibot/shared';
import { takeSnapshot } from './snapshot.js';
import type { PlatformEventBus } from '../services/event-bus.js';

const log = createLogger('SyncEngine');

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
      log.info('Auto-repaired @everyone permissions to 0');
    } catch (err) {
      log.error('Failed to auto-repair @everyone:', { error: String(err) });
    }
  }

  // 7. Auto-repair other drift if configured (V53 Phase 4 — Finding 4.1)
  if (config.autoRepair) {
    for (const item of driftItems) {
      if (item.suggestedAction !== 'repair') continue;

      try {
        const repairResult = await repairDriftItem(guild, supabase, item, idMap);
        if (repairResult.success) {
          repaired++;
          log.info(`Auto-repaired ${item.entityType} "${item.entityName}": ${repairResult.action}`);
        } else if (repairResult.action === 'manual_required') {
          log.info(`"${item.entityName}" needs manual attention: ${repairResult.reason}`);
        }
      } catch (err) {
        log.error(`Failed to auto-repair ${item.entityType} "${item.entityName}":`, err);
      }
    }

    // Post sync report to alert channel if anything was repaired or needs attention
    if (repaired > 0 || driftItems.some(d => d.suggestedAction === 'accept')) {
      await postSyncReport(guild, supabase, eventBus, driftItems, repaired, timestamp);
    }
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
      actor_id: 'sync-engine',
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
        log.info(
          `[Sync] Drift detected: ${result.driftItems.length} items (${result.repaired} auto-repaired)`,
        );
      }
    } catch (err) {
      log.error('Cycle error:', { error: String(err) });
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

// ── V53 Phase 4 (4.1): Auto-Repair Helpers ───────────────────────

interface RepairResult {
  success: boolean;
  action: string;
  reason?: string;
}

/**
 * Attempt to repair a single drift item.
 * Returns success/failure and description of what was done.
 */
async function repairDriftItem(
  guild: Guild,
  supabase: SupabaseClient,
  item: DriftItem,
  idMap: Map<string, string>,
): Promise<RepairResult> {
  // Use DriftType + entityType to determine the right repair action
  switch (item.type) {
    case 'MISSING_RESOURCE': {
      if (item.entityType === 'role') {
        // Role was deleted — recreate from desired state
        const roleKey = findKeyForEntity(idMap, item.entityDiscordId, 'role');
        if (!roleKey) return { success: false, action: 'manual_required', reason: 'No template key found' };

        const { data: desired } = await supabase
          .from('guild_desired_state')
          .select('roles')
          .eq('guild_id', guild.id)
          .single();

        const desiredRoles = (desired?.roles ?? []) as Array<{ key: string; name: string; color?: number; permissions?: string; hoist?: boolean; mentionable?: boolean }>;
        const roleDef = desiredRoles.find(r => r.key === roleKey);
        if (!roleDef) return { success: false, action: 'manual_required', reason: 'Role not in desired state' };

        const created = await guild.roles.create({
          name: roleDef.name,
          color: roleDef.color ?? 0,
          permissions: BigInt(roleDef.permissions ?? '0'),
          hoist: roleDef.hoist ?? false,
          mentionable: roleDef.mentionable ?? false,
          reason: 'SomniBot sync auto-repair — recreated missing role',
        });

        await supabase.from('discord_id_map').upsert({
          guild_id: guild.id,
          template_key: `role:${roleKey}`,
          discord_id: created.id,
        }, { onConflict: 'guild_id,template_key' });

        return { success: true, action: `Recreated role "${roleDef.name}" (${created.id})` };
      }

      if (item.entityType === 'channel' || item.entityType === 'category') {
        // Channel/category deleted — recreate from desired state
        const chanKey = findKeyForEntity(idMap, item.entityDiscordId, item.entityType);
        if (!chanKey) return { success: false, action: 'manual_required', reason: 'No template key found' };

        const { data: desired } = await supabase
          .from('guild_desired_state')
          .select('channels')
          .eq('guild_id', guild.id)
          .single();

        const desiredChannels = (desired?.channels ?? []) as Array<{ key: string; name: string; type?: number; parentKey?: string; topic?: string }>;
        const chanDef = desiredChannels.find(c => c.key === chanKey);
        if (!chanDef) return { success: false, action: 'manual_required', reason: 'Channel not in desired state' };

        const parentId = chanDef.parentKey ? idMap.get(`category:${chanDef.parentKey}`) ?? undefined : undefined;
        const created = await guild.channels.create({
          name: chanDef.name,
          type: chanDef.type ?? 0,
          parent: parentId,
          topic: chanDef.topic,
          reason: 'SomniBot sync auto-repair — recreated missing channel',
        }) as { id: string };

        await supabase.from('discord_id_map').upsert({
          guild_id: guild.id,
          template_key: `${item.entityType}:${chanKey}`,
          discord_id: created.id,
        }, { onConflict: 'guild_id,template_key' });

        return { success: true, action: `Recreated ${item.entityType} "${chanDef.name}" (${created.id})` };
      }

      return { success: false, action: 'manual_required', reason: `Missing ${item.entityType} repair not supported` };
    }

    case 'PERMISSION_DRIFT':
    case 'EVERYONE_DRIFT': {
      if (item.entityType === 'role' || item.entityType === 'everyone') {
        // Role permissions changed — restore
        if (!item.entityDiscordId) return { success: false, action: 'manual_required', reason: 'No Discord ID' };
        const role = guild.roles.cache.get(item.entityDiscordId);
        if (!role) return { success: false, action: 'manual_required', reason: 'Role not in cache' };
        if (role.managed) return { success: false, action: 'manual_required', reason: 'Role is managed by an integration' };

        const expected = item.details?.permissions?.expected;
        if (typeof expected === 'string') {
          await role.setPermissions(BigInt(expected), 'SomniBot sync auto-repair');
          return { success: true, action: `Restored permissions on "${role.name}"` };
        }
        return { success: false, action: 'manual_required', reason: 'No expected permissions in drift details' };
      }

      // Channel/category permission repairs are complex — require manual intervention
      return { success: false, action: 'manual_required', reason: `${item.entityType} permission repair requires manual review` };
    }

    case 'EXTRA_RESOURCE': {
      // Extra entities not in desired state — never auto-delete, just surface
      return { success: false, action: 'manual_required', reason: `Extra ${item.entityType} not in desired config — manual cleanup recommended` };
    }

    case 'EXTERNAL_CHANGE':
    case 'HIERARCHY_DRIFT':
    default:
      return { success: false, action: 'manual_required', reason: `Repair not implemented for ${item.type}` };
  }
}

/**
 * Find the template key for a Discord entity ID in the ID map.
 */
function findKeyForEntity(
  idMap: Map<string, string>,
  discordId: string | undefined,
  prefix: string,
): string | undefined {
  if (!discordId) return undefined;
  for (const [key, id] of idMap) {
    if (id === discordId && key.startsWith(`${prefix}:`)) {
      return key.slice(prefix.length + 1);
    }
  }
  return undefined;
}

/**
 * Post a sync report to the alert channel after auto-repair.
 */
async function postSyncReport(
  guild: Guild,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
  driftItems: DriftItem[],
  repairedCount: number,
  timestamp: string,
): Promise<void> {
  const needsAttention = driftItems.filter(d => d.suggestedAction === 'accept' || d.suggestedAction === 'ignore');
  const repaired = driftItems.filter(d => d.suggestedAction === 'repair');

  const reportLines: string[] = [
    `**Sync Report — ${new Date(timestamp).toLocaleString()}**`,
    '',
    `✅ Auto-repaired: ${repairedCount}`,
    `⚠️ Needs attention: ${needsAttention.length}`,
    `📊 Total drift items: ${driftItems.length}`,
  ];

  if (repairedCount > 0) {
    reportLines.push('', '**Repaired:**');
    for (const item of repaired) {
      reportLines.push(`  • ${item.entityType} "${item.entityName}" — ${item.description}`);
    }
  }

  if (needsAttention.length > 0) {
    reportLines.push('', '**Needs Manual Attention:**');
    for (const item of needsAttention) {
      reportLines.push(`  • ${item.entityType} "${item.entityName}" — ${item.description}`);
    }
  }

  eventBus.emit('sync.report' as never, guild.id, {
    report: reportLines.join('\n'),
    repairedCount,
    needsAttentionCount: needsAttention.length,
    totalDrift: driftItems.length,
    timestamp,
  } as never);

  // Also store report in DB for dashboard access
  await supabase.from('sync_reports').insert({
    guild_id: guild.id,
    repaired_count: repairedCount,
    attention_count: needsAttention.length,
    total_drift: driftItems.length,
    details: { items: driftItems },
    created_at: timestamp,
  }).then(({ error }) => {
    if (error) log.error('Failed to store sync report:', error.message);
  });
}
