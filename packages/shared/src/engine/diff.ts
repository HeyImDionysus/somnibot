/**
 * Server State Diff Engine
 *
 * Compares desired state against actual Discord state.
 * Used by both the deploy wizard (preview) and sync engine (drift detection).
 */

// ============================================================
// Types — Desired State
// ============================================================

export interface DesiredRole {
  key: string; // internal template key
  name: string;
  tier: string;
  permissions: string; // bigint as string for JSON serialization
  color: number;
  hoist: boolean;
  mentionable: boolean;
  position: number; // relative order within tier
}

export interface DesiredChannelOverride {
  roleKey: string; // internal role template key or 'everyone'
  allow: string; // bigint as string
  deny: string; // bigint as string
}

export interface DesiredChannel {
  key: string; // internal template key
  name: string;
  type: number; // Discord ChannelType enum
  categoryKey: string | null;
  position: number;
  topic: string | null;
  slowmode: number;
  nsfw: boolean;
  templateId: string;
  overrides: DesiredChannelOverride[];
}

export interface DesiredCategory {
  key: string;
  name: string;
  position: number;
}

export interface DesiredState {
  everyonePermissions: string; // Should always be '0'
  roles: DesiredRole[];
  categories: DesiredCategory[];
  channels: DesiredChannel[];
}

// ============================================================
// Types — Actual State (from Discord API)
// ============================================================

export interface ActualRole {
  id: string; // Discord snowflake
  name: string;
  permissions: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  position: number;
  managed: boolean; // bot/integration-managed
}

export interface ActualChannelOverride {
  id: string; // role or member ID
  type: 'role' | 'member';
  allow: string;
  deny: string;
}

export interface ActualChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
  topic: string | null;
  rateLimitPerUser: number; // slowmode
  nsfw: boolean;
  overwrites: ActualChannelOverride[];
}

export interface ActualState {
  everyonePermissions: string;
  roles: ActualRole[];
  channels: ActualChannel[];
}

// ============================================================
// Types — Diff Result
// ============================================================

export type DiffAction = 'create' | 'update' | 'delete' | 'reorder';

export interface RoleDiff {
  action: DiffAction;
  key: string;
  name: string;
  discordId?: string; // existing ID for update/delete
  changes?: Record<string, { from: unknown; to: unknown }>;
  desired?: DesiredRole;
}

export interface ChannelDiff {
  action: DiffAction;
  key: string;
  name: string;
  discordId?: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  desired?: DesiredChannel;
}

export interface CategoryDiff {
  action: DiffAction;
  key: string;
  name: string;
  discordId?: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  desired?: DesiredCategory;
}

export interface OverrideDiff {
  channelKey: string;
  channelDiscordId?: string;
  action: DiffAction;
  roleKey: string;
  roleDiscordId?: string;
  allow?: { from: string; to: string };
  deny?: { from: string; to: string };
}

export interface StateDiff {
  everyoneDrift: boolean;
  everyoneCurrentPermissions: string;
  roles: RoleDiff[];
  categories: CategoryDiff[];
  channels: ChannelDiff[];
  overrides: OverrideDiff[];
  summary: {
    rolesToCreate: number;
    rolesToUpdate: number;
    rolesToDelete: number;
    categoriesToCreate: number;
    categoriesToUpdate: number;
    categoriesToDelete: number;
    channelsToCreate: number;
    channelsToUpdate: number;
    channelsToDelete: number;
    overrideChanges: number;
    totalChanges: number;
    hasBreakingChanges: boolean;
  };
}

// ============================================================
// Drift Classification
// ============================================================

export type DriftType =
  | 'EXTERNAL_CHANGE'
  | 'MISSING_RESOURCE'
  | 'EXTRA_RESOURCE'
  | 'PERMISSION_DRIFT'
  | 'EVERYONE_DRIFT'
  | 'HIERARCHY_DRIFT';

export type DriftSeverity = 'critical' | 'warning' | 'info';

export interface DriftItem {
  type: DriftType;
  severity: DriftSeverity;
  entityType: 'role' | 'channel' | 'category' | 'everyone';
  entityName: string;
  entityDiscordId?: string;
  description: string;
  details?: Record<string, { expected: unknown; actual: unknown }>;
  suggestedAction: 'repair' | 'accept' | 'ignore';
}

