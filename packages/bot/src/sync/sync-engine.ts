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
  const startedAt = Date.now();

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
    .eq('guild_id', guild.id)
    .limit(1000);

  const idMap = new Map<string, string>();
  // Entity-typed map keyed by `${entity_type}:${bareKey}`. The flat `idMap`
  // above collapses rows that share a bare template_key across entity types
  // (a role and a channel both keyed `staff`), so hierarchy resolution needs
  // this entity-scoped view to avoid resolving a role key to a channel's ID.
  const entityIdMap = new Map<string, string>();
  for (const m of mappings ?? []) {
    idMap.set(m.template_key, m.discord_id);
    if (m.entity_type) {
      const bare = String(m.template_key).includes(':')
        ? String(m.template_key).slice(String(m.template_key).indexOf(':') + 1)
        : String(m.template_key);
      entityIdMap.set(`${m.entity_type}:${bare}`, m.discord_id);
    }
  }

  const managedCommunityChannelIds = new Set(
    [guild.rulesChannelId, guild.publicUpdatesChannelId, guild.safetyAlertsChannelId]
      .filter((channelId): channelId is string => typeof channelId === 'string'),
  );
  for (const mapping of mappings ?? []) {
    if (mapping.entity_type !== 'channel'
      || (mapping.template_key !== 'channel:moderator-only' && mapping.template_key !== 'moderator-only')
      || typeof mapping.discord_id !== 'string') continue;
    managedCommunityChannelIds.add(mapping.discord_id);
  }
  const ticketChannelIds = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data: tickets } = await supabase
      .from('tickets')
      .select('channel_id')
      .eq('guild_id', guild.id)
      .in('status', ['open', 'claimed'])
      .range(offset, offset + 999);
    for (const ticket of tickets ?? []) {
      if (typeof ticket.channel_id === 'string') ticketChannelIds.add(ticket.channel_id);
    }
    if (!tickets || tickets.length < 1000) break;
  }

  // 4. Compute diff
  const diff = computeStateDiff(desiredState, actualState, idMap, entityIdMap);

  // 5. Classify drift
  const rawDriftItems = classifyDrift(diff);

  const driftItems = rawDriftItems.filter((item) => {
    if (item.entityType !== 'channel') return true;
    if (item.entityDiscordId && managedCommunityChannelIds.has(item.entityDiscordId)) return false;
    if (item.entityDiscordId && ticketChannelIds.has(item.entityDiscordId)) return false;
    return true;
  });

  let repaired = 0;

  // 6. Auto-repair @everyone only when BOTH general auto-repair and the explicit
  //    @everyone opt-in are on. Gating on autoRepairEveryone alone let a guild that
  //    never enabled auto-repair silently reset @everyone's permissions to 0.
  if (config.autoRepair && config.autoRepairEveryone && diff.everyoneDrift) {
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
      if (item.type === 'EVERYONE_DRIFT') continue;

      try {
        const repairResult = await repairDriftItem(guild, supabase, item, idMap, entityIdMap);
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

  // 11. Emit sync.completed so each periodic reconcile cycle lands an
  //     append-only audit_logs row (previously the sync.completed audit
  //     mapping was dead — nothing ever emitted it).
  eventBus.emit('sync.completed', guild.id, {
    driftItemsFound: driftItems.length,
    itemsRepaired: repaired,
    itemsAccepted: driftItems.filter(d => d.suggestedAction === 'accept').length,
    duration: Date.now() - startedAt,
  });

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
): {
  stop: () => Promise<void>;
  reconfigure: (intervalMinutes?: number, runImmediately?: boolean) => void;
} {
  let timer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;
  let activeRun: Promise<void> | null = null;
  let currentIntervalMinutes = initialConfig.intervalMinutes;

  const arm = (intervalMinutes: number) => {
    if (stopped || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return;
    if (timer) clearInterval(timer);
    currentIntervalMinutes = intervalMinutes;
    timer = setInterval(run, intervalMinutes * 60 * 1000);
  };

  const reconfigure = (intervalMinutes?: number, runImmediately = false) => {
    if (stopped) return;
    if (intervalMinutes !== undefined) arm(intervalMinutes);
    if (runImmediately) void run();
  };

  const run = (): Promise<void> => {
    if (stopped || running) return Promise.resolve();
    running = true;

    const cycle = (async () => {
      try {
      // Reload config from DB each cycle
      const { data: guildConfig } = await supabase
        .from('guild_config')
        .select('sync_enabled, sync_interval_minutes, sync_auto_repair, sync_auto_repair_everyone')
        .eq('guild_id', guild.id)
        .single();

      if (stopped) return;

      const config: SyncConfig = {
        enabled: guildConfig?.sync_enabled ?? initialConfig.enabled,
        intervalMinutes: guildConfig?.sync_interval_minutes ?? initialConfig.intervalMinutes,
        autoRepair: guildConfig?.sync_auto_repair ?? initialConfig.autoRepair,
        autoRepairEveryone: guildConfig?.sync_auto_repair_everyone ?? initialConfig.autoRepairEveryone,
      };

      if (config.intervalMinutes !== currentIntervalMinutes) {
        arm(config.intervalMinutes);
      }

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
      if (stopped) return;
      log.error('Cycle error:', { error: String(err) });
      // A failed reconcile cycle must leave a durable audit_logs row, not just a
      // transient log line — mirror it via the sync.failed audit mapping.
      eventBus.emit('sync.failed', guild.id, {
        error: err instanceof Error ? err.message : String(err),
        stage: 'cycle',
      });
      } finally {
      running = false;
      }
    })();
    activeRun = cycle;
    void cycle.then(
      () => { if (activeRun === cycle) activeRun = null; },
      () => { if (activeRun === cycle) activeRun = null; },
    );
    return cycle;
  };

  // Initial run after 30 seconds
  initialTimer = setTimeout(run, 30_000);

  // Schedule periodic runs
  arm(initialConfig.intervalMinutes);

  return {
    reconfigure,
    stop: async () => {
      stopped = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (timer) clearInterval(timer);
      await activeRun;
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
  entityIdMap?: Map<string, string>,
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

        const desiredRoles = (desired?.roles ?? []) as Array<DesiredRoleDef & { name: string }>;
        const roleDef = desiredRoles.find(r => stripPrefix(desiredKeyOf(r)) === stripPrefix(roleKey));
        if (!roleDef) return { success: false, action: 'manual_required', reason: 'Role not in desired state' };

        const created = await guild.roles.create({
          name: roleDef.name,
          colors: { primaryColor: roleDef.color ?? 0 },
          permissions: BigInt(roleDef.permissions ?? '0'),
          hoist: roleDef.hoist ?? false,
          mentionable: roleDef.mentionable ?? false,
          reason: 'SomniBot sync auto-repair — recreated missing role',
        });

        await supabase.from('discord_id_map').upsert({
          guild_id: guild.id,
          entity_type: 'role',
          template_key: `role:${roleKey}`,
          discord_id: created.id,
        }, { onConflict: 'guild_id,entity_type,template_key' });

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

        const desiredChannels = (desired?.channels ?? []) as Array<DesiredChannelDef & { name: string; parentKey?: string }>;
        const chanDef = desiredChannels.find(c => stripPrefix(desiredKeyOf(c)) === stripPrefix(chanKey));
        if (!chanDef) return { success: false, action: 'manual_required', reason: 'Channel not in desired state' };

        const parentId = chanDef.parentKey ? resolveDiscordId(idMap, 'category', chanDef.parentKey) : undefined;
        const created = await guild.channels.create({
          name: chanDef.name,
          type: chanDef.type ?? 0,
          parent: parentId,
          topic: chanDef.topic ?? undefined,
          reason: 'SomniBot sync auto-repair — recreated missing channel',
        }) as { id: string };

        await supabase.from('discord_id_map').upsert({
          guild_id: guild.id,
          entity_type: item.entityType,
          template_key: `${item.entityType}:${chanKey}`,
          discord_id: created.id,
        }, { onConflict: 'guild_id,entity_type,template_key' });

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

    case 'EXTERNAL_CHANGE': {
      // A tracked entity was modified outside the dashboard — re-apply desired state.
      if (item.entityType === 'role') {
        return await reapplyRoleDesiredState(guild, supabase, item, idMap);
      }
      if (item.entityType === 'channel') {
        return await reapplyChannelDesiredState(guild, supabase, item, idMap);
      }
      if (item.entityType === 'category') {
        // Categories are not persisted in guild_desired_state (only `roles` and
        // `channels` JSONB columns exist — category defs are derived from channel
        // `categoryKey`s at deploy time and never stored). There is therefore no
        // desired category name to restore to, so routing this through the
        // channel helper would only ever return a misleading "not in desired
        // state" error. Surface it honestly for manual attention instead.
        return {
          success: false,
          action: 'manual_required',
          reason: 'Category external changes have no persisted desired state to restore — manual review required',
        };
      }
      return { success: false, action: 'manual_required', reason: `External change repair not supported for ${item.entityType}` };
    }

    case 'HIERARCHY_DRIFT': {
      // Role positions drifted from desired ordering — reorder to desired.
      if (item.entityType !== 'role') {
        return { success: false, action: 'manual_required', reason: `Hierarchy repair not supported for ${item.entityType}` };
      }
      return await reorderRolesToDesired(guild, supabase, item, idMap, entityIdMap);
    }

    default:
      return { success: false, action: 'manual_required', reason: `Repair not implemented for ${item.type}` };
  }
}

interface DesiredRoleDef {
  // Guilds store the key variantly depending on which write path produced the
  // row: `key` (diff engine), `template_key`/`templateKey` (deploy/accept path).
  key?: string;
  template_key?: string;
  templateKey?: string;
  name?: string;
  color?: number;
  permissions?: string;
  hoist?: boolean;
  mentionable?: boolean;
  position?: number;
}

interface DesiredChannelDef {
  key?: string;
  template_key?: string;
  templateKey?: string;
  name?: string;
  type?: number;
  topic?: string | null;
  slowmode?: number;
  nsfw?: boolean;
}

/**
 * Re-apply a role's desired state after an external (non-permission) change:
 * name / color / hoist / mentionable. Permissions are handled by PERMISSION_DRIFT.
 * Idempotent — Discord's edit is a no-op when values already match.
 */
async function reapplyRoleDesiredState(
  guild: Guild,
  supabase: SupabaseClient,
  item: DriftItem,
  idMap: Map<string, string>,
): Promise<RepairResult> {
  if (!item.entityDiscordId) return { success: false, action: 'manual_required', reason: 'No Discord ID' };

  const role = guild.roles.cache.get(item.entityDiscordId);
  if (!role) return { success: false, action: 'manual_required', reason: 'Role not in cache' };
  if (role.managed) return { success: false, action: 'manual_required', reason: 'Role is managed by an integration' };

  // Discord constraint: the bot can only edit roles strictly below its own highest role.
  const botHighest = guild.members.me?.roles.highest.position;
  if (typeof botHighest === 'number' && role.position >= botHighest) {
    return { success: false, action: 'manual_required', reason: `Role "${role.name}" is at or above the bot's highest role — cannot edit` };
  }

  const roleKey = item.templateKey ?? findKeyForEntity(idMap, item.entityDiscordId, 'role');
  if (!roleKey) return { success: false, action: 'manual_required', reason: 'No template key found' };

  const { data: desired } = await supabase
    .from('guild_desired_state')
    .select('roles')
    .eq('guild_id', guild.id)
    .single();

  const desiredRoles = (desired?.roles ?? []) as DesiredRoleDef[];
  const roleDef = desiredRoles.find(r => stripPrefix(desiredKeyOf(r)) === stripPrefix(roleKey));
  if (!roleDef) return { success: false, action: 'manual_required', reason: 'Role not in desired state' };

  await role.edit({
    name: roleDef.name ?? role.name,
    color: roleDef.color ?? role.color,
    hoist: roleDef.hoist ?? role.hoist,
    mentionable: roleDef.mentionable ?? role.mentionable,
    reason: 'SomniBot sync auto-repair — re-applied desired state after external change',
  });

  return { success: true, action: `Re-applied desired state to role "${roleDef.name ?? role.name}"` };
}

/**
 * Re-apply a channel's desired state after an external change:
 * name / topic / slowmode / nsfw. Idempotent.
 */
async function reapplyChannelDesiredState(
  guild: Guild,
  supabase: SupabaseClient,
  item: DriftItem,
  idMap: Map<string, string>,
): Promise<RepairResult> {
  if (!item.entityDiscordId) return { success: false, action: 'manual_required', reason: 'No Discord ID' };

  const channel = guild.channels.cache.get(item.entityDiscordId) as
    | ({ name: string; edit: (opts: Record<string, unknown>) => Promise<unknown>; topic?: unknown; nsfw?: unknown; rateLimitPerUser?: unknown })
    | undefined;
  if (!channel) return { success: false, action: 'manual_required', reason: 'Channel not in cache' };

  const chanKey = item.templateKey ?? findKeyForEntity(idMap, item.entityDiscordId, item.entityType);
  if (!chanKey) return { success: false, action: 'manual_required', reason: 'No template key found' };

  const { data: desired } = await supabase
    .from('guild_desired_state')
    .select('channels')
    .eq('guild_id', guild.id)
    .single();

  const desiredChannels = (desired?.channels ?? []) as DesiredChannelDef[];
  const chanDef = desiredChannels.find(c => stripPrefix(desiredKeyOf(c)) === stripPrefix(chanKey));
  if (!chanDef) return { success: false, action: 'manual_required', reason: 'Channel not in desired state' };

  const editOptions: Record<string, unknown> = {};
  if (chanDef.name !== undefined) editOptions.name = chanDef.name;
  if ('topic' in channel && chanDef.topic !== undefined) editOptions.topic = chanDef.topic;
  if ('nsfw' in channel && chanDef.nsfw !== undefined) editOptions.nsfw = chanDef.nsfw;
  if ('rateLimitPerUser' in channel && chanDef.slowmode !== undefined) editOptions.rateLimitPerUser = chanDef.slowmode;

  await channel.edit({
    ...editOptions,
    reason: 'SomniBot sync auto-repair — re-applied desired state after external change',
  });

  return { success: true, action: `Re-applied desired state to ${item.entityType} "${chanDef.name ?? channel.name}"` };
}

/**
 * Reorder roles to their desired relative positions.
 *
 * Desired state stores each role with a relative `position` (higher = higher in
 * the hierarchy). We assign absolute positions immediately below the bot's own
 * highest role, mirroring the deploy flow. Discord only lets the bot move roles
 * strictly below its highest role, so:
 *   - roles at/above the bot are excluded from the reorder set, and
 *   - if the drifted target itself is at/above the bot, that's genuinely
 *     impossible → manual_required.
 * Idempotent — when the current ordering already matches desired, no API call
 * is made.
 */
async function reorderRolesToDesired(
  guild: Guild,
  supabase: SupabaseClient,
  item: DriftItem,
  idMap: Map<string, string>,
  entityIdMap?: Map<string, string>,
): Promise<RepairResult> {
  const botHighest = guild.members.me?.roles.highest.position;
  if (typeof botHighest !== 'number') {
    return { success: false, action: 'manual_required', reason: "Bot's highest role position is unknown" };
  }

  // The drifted target must be below the bot to be movable at all.
  if (item.entityDiscordId) {
    const targetRole = guild.roles.cache.get(item.entityDiscordId);
    if (targetRole && targetRole.position >= botHighest) {
      return {
        success: false,
        action: 'manual_required',
        reason: `Role "${targetRole.name}" is at or above the bot's highest role — the bot cannot move it`,
      };
    }
  }

  const { data: desired } = await supabase
    .from('guild_desired_state')
    .select('roles')
    .eq('guild_id', guild.id)
    .single();

  const desiredRoles = (desired?.roles ?? []) as DesiredRoleDef[];
  if (desiredRoles.length === 0) {
    return { success: false, action: 'manual_required', reason: 'No desired roles configured' };
  }

  // Resolve each desired role to a live Discord role. A desired role that
  // resolves to a live, non-managed role sitting at/above the bot is a *blocker*:
  // the bot cannot move it, so the full desired ordering is unachievable. We must
  // NOT silently drop such a role and reorder only the remainder — doing so can
  // turn an impossible repair into a false success (the excluded role keeps the
  // hierarchy drifted while the movable subset looks "already ordered").
  const sorted = [...desiredRoles].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const movable: Array<{ id: string; currentPosition: number }> = [];
  for (const def of sorted) {
    const defKey = desiredKeyOf(def);
    if (!defKey) continue;
    // ID map may store keys prefixed (`role:mod`) or bare (`mod`); try both.
    // Pass the entity-typed map so a bare-key collision with a channel/category
    // of the same key cannot resolve this role to the wrong Discord ID.
    const discordId = resolveDiscordId(idMap, 'role', defKey, entityIdMap);
    if (!discordId) continue;
    const role = guild.roles.cache.get(discordId);
    if (!role) continue;
    if (role.managed) continue; // managed roles are Discord-controlled, not part of the reorder
    if (role.position >= botHighest) {
      // A desired, movable-in-principle role that is currently at/above the bot
      // blocks a correct reorder — surface it for manual attention.
      return {
        success: false,
        action: 'manual_required',
        reason: `Role "${role.name}" is at or above the bot's highest role — the bot cannot reorder the hierarchy while it stays there`,
      };
    }
    movable.push({ id: discordId, currentPosition: role.position });
  }

  if (movable.length === 0) {
    return { success: false, action: 'manual_required', reason: 'No movable roles resolved from desired state' };
  }

  // Target absolute positions: contiguous band immediately below the bot,
  // preserving desired relative order (lowest desired position → lowest slot).
  const positionUpdates = movable.map((entry, index) => ({
    role: entry.id,
    position: Math.max(1, botHighest - movable.length + index),
  }));

  // Idempotent: skip the API call when the current relative ordering already
  // matches the desired ordering. The diff engine treats equal actual positions
  // as ordered (Discord positions are not guaranteed unique), so a tie is not an
  // inversion here either — only a strict decrease means the hierarchy drifted.
  const alreadyOrdered = movable.every((entry, index) => {
    if (index === 0) return true;
    return entry.currentPosition >= movable[index - 1].currentPosition;
  });
  if (alreadyOrdered) {
    return { success: true, action: 'Role hierarchy already matches desired order' };
  }

  await guild.roles.setPositions(positionUpdates);
  return { success: true, action: `Reordered ${positionUpdates.length} role(s) to desired hierarchy` };
}

/**
 * Strip a leading "prefix:" (e.g. "role:mod" → "mod"). Desired-state keys and
 * ID-map keys are stored inconsistently with/without the entity-type prefix.
 * Tolerates undefined/empty input (some desired-state rows omit `key` entirely).
 */
function stripPrefix(key: string | undefined | null): string {
  if (!key) return '';
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/**
 * Read a desired-state entry's template key regardless of which shape the guild
 * stored it as. The deploy/accept paths write `template_key`/`templateKey`,
 * while the diff engine and older rows use `key`. Any of the three is accepted.
 */
function desiredKeyOf(
  entry: { key?: string; template_key?: string; templateKey?: string },
): string | undefined {
  return entry.key ?? entry.template_key ?? entry.templateKey;
}

/**
 * Resolve a desired-state entry's template key to a live Discord ID via the ID
 * map, tolerating both prefixed (`role:mod`) and unprefixed (`mod`) storage on
 * either side. The deploy listener persists raw keys (`template_key: m.key`),
 * while the recreate path writes prefixed keys — so we try every combination.
 */
function resolveDiscordId(
  idMap: Map<string, string>,
  prefix: 'role' | 'channel' | 'category',
  rawKey: string,
  entityIdMap?: Map<string, string>,
): string | undefined {
  const bare = stripPrefix(rawKey);
  // Prefer the flat prefixed key first (already entity-scoped), then the
  // entity-typed map, which is the only source that survives a bare-key
  // collision across entity types (a role and a channel both keyed `staff`).
  const prefixed = idMap.get(`${prefix}:${bare}`);
  if (prefixed) return prefixed;
  if (entityIdMap) {
    const typed = entityIdMap.get(`${prefix}:${bare}`) ?? entityIdMap.get(`${prefix}:${rawKey}`);
    if (typed) return typed;
  }
  // Bare/raw fallback — but reject a hit that the entity-typed map shows belongs
  // to a DIFFERENT entity type, so a channel row keyed `staff` cannot resolve as
  // the role `staff`.
  const bareHit = idMap.get(bare) ?? idMap.get(rawKey) ?? idMap.get(`${prefix}:${rawKey}`);
  if (bareHit && entityIdMap && isForeignEntityId(entityIdMap, prefix, bareHit)) {
    return undefined;
  }
  return bareHit;
}

/**
 * True when `discordId` is registered in `entityIdMap` under an entity type
 * other than `entityType` — used to reject a bare-key collision that actually
 * belongs to a different entity.
 */
function isForeignEntityId(
  entityIdMap: Map<string, string>,
  entityType: 'role' | 'channel' | 'category',
  discordId: string,
): boolean {
  for (const [key, id] of entityIdMap) {
    if (id !== discordId) continue;
    const type = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
    if (type !== entityType) return true;
  }
  return false;
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

  eventBus.emit('sync.report', guild.id, {
    report: reportLines.join('\n'),
    repairedCount,
    needsAttentionCount: needsAttention.length,
    totalDrift: driftItems.length,
    timestamp,
  });

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
