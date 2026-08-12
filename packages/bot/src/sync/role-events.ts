/**
 * Role Event Drift Detection
 *
 * Detects drift in real-time when roles are created, updated, or deleted
 * outside of the dashboard/deployer. Complements the periodic sync cycle
 * with instant event-based detection.
 *
 * Architecture doc §15: "Event-based drift detection (role/channel update events)"
 */

import type { Guild, Role } from 'discord.js';
import type { SomniClient } from '../client.js';
import type { DriftItem, DriftSeverity, DriftType } from '@somnibot/shared';
import { writeAuditLog } from '../services/audit.js';
import { createLogger } from '@somnibot/shared';
import { queueDriftItem } from './drift-debouncer.js';

const log = createLogger('RoleEvents');

/**
 * Handle roleCreate — a new role was created outside the dashboard.
 */
export async function handleRoleCreate(
  client: SomniClient,
  role: Role,
): Promise<void> {
  if (role.managed) return; // Bot/integration roles are expected

  // Check if this role is tracked in our ID map (created by deployer)
  const { data: mapping } = await client.supabase
    .from('discord_id_map')
    .select('template_key')
    .eq('guild_id', role.guild.id)
    .eq('discord_id', role.id)
    .maybeSingle();

  if (mapping) return; // This was created by us — not drift

  log.info(`[Sync:Drift] New role created externally: "${role.name}" (${role.id})`);

  const driftItem: DriftItem = {
    type: 'EXTRA_RESOURCE',
    severity: 'info',
    entityType: 'role',
    entityName: role.name,
    entityDiscordId: role.id,
    description: `Role "${role.name}" was created outside the dashboard`,
    suggestedAction: 'accept',
  };

  // V5 Audit §14.P3a: Debounce non-critical drift to batch rapid events
  queueDriftItem(client, role.guild.id, driftItem);
}

/**
 * Handle roleUpdate — a tracked role was modified outside the dashboard.
 */