// ============================================================
// Diff Calculator
// ============================================================

/**
 * Compute the diff between desired and actual state.
 * ID mapping is provided by the discord_id_map table.
 */
export function computeStateDiff(
  desired: DesiredState,
  actual: ActualState,
  idMap: Map<string, string>, // template key → discord ID
): StateDiff {
  const roleDiffs: RoleDiff[] = [];
  const categoryDiffs: CategoryDiff[] = [];
  const channelDiffs: ChannelDiff[] = [];
  const overrideDiffs: OverrideDiff[] = [];

  // Reverse map: discord ID → template key
  const reverseIdMap = new Map<string, string>();
  for (const [key, id] of idMap) {
    reverseIdMap.set(id, key);
  }

  // Track which actual entities are accounted for
  const matchedRoleIds = new Set<string>();
  const matchedChannelIds = new Set<string>();

  // --- @everyone drift ---
  const everyoneDrift = actual.everyonePermissions !== '0';

  // --- Role diffs ---
  for (const desiredRole of desired.roles) {
    const discordId = idMap.get(`role:${desiredRole.key}`);

    if (!discordId) {
      // Role doesn't exist yet — create
      roleDiffs.push({
        action: 'create',
        key: desiredRole.key,
        name: desiredRole.name,
        desired: desiredRole,
      });
    } else {
      matchedRoleIds.add(discordId);
      const actualRole = actual.roles.find(r => r.id === discordId);

      if (!actualRole) {
        // Was mapped but deleted from Discord
        roleDiffs.push({
          action: 'create',
          key: desiredRole.key,
          name: desiredRole.name,
          desired: desiredRole,
        });
      } else {
        // Check for changes
        const changes: Record<string, { from: unknown; to: unknown }> = {};

        if (actualRole.name !== desiredRole.name) {
          changes['name'] = { from: actualRole.name, to: desiredRole.name };
        }
        if (actualRole.permissions !== desiredRole.permissions) {
          changes['permissions'] = { from: actualRole.permissions, to: desiredRole.permissions };
        }
        if (actualRole.color !== desiredRole.color) {
          changes['color'] = { from: actualRole.color, to: desiredRole.color };
        }
        if (actualRole.hoist !== desiredRole.hoist) {
          changes['hoist'] = { from: actualRole.hoist, to: desiredRole.hoist };
        }
        if (actualRole.mentionable !== desiredRole.mentionable) {
          changes['mentionable'] = { from: actualRole.mentionable, to: desiredRole.mentionable };
        }

        if (Object.keys(changes).length > 0) {
          roleDiffs.push({
            action: 'update',
            key: desiredRole.key,
            name: desiredRole.name,
            discordId,
            changes,
            desired: desiredRole,
          });
        }
      }
    }
  }

  // Roles in Discord that aren't in desired state (extras to delete)
  for (const actualRole of actual.roles) {
    if (actualRole.managed) continue; // Don't touch bot/integration roles
    if (actualRole.name === '@everyone') continue;
    if (matchedRoleIds.has(actualRole.id)) continue;

    // Check if this is an unknown role we should flag
    if (!reverseIdMap.has(actualRole.id)) {
      roleDiffs.push({
        action: 'delete',
        key: `unknown:${actualRole.id}`,
        name: actualRole.name,
        discordId: actualRole.id,
      });
    }
  }

  // --- Category diffs ---
  for (const desiredCat of desired.categories) {
    const discordId = idMap.get(`category:${desiredCat.key}`);

    if (!discordId) {
      categoryDiffs.push({
        action: 'create',
        key: desiredCat.key,
        name: desiredCat.name,
        desired: desiredCat,
      });
    } else {
      const actualCat = actual.channels.find(c => c.id === discordId);
      matchedChannelIds.add(discordId);

      if (!actualCat) {
        categoryDiffs.push({
          action: 'create',
          key: desiredCat.key,
          name: desiredCat.name,
          desired: desiredCat,
        });
      } else {
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        if (actualCat.name !== desiredCat.name) {
          changes['name'] = { from: actualCat.name, to: desiredCat.name };
        }
        if (Object.keys(changes).length > 0) {
          categoryDiffs.push({
            action: 'update',
            key: desiredCat.key,
            name: desiredCat.name,
            discordId,
            changes,
            desired: desiredCat,
          });
        }
      }
    }
  }

  // --- Channel diffs ---
  for (const desiredChan of desired.channels) {
    const discordId = idMap.get(`channel:${desiredChan.key}`);

    if (!discordId) {
      channelDiffs.push({
        action: 'create',
        key: desiredChan.key,
        name: desiredChan.name,
        desired: desiredChan,
      });
    } else {
      matchedChannelIds.add(discordId);
      const actualChan = actual.channels.find(c => c.id === discordId);

      if (!actualChan) {
        channelDiffs.push({
          action: 'create',
          key: desiredChan.key,
          name: desiredChan.name,
          desired: desiredChan,
        });
      } else {
        const changes: Record<string, { from: unknown; to: unknown }> = {};

        if (actualChan.name !== desiredChan.name) {
          changes['name'] = { from: actualChan.name, to: desiredChan.name };
        }
        if (actualChan.topic !== desiredChan.topic) {
          changes['topic'] = { from: actualChan.topic, to: desiredChan.topic };
        }
        if (actualChan.rateLimitPerUser !== desiredChan.slowmode) {
          changes['slowmode'] = { from: actualChan.rateLimitPerUser, to: desiredChan.slowmode };
        }
        if (actualChan.nsfw !== desiredChan.nsfw) {
          changes['nsfw'] = { from: actualChan.nsfw, to: desiredChan.nsfw };
        }

        if (Object.keys(changes).length > 0) {
          channelDiffs.push({
            action: 'update',
            key: desiredChan.key,
            name: desiredChan.name,
            discordId,
            changes,
            desired: desiredChan,
          });
        }

        // Check permission overrides
        for (const desiredOverride of desiredChan.overrides) {
          const roleDiscordId = desiredOverride.roleKey === 'everyone'
            ? actual.roles.find(r => r.name === '@everyone')?.id
            : idMap.get(`role:${desiredOverride.roleKey}`);

          if (!roleDiscordId) continue;

          const actualOverride = actualChan.overwrites.find(o => o.id === roleDiscordId);

          if (!actualOverride) {
            overrideDiffs.push({
              channelKey: desiredChan.key,
              channelDiscordId: discordId,
              action: 'create',
              roleKey: desiredOverride.roleKey,
              roleDiscordId,
              allow: { from: '0', to: desiredOverride.allow },
              deny: { from: '0', to: desiredOverride.deny },
            });
          } else {
            if (actualOverride.allow !== desiredOverride.allow || actualOverride.deny !== desiredOverride.deny) {
              overrideDiffs.push({
                channelKey: desiredChan.key,
                channelDiscordId: discordId,
                action: 'update',
                roleKey: desiredOverride.roleKey,
                roleDiscordId,
                allow: { from: actualOverride.allow, to: desiredOverride.allow },
                deny: { from: actualOverride.deny, to: desiredOverride.deny },
              });
            }
          }
        }
      }
    }
  }

  // Extra channels in Discord not in desired state
  for (const actualChan of actual.channels) {
    if (matchedChannelIds.has(actualChan.id)) continue;
    if (!reverseIdMap.has(actualChan.id)) {
      channelDiffs.push({
        action: 'delete',
        key: `unknown:${actualChan.id}`,
        name: actualChan.name,
        discordId: actualChan.id,
      });
    }
  }

  // Build summary
  const summary = {
    rolesToCreate: roleDiffs.filter(d => d.action === 'create').length,
    rolesToUpdate: roleDiffs.filter(d => d.action === 'update').length,
    rolesToDelete: roleDiffs.filter(d => d.action === 'delete').length,
    categoriesToCreate: categoryDiffs.filter(d => d.action === 'create').length,
    categoriesToUpdate: categoryDiffs.filter(d => d.action === 'update').length,
    categoriesToDelete: categoryDiffs.filter(d => d.action === 'delete').length,
    channelsToCreate: channelDiffs.filter(d => d.action === 'create').length,
    channelsToUpdate: channelDiffs.filter(d => d.action === 'update').length,
    channelsToDelete: channelDiffs.filter(d => d.action === 'delete').length,
    overrideChanges: overrideDiffs.length,
    totalChanges: roleDiffs.length + categoryDiffs.length + channelDiffs.length + overrideDiffs.length + (everyoneDrift ? 1 : 0),
    hasBreakingChanges: roleDiffs.some(d => d.action === 'delete') || channelDiffs.some(d => d.action === 'delete'),
  };

  return {
    everyoneDrift,
    everyoneCurrentPermissions: actual.everyonePermissions,
    roles: roleDiffs,
    categories: categoryDiffs,
    channels: channelDiffs,
    overrides: overrideDiffs,
    summary,
  };
}

