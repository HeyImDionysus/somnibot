/**
 * Role Event Drift Detection
 *
 * Detects drift in real-time when roles are created, updated, or deleted
 * outside of the dashboard/deployer. Complements the periodic sync cycle
 * with instant event-based detection.
 *
 * Architecture doc §15: "Event-based drift detection (role/channel update events)"
 */

import type { Role } from 'discord.js';
import type { SomniClient } from '../client.js';
import type { DriftItem, DriftSeverity, DriftType } from '@somnibot/shared';
import { writeAuditLog } from '../services/audit.js';

/**
 * Handle roleCreate — a new role was created outside the dashboard.
 */
export async function handleRoleCreate(
  client: SomniClient,
  role: Role,
): Promise<void> {
  if (role.guild.id !== client.guildId) return;
  if (role.managed) return; // Bot/integration roles are expected

  // Check if this role is tracked in our ID map (created by deployer)
  const { data: mapping } = await client.supabase
    .from('discord_id_map')
    .select('internal_id')
    .eq('guild_id', client.guildId)
    .eq('discord_id', role.id)
    .maybeSingle();

  if (mapping) return; // This was created by us — not drift

  console.log(`[Sync:Drift] New role created externally: "${role.name}" (${role.id})`);

  const driftItem: DriftItem = {
    type: 'EXTRA_RESOURCE',
    severity: 'info',
    entityType: 'role',
    entityName: role.name,
    entityDiscordId: role.id,
    description: `Role "${role.name}" was created outside the dashboard`,
    suggestedAction: 'accept',
  };

  await recordDrift(client, [driftItem]);

  client.eventBus.emit('drift.detected', client.guildId, {
    driftCount: 1,
    criticalCount: 0,
    autoRepaired: false,
    items: [{ type: driftItem.type, entityName: driftItem.entityName, severity: driftItem.severity }],
  });
}

/**
 * Handle roleUpdate — a tracked role was modified outside the dashboard.
 */
export async function handleRoleUpdate(
  client: SomniClient,
  oldRole: Role,
  newRole: Role,
): Promise<void> {
  if (newRole.guild.id !== client.guildId) return;

  // Check @everyone specifically
  if (newRole.id === newRole.guild.id) {
    if (newRole.permissions.bitfield !== 0n) {
      console.log(`[Sync:Drift] CRITICAL — @everyone permissions changed to ${newRole.permissions.bitfield}`);

      const driftItem: DriftItem = {
        type: 'EVERYONE_DRIFT',
        severity: 'critical',
        entityType: 'everyone',
        entityName: '@everyone',
        description: '@everyone has non-zero permissions. This breaks the onboarding model.',
        details: { permissions: { expected: '0', actual: newRole.permissions.bitfield.toString() } },
        suggestedAction: 'repair',
      };

      await recordDrift(client, [driftItem]);

      // Auto-repair @everyone if configured
      const config = await getSyncConfig(client);
      if (config.autoRepairEveryone) {
        try {
          await newRole.setPermissions(0n, 'SomniBot auto-repair — @everyone must be 0');
          console.log('[Sync:Drift] Auto-repaired @everyone permissions to 0');

          await writeAuditLog(client.supabase, {
            guildId: client.guildId,
            actorType: 'bot',
            actorId: 'sync-engine',
            action: 'drift.auto_repair',
            targetType: 'role',
            targetId: newRole.id,
            details: {
              type: 'EVERYONE_DRIFT',
              repairedPermissions: '0',
              previousPermissions: newRole.permissions.bitfield.toString(),
            },
          });
        } catch (err) {
          console.error('[Sync:Drift] Failed to auto-repair @everyone:', err);
        }
      }

      client.eventBus.emit('drift.detected', client.guildId, {
        driftCount: 1,
        criticalCount: 1,
        autoRepaired: config.autoRepairEveryone,
        items: [{ type: 'EVERYONE_DRIFT', entityName: '@everyone', severity: 'critical' as DriftSeverity }],
      });

      return;
    }
  }

  // Check if this role is tracked
  const { data: mapping } = await client.supabase
    .from('discord_id_map')
    .select('internal_id')
    .eq('guild_id', client.guildId)
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

  console.log(
    `[Sync:Drift] Role "${newRole.name}" modified externally:`,
    Object.keys(changes).join(', '),
  );

  const driftItem: DriftItem = {
    type: hasPermissionChange ? 'PERMISSION_DRIFT' : 'EXTERNAL_CHANGE',
    severity: hasPermissionChange ? 'warning' : 'info',
    entityType: 'role',
    entityName: newRole.name,
    entityDiscordId: newRole.id,
    description: `Role "${newRole.name}" was modified outside the dashboard`,
    details: Object.fromEntries(
      Object.entries(changes).map(([k, v]) => [k, { expected: v.from, actual: v.to }]),
    ),
    suggestedAction: 'repair',
  };

  await recordDrift(client, [driftItem]);

  // Auto-repair if configured
  const config = await getSyncConfig(client);
  if (config.autoRepair) {
    await autoRepairRole(client, newRole, mapping.internal_id);
  }

  client.eventBus.emit('drift.detected', client.guildId, {
    driftCount: 1,
    criticalCount: 0,
    autoRepaired: config.autoRepair,
    items: [{ type: driftItem.type, entityName: driftItem.entityName, severity: driftItem.severity }],
  });
}