export async function handleRoleUpdate(
  client: SomniClient,
  oldRole: Role,
  newRole: Role,
): Promise<void> {

  // Check @everyone specifically
  if (newRole.id === newRole.guild.id) {
    if (newRole.permissions.bitfield !== 0n) {
      log.info(`[Sync:Drift] CRITICAL — @everyone permissions changed to ${newRole.permissions.bitfield}`);

      const driftItem: DriftItem = {
        type: 'EVERYONE_DRIFT',
        severity: 'critical',
        entityType: 'everyone',
        entityName: '@everyone',
        description: '@everyone has non-zero permissions. This breaks the onboarding model.',
        details: { permissions: { expected: '0', actual: newRole.permissions.bitfield.toString() } },
        suggestedAction: 'repair',
      };

      // Auto-repair @everyone if configured
      const config = await getSyncConfig(client, newRole.guild.id);
      if (config.autoRepair && config.autoRepairEveryone) {
        try {
          await newRole.setPermissions(0n, 'SomniBot auto-repair — @everyone must be 0');
          log.info('[Sync:Drift] Auto-repaired @everyone permissions to 0');

          await writeAuditLog(client.supabase, {
            guildId: newRole.guild.id,
            actorType: 'bot',
            actorId: 'sync-engine',
            action: 'drift.auto_repair',
            category: 'sync',
            targetType: 'role',
            targetId: newRole.id,
            details: {
              type: 'EVERYONE_DRIFT',
              repairedPermissions: '0',
              previousPermissions: newRole.permissions.bitfield.toString(),
            },
          });
        } catch (err) {
          log.error('[Sync:Drift] Failed to auto-repair @everyone:', { error: String(err) });
        }
      }

      // V5 Audit §14.P3a: Critical — flush immediately, no debounce
      queueDriftItem(client, newRole.guild.id, driftItem, true);

      return;
    }
  }

  // Check if this role is tracked
  const { data: mapping } = await client.supabase
    .from('discord_id_map')
    .select('template_key')
    .eq('guild_id', newRole.guild.id)
    .eq('discord_id', newRole.id)
    .maybeSingle();

  if (!mapping) return; // Untracked role — we don't care about changes to it

  // Compare what changed
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (oldRole.name !== newRole.name) {
    changes['name'] = { from: oldRole.name, to: newRole.name };
  }
  if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
    changes['permissions'] = {
      from: oldRole.permissions.bitfield.toString(),
      to: newRole.permissions.bitfield.toString(),
    };
  }
  if (oldRole.color !== newRole.color) {
    changes['color'] = { from: oldRole.color, to: newRole.color };
  }
  if (oldRole.hoist !== newRole.hoist) {
    changes['hoist'] = { from: oldRole.hoist, to: newRole.hoist };
  }
  if (oldRole.mentionable !== newRole.mentionable) {
    changes['mentionable'] = { from: oldRole.mentionable, to: newRole.mentionable };
  }
  if (oldRole.position !== newRole.position) {
    changes['position'] = { from: oldRole.position, to: newRole.position };
  }

  if (Object.keys(changes).length === 0) return; // No meaningful changes

  const hasPermissionChange = 'permissions' in changes;
  // A pure position move (no permission/attribute change) is a hierarchy drift,
  // not a generic external change — it must be classified as HIERARCHY_DRIFT so
  // the sync engine's reorder repair (reorderRolesToDesired) is reachable.
  // Priority: permissions (security) > position > other attributes.
  const changeKeys = Object.keys(changes);
  const isPositionOnly =
    !hasPermissionChange &&
    changeKeys.includes('position') &&
    changeKeys.every((k) => k === 'position');

  // A role's numeric `position` shifts whenever ANY role above/below it is
  // added, removed, or moved — including untracked roles the dashboard never
  // manages. A bare numeric change that leaves the tracked roles in their
  // desired relative order is NOT hierarchy drift: the periodic diff (which
  // compares relative ordering, not absolute numbers) would not report it, and
  // queuing a HIERARCHY_DRIFT here produces a stale false item whose repair can
  // only no-op/clear. Only surface drift when the tracked roles are actually
  // out of desired order.
  if (isPositionOnly && !(await trackedRolesOutOfDesiredOrder(client, newRole.guild))) {
    log.info(
      `[Sync:Drift] Role "${newRole.name}" position changed but tracked roles remain in desired order — not drift`,
    );
    return;
  }

  let type: DriftType;
  let severity: DriftSeverity;
  if (hasPermissionChange) {
    type = 'PERMISSION_DRIFT';
    severity = 'warning';
  } else if (isPositionOnly) {
    type = 'HIERARCHY_DRIFT';
    severity = 'warning';
  } else {
    type = 'EXTERNAL_CHANGE';
    severity = 'info';
  }

  log.info(
    `[Sync:Drift] Role "${newRole.name}" modified externally:`,
    changeKeys.join(', '),
  );

  const driftItem: DriftItem = {
    type,
    severity,
    entityType: 'role',
    entityName: type === 'HIERARCHY_DRIFT' ? 'Role hierarchy' : newRole.name,
    entityDiscordId: newRole.id,
    templateKey: mapping.template_key,
    description:
      type === 'HIERARCHY_DRIFT'
        ? `Role "${newRole.name}" position changed outside the dashboard`
        : `Role "${newRole.name}" was modified outside the dashboard`,
    details: Object.fromEntries(
      Object.entries(changes).map(([k, v]) => [k, { expected: v.from, actual: v.to }]),
    ),
    suggestedAction: 'repair',
  };

  // Auto-repair if configured. A pure position move is reconciled by the
  // periodic sync cycle's reorder repair (which needs the full role set), not
  // by the per-role attribute repair — so only re-apply attributes here when
  // the change is not position-only.
  const config = await getSyncConfig(client, newRole.guild.id);
  if (config.autoRepair && !isPositionOnly) {
    await autoRepairRole(client, newRole, mapping.template_key);
  }

  // V5 Audit §14.P3a: Debounce non-critical drift
  queueDriftItem(client, newRole.guild.id, driftItem);
}