/**
 * Classify drift items from a state diff for the sync dashboard.
 */
export function classifyDrift(diff: StateDiff): DriftItem[] {
  const items: DriftItem[] = [];

  // @everyone drift — CRITICAL
  if (diff.everyoneDrift) {
    items.push({
      type: 'EVERYONE_DRIFT',
      severity: 'critical',
      entityType: 'everyone',
      entityName: '@everyone',
      description: '@everyone has non-zero permissions. This breaks the onboarding model.',
      details: { permissions: { expected: '0', actual: diff.everyoneCurrentPermissions } },
      suggestedAction: 'repair',
    });
  }

  // Role drifts
  for (const roleDiff of diff.roles) {
    if (roleDiff.action === 'update' && roleDiff.changes) {
      const hasPermissionChange = 'permissions' in roleDiff.changes;
      items.push({
        type: hasPermissionChange ? 'PERMISSION_DRIFT' : 'EXTERNAL_CHANGE',
        severity: hasPermissionChange ? 'warning' : 'info',
        entityType: 'role',
        entityName: roleDiff.name,
        entityDiscordId: roleDiff.discordId,
        description: `Role "${roleDiff.name}" was modified outside the dashboard`,
        details: Object.fromEntries(
          Object.entries(roleDiff.changes).map(([k, v]) => [k, { expected: v.to, actual: v.from }]),
        ),
        suggestedAction: 'repair',
      });
    } else if (roleDiff.action === 'create' && roleDiff.discordId) {
      items.push({
        type: 'MISSING_RESOURCE',
        severity: 'warning',
        entityType: 'role',
        entityName: roleDiff.name,
        description: `Role "${roleDiff.name}" was deleted from Discord`,
        suggestedAction: 'repair',
      });
    } else if (roleDiff.action === 'delete') {
      items.push({
        type: 'EXTRA_RESOURCE',
        severity: 'info',
        entityType: 'role',
        entityName: roleDiff.name,
        entityDiscordId: roleDiff.discordId,
        description: `Role "${roleDiff.name}" exists in Discord but not in the desired state`,
        suggestedAction: 'accept',
      });
    }
  }

  // Channel drifts
  for (const chanDiff of diff.channels) {
    if (chanDiff.action === 'update' && chanDiff.changes) {
      items.push({
        type: 'EXTERNAL_CHANGE',
        severity: 'info',
        entityType: 'channel',
        entityName: chanDiff.name,
        entityDiscordId: chanDiff.discordId,
        description: `Channel "${chanDiff.name}" was modified outside the dashboard`,
        details: Object.fromEntries(
          Object.entries(chanDiff.changes).map(([k, v]) => [k, { expected: v.to, actual: v.from }]),
        ),
        suggestedAction: 'repair',
      });
    } else if (chanDiff.action === 'delete') {
      items.push({
        type: 'EXTRA_RESOURCE',
        severity: 'info',
        entityType: 'channel',
        entityName: chanDiff.name,
        entityDiscordId: chanDiff.discordId,
        description: `Channel "${chanDiff.name}" exists in Discord but not in the desired state`,
        suggestedAction: 'accept',
      });
    }
  }

  // Override drifts
  for (const overrideDiff of diff.overrides) {
    if (overrideDiff.action === 'update') {
      items.push({
        type: 'PERMISSION_DRIFT',
        severity: 'warning',
        entityType: 'channel',
        entityName: `${overrideDiff.channelKey} → ${overrideDiff.roleKey}`,
        entityDiscordId: overrideDiff.channelDiscordId,
        description: `Permission override changed for ${overrideDiff.roleKey} in channel`,
        suggestedAction: 'repair',
      });
    }
  }

  return items;
}