/**
 * Handle roleDelete — a tracked role was deleted outside the dashboard.
 */
export async function handleRoleDelete(
  client: SomniClient,
  role: Role,
): Promise<void> {
  if (role.guild.id !== client.guildId) return;
  if (role.managed) return;

  // Check if this role was tracked
  const { data: mapping } = await client.supabase
    .from('discord_id_map')
    .select('internal_id')
    .eq('guild_id', client.guildId)
    .eq('discord_id', role.id)
    .maybeSingle();

  if (!mapping) return; // Untracked role — not drift

  console.log(`[Sync:Drift] Tracked role deleted: "${role.name}" (${role.id})`);

  const driftItem: DriftItem = {
    type: 'MISSING_RESOURCE',
    severity: 'warning',
    entityType: 'role',
    entityName: role.name,
    entityDiscordId: role.id,
    description: `Role "${role.name}" was deleted from Discord. It exists in the desired state.`,
    suggestedAction: 'repair',
  };

  await recordDrift(client, [driftItem]);

  client.eventBus.emit('drift.detected', client.guildId, {
    driftCount: 1,
    criticalCount: 0,
    autoRepaired: false,
    items: [{ type: driftItem.type, entityName: driftItem.entityName, severity: driftItem.severity }],
  });

  await writeAuditLog(client.supabase, {
    guildId: client.guildId,
    actorType: 'system',
    actorId: 'sync-engine',
    action: 'drift.role_deleted',
    targetType: 'role',
    targetId: role.id,
    details: { roleName: role.name, templateKey: mapping.internal_id },
  });
}

// ============================================================
// Helpers
// ============================================================

interface SyncConfigLocal {
  autoRepair: boolean;
  autoRepairEveryone: boolean;
}

async function getSyncConfig(client: SomniClient): Promise<SyncConfigLocal> {
  const cacheKey = `sync_config:${client.guildId}`;

  try {
    const cached = await client.valkey.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch { /* miss */ }

  const { data } = await client.supabase
    .from('guild_config')
    .select('sync_auto_repair, sync_auto_repair_everyone')
    .eq('guild_id', client.guildId)
    .maybeSingle();

  const config: SyncConfigLocal = {
    autoRepair: data?.sync_auto_repair ?? false,
    autoRepairEveryone: data?.sync_auto_repair_everyone ?? true,
  };

  try {
    await client.valkey.set(cacheKey, JSON.stringify(config), 'EX', 60);
  } catch { /* non-critical */ }

  return config;
}

/**
 * Record drift items to the guild_desired_state table.
 * Appends to existing drift_details array.
 */
async function recordDrift(
  client: SomniClient,
  newItems: DriftItem[],
): Promise<void> {
  // Get current drift details
  const { data: current } = await client.supabase
    .from('guild_desired_state')
    .select('drift_details')
    .eq('guild_id', client.guildId)
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
    .eq('guild_id', client.guildId);
}

/**
 * Auto-repair a role to match the desired state.
 */
async function autoRepairRole(
  client: SomniClient,
  role: Role,
  templateKey: string,
): Promise<void> {
  try {
    // Look up desired state for this role
    const { data: desired } = await client.supabase
      .from('guild_desired_state')
      .select('desired_config')
      .eq('guild_id', client.guildId)
      .eq('entity_type', 'role')
      .eq('entity_id', templateKey)
      .maybeSingle();

    if (!desired?.desired_config) return;

    const config = desired.desired_config as Record<string, unknown>;

    await role.edit({
      name: (config.name as string) ?? role.name,
      permissions: BigInt((config.permissions as string) ?? role.permissions.bitfield.toString()),
      color: (config.color as number) ?? role.color,
      hoist: (config.hoist as boolean) ?? role.hoist,
      mentionable: (config.mentionable as boolean) ?? role.mentionable,
      reason: 'SomniBot auto-repair — restoring desired state',
    });

    console.log(`[Sync:Drift] Auto-repaired role "${role.name}"`);

    await writeAuditLog(client.supabase, {
      guildId: client.guildId,
      actorType: 'bot',
      actorId: 'sync-engine',
      action: 'drift.auto_repair',
      targetType: 'role',
      targetId: role.id,
      details: { roleName: role.name, templateKey },
    });
  } catch (err) {
    console.error(`[Sync:Drift] Failed to auto-repair role "${role.name}":`, err);
  }
}