/**
 * Handle roleDelete — a tracked role was deleted outside the dashboard.
 */
export async function handleRoleDelete(
  client: SomniClient,
  role: Role,
): Promise<void> {
  if (role.managed) return;

  // Check if this role was tracked
  const { data: mapping } = await client.supabase
    .from('discord_id_map')
    .select('template_key')
    .eq('guild_id', role.guild.id)
    .eq('discord_id', role.id)
    .maybeSingle();

  if (!mapping) return; // Untracked role — not drift

  log.info(`[Sync:Drift] Tracked role deleted: "${role.name}" (${role.id})`);

  const driftItem: DriftItem = {
    type: 'MISSING_RESOURCE',
    severity: 'warning',
    entityType: 'role',
    entityName: role.name,
    entityDiscordId: role.id,
    description: `Role "${role.name}" was deleted from Discord. It exists in the desired state.`,
    suggestedAction: 'repair',
  };

  // V5 Audit §14.P3a: Debounce non-critical drift
  queueDriftItem(client, role.guild.id, driftItem);

  await writeAuditLog(client.supabase, {
    guildId: role.guild.id,
    actorType: 'system',
    actorId: 'sync-engine',
    action: 'drift.role_deleted',
    category: 'sync',
    targetType: 'role',
    targetId: role.id,
    details: { roleName: role.name, templateKey: mapping.template_key },
  });
}

// ============================================================
// Helpers
// ============================================================

interface SyncConfigLocal {
  autoRepair: boolean;
  autoRepairEveryone: boolean;
}

async function getSyncConfig(client: SomniClient, guildId: string): Promise<SyncConfigLocal> {
  const cacheKey = `sync_config:${guildId}`;

  try {
    const cached = await client.valkey.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch { /* miss */ }

  const { data } = await client.supabase
    .from('guild_config')
    .select('sync_auto_repair, sync_auto_repair_everyone')
    .eq('guild_id', guildId)
    .maybeSingle();

  const config: SyncConfigLocal = {
    autoRepair: data?.sync_auto_repair ?? false,
    autoRepairEveryone: data?.sync_auto_repair_everyone ?? false,
  };

  try {
    await client.valkey.set(cacheKey, JSON.stringify(config), 'EX', 60);
  } catch { /* non-critical */ }

  return config;
}

/**
 * Determine whether the tracked (mapped) roles are currently out of their
 * desired relative order in this guild.
 *
 * Mirrors the periodic diff engine's hierarchy check: resolve each desired role
 * to a live, non-managed Discord role, sort by desired position, and look for a
 * strict inversion in the actual Discord positions. A tie (equal actual
 * positions) is NOT an inversion because Discord positions are not guaranteed
 * unique. Returns false when fewer than two mapped roles resolve (nothing can
 * be "out of order").
 *
 * Used to suppress false HIERARCHY_DRIFT items from pure numeric position moves
 * (e.g. an untracked role inserted elsewhere) that preserve the tracked
 * ordering — exactly the drift the periodic diff would decline to report.
 */
async function trackedRolesOutOfDesiredOrder(
  client: SomniClient,
  guild: Guild,
): Promise<boolean> {
  const { data: desired } = await client.supabase
    .from('guild_desired_state')
    .select('roles')
    .eq('guild_id', guild.id)
    .maybeSingle();

  const desiredRoles = (desired?.roles as Record<string, unknown>[]) ?? [];
  if (desiredRoles.length < 2) return false;

  const { data: mappings } = await client.supabase
    .from('discord_id_map')
    .select('template_key, discord_id')
    .eq('guild_id', guild.id)
    .eq('entity_type', 'role')
    .limit(1000);

  const idMap = new Map<string, string>();
  for (const m of (mappings ?? []) as Array<{ template_key: string; discord_id: string }>) {
    idMap.set(m.template_key, m.discord_id);
  }

  const bare = (key: string): string =>
    key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  const resolveRoleId = (rawKey: string): string | undefined =>
    idMap.get(`role:${bare(rawKey)}`) ??
    idMap.get(bare(rawKey)) ??
    idMap.get(rawKey) ??
    idMap.get(`role:${rawKey}`);

  const mapped: Array<{ desiredPos: number; actualPos: number }> = [];
  for (const def of desiredRoles) {
    const rawKey = (def.template_key ?? def.templateKey ?? def.key) as string | undefined;
    if (!rawKey) continue;
    const discordId = resolveRoleId(rawKey);
    if (!discordId) continue;
    const role = guild.roles.cache.get(discordId);
    if (!role || role.managed) continue;
    mapped.push({
      desiredPos: (def.position as number) ?? 0,
      actualPos: role.position,
    });
  }

  if (mapped.length < 2) return false;

  const sorted = [...mapped].sort((a, b) => a.desiredPos - b.desiredPos);
  for (let i = 1; i < sorted.length; i++) {
    // Strict inversion only — a tie is treated as correctly ordered because
    // Discord does not guarantee unique role positions.
    if (sorted[i].actualPos < sorted[i - 1].actualPos) return true;
  }
  return false;
}

/**
 * Record drift items to the guild_desired_state table.
 * Appends to existing drift_details array.
 */
async function recordDrift(
  client: SomniClient,
  guildId: string,
  newItems: DriftItem[],
): Promise<void> {
  // Get current drift details
  const { data: current } = await client.supabase
    .from('guild_desired_state')
    .select('drift_details')
    .eq('guild_id', guildId)
    .maybeSingle();

  const existingItems: DriftItem[] = Array.isArray(current?.drift_details)
    ? current.drift_details
    : [];

  // Merge: replace items with same entity type+name, append new ones
  const merged = [...existingItems];
  for (const item of newItems) {
    const idx = merged.findIndex(
      (e) => e.entityType === item.entityType && e.entityName === item.entityName,
    );
    if (idx >= 0) {
      merged[idx] = item; // Update existing
    } else {
      merged.push(item); // Add new
    }
  }

  await client.supabase
    .from('guild_desired_state')
    .update({
      drift_detected: merged.length > 0,
      drift_details: merged,
      last_sync_at: new Date().toISOString(),
    })
    .eq('guild_id', guildId);
}

/**
 * Auto-repair a role to match the desired state.
 * Looks up the role's desired config from the JSONB roles array.
 */
async function autoRepairRole(
  client: SomniClient,
  role: Role,
  templateKey: string,
): Promise<void> {
  try {
    // Look up desired state — roles are stored as a JSONB array on the guild row
    const { data: desired } = await client.supabase
      .from('guild_desired_state')
      .select('roles')
      .eq('guild_id', role.guild.id)
      .maybeSingle();

    if (!desired?.roles) return;

    // Find the role config in the JSONB array by template_key
    const rolesArray = desired.roles as Record<string, unknown>[];
    const config = rolesArray.find(
      (r) => r.template_key === templateKey || r.templateKey === templateKey,
    );

    if (!config) return;

    await role.edit({
      name: (config.name as string) ?? role.name,
      permissions: BigInt((config.permissions as string) ?? role.permissions.bitfield.toString()),
      color: (config.color as number) ?? role.color,
      hoist: (config.hoist as boolean) ?? role.hoist,
      mentionable: (config.mentionable as boolean) ?? role.mentionable,
      reason: 'SomniBot auto-repair — restoring desired state',
    });

    log.info(`[Sync:Drift] Auto-repaired role "${role.name}"`);

    await writeAuditLog(client.supabase, {
      guildId: role.guild.id,
      actorType: 'bot',
      actorId: 'sync-engine',
      action: 'drift.auto_repair',
      category: 'sync',
      targetType: 'role',
      targetId: role.id,
      details: { roleName: role.name, templateKey },
    });
  } catch (err) {
    log.error(`[Sync:Drift] Failed to auto-repair role "${role.name}":`, err);
  }
}
