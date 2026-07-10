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
  /**
   * True when the mapped roles' actual Discord positions are not in the same
   * relative order as the desired `position` field. Role position is not part
   * of the per-role `changes` (positions are relative in desired state and
   * absolute in Discord), so hierarchy drift is surfaced as its own signal and
   * classified into a single HIERARCHY_DRIFT item.
   */
  roleHierarchyDrift: boolean;
  /** Discord ID of a representative out-of-order role (for the drift item). */
  roleHierarchyDriftId?: string;
  /** Template key of a representative out-of-order role (for repair lookup). */
  roleHierarchyDriftKey?: string;
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
  templateKey?: string;
  description: string;
  details?: Record<string, { expected: unknown; actual: unknown }>;
  suggestedAction: 'repair' | 'accept' | 'ignore';
}

// ============================================================
// Diff Calculator
// ============================================================

/**
 * True when `discordId` is registered in `entityIdMap` under an entity type
 * OTHER than `entityType`. Used to reject a bare-key flat-map resolution that
 * actually belongs to a different entity (e.g. a channel row keyed `staff`
 * whose ID would otherwise be mistaken for a role of the same bare key).
 */
function isForeignEntityId(
  entityIdMap: Map<string, string> | undefined,
  entityType: 'role' | 'channel' | 'category',
  discordId: string,
): boolean {
  if (!entityIdMap) return false;
  for (const [key, id] of entityIdMap) {
    if (id !== discordId) continue;
    const type = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
    if (type !== entityType) return true;
  }
  return false;
}

/**
 * Compute the diff between desired and actual state.
 * ID mapping is provided by the discord_id_map table.
 *
 * `idMap` is the historical flat map (template key → discord ID). The
 * `discord_id_map` table's real primary key is (guild, entity_type, template
 * key), so the same bare `template_key` (e.g. `staff`) can legitimately exist
 * for BOTH a role and a channel/category. Flattening those rows into a single
 * `Map<string, string>` loses that entity dimension: whichever row is inserted
 * last wins, so a bare-key lookup for a role can silently resolve to a
 * channel's Discord ID (and vice-versa). To keep the hierarchy comparison from
 * dropping a role on such a collision, callers may additionally pass
 * `entityIdMap`, keyed by `${entityType}:${bareKey}`, which preserves the
 * entity type and is consulted first for role resolution.
 */
export function computeStateDiff(
  desired: DesiredState,
  actual: ActualState,
  idMap: Map<string, string>, // template key → discord ID
  entityIdMap?: Map<string, string>, // `${entity_type}:${bareKey}` → discord ID
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
          discordId,
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

  // --- Role hierarchy drift ---
  // Compare the desired relative ordering of mapped roles against their actual
  // Discord positions. Only roles that resolve to a live, non-managed actual
  // role participate. Drift is a genuine *inversion*: a role that should sit
  // higher (greater desired position) actually sits strictly lower than the one
  // below it. Discord role positions are NOT guaranteed unique, so two adjacent
  // desired roles can legitimately share the same numeric position — a tie is
  // not an inversion and must not be reported as drift (otherwise the signal
  // fires forever and the auto-repair can never clear it).
  let roleHierarchyDrift = false;
  let roleHierarchyDriftId: string | undefined;
  let roleHierarchyDriftKey: string | undefined;
  {
    const mapped: Array<{ key: string; discordId: string; desiredPos: number; actualPos: number }> = [];
    for (const desiredRole of desired.roles) {
      // Guilds store the template key variantly (`key` / `template_key` /
      // `templateKey`), and the ID map keys it prefixed (`role:mod`) or bare
      // (`mod`). Try every combination so hierarchy drift is detected regardless.
      const rawKey =
        desiredRole.key ??
        (desiredRole as { template_key?: string }).template_key ??
        (desiredRole as { templateKey?: string }).templateKey;
      if (!rawKey) continue;
      const bareKey = rawKey.includes(':') ? rawKey.slice(rawKey.indexOf(':') + 1) : rawKey;
      // Resolve to a Discord ID, disambiguating by entity type so a bare-key
      // lookup cannot collide with a channel/category mapping of the same key.
      // Priority:
      //   1. Prefixed flat-map key (`role:staff`) — already entity-scoped.
      //   2. Entity-typed map (`role:staff`), when the caller supplies one — the
      //      only source that survives a bare-key collision, since it is keyed
      //      by entity type at construction from the real table primary key.
      //   3. Bare / raw flat-map keys — last-resort fallback, but ONLY accepted
      //      when the resolved ID is not claimed by a different entity type, so
      //      a channel row keyed `staff` can never masquerade as a role here.
      let discordId = idMap.get(`role:${bareKey}`);
      if (!discordId && entityIdMap) {
        discordId =
          entityIdMap.get(`role:${bareKey}`) ??
          entityIdMap.get(`role:${rawKey}`) ??
          undefined;
      }
      if (!discordId) {
        const bareCandidate = idMap.get(bareKey) ?? idMap.get(rawKey);
        if (bareCandidate && !isForeignEntityId(entityIdMap, 'role', bareCandidate)) {
          discordId = bareCandidate;
        }
      }
      if (!discordId) continue;
      const actualRole = actual.roles.find(r => r.id === discordId);
      if (!actualRole || actualRole.managed) continue;
      mapped.push({
        key: bareKey,
        discordId,
        desiredPos: desiredRole.position,
        actualPos: actualRole.position,
      });
    }
    if (mapped.length >= 2) {
      const sorted = [...mapped].sort((a, b) => a.desiredPos - b.desiredPos);
      for (let i = 1; i < sorted.length; i++) {
        // Strict inversion only: equal actual positions (a tie) are treated as
        // correctly ordered, since Discord does not guarantee unique positions.
        if (sorted[i].actualPos < sorted[i - 1].actualPos) {
          roleHierarchyDrift = true;
          // Report the higher-desired role as the representative target.
          roleHierarchyDriftId = sorted[i].discordId;
          roleHierarchyDriftKey = sorted[i].key;
          break;
        }
      }
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
          discordId,
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
          discordId,
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
    totalChanges: roleDiffs.length + categoryDiffs.length + channelDiffs.length + overrideDiffs.length + (everyoneDrift ? 1 : 0) + (roleHierarchyDrift ? 1 : 0),
    hasBreakingChanges: roleDiffs.some(d => d.action === 'delete') || channelDiffs.some(d => d.action === 'delete'),
  };

  return {
    everyoneDrift,
    everyoneCurrentPermissions: actual.everyonePermissions,
    roleHierarchyDrift,
    roleHierarchyDriftId,
    roleHierarchyDriftKey,
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
        templateKey: roleDiff.key,
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
        entityDiscordId: roleDiff.discordId,
        templateKey: roleDiff.key,
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

  // Role hierarchy drift — the mapped roles are no longer in their desired
  // relative order. Surfaced as a single repairable item; the sync engine
  // reorders the whole set back to the desired hierarchy.
  if (diff.roleHierarchyDrift) {
    items.push({
      type: 'HIERARCHY_DRIFT',
      severity: 'warning',
      entityType: 'role',
      entityName: 'Role hierarchy',
      entityDiscordId: diff.roleHierarchyDriftId,
      templateKey: diff.roleHierarchyDriftKey,
      description: 'Role hierarchy positions no longer match the desired ordering',
      suggestedAction: 'repair',
    });
  }

  // Category drifts
  for (const categoryDiff of diff.categories) {
    if (categoryDiff.action === 'create' && categoryDiff.discordId) {
      items.push({
        type: 'MISSING_RESOURCE',
        severity: 'warning',
        entityType: 'category',
        entityName: categoryDiff.name,
        entityDiscordId: categoryDiff.discordId,
        templateKey: categoryDiff.key,
        description: `Category "${categoryDiff.name}" was deleted from Discord`,
        suggestedAction: 'repair',
      });
    }
  }

  // Channel drifts
  for (const chanDiff of diff.channels) {
    if (chanDiff.action === 'create' && chanDiff.discordId) {
      items.push({
        type: 'MISSING_RESOURCE',
        severity: 'warning',
        entityType: 'channel',
        entityName: chanDiff.name,
        entityDiscordId: chanDiff.discordId,
        templateKey: chanDiff.key,
        description: `Channel "${chanDiff.name}" was deleted from Discord`,
        suggestedAction: 'repair',
      });
    } else if (chanDiff.action === 'update' && chanDiff.changes) {
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
    if (overrideDiff.action === 'create' || overrideDiff.action === 'update') {
      items.push({
        type: 'PERMISSION_DRIFT',
        severity: 'warning',
        entityType: 'channel',
        entityName: `${overrideDiff.channelKey} → ${overrideDiff.roleKey}`,
        entityDiscordId: overrideDiff.channelDiscordId,
        templateKey: overrideDiff.channelKey,
        description: `Permission override changed for ${overrideDiff.roleKey} in channel`,
        details: {
          overrideChannelKey: { expected: overrideDiff.channelKey, actual: overrideDiff.channelKey },
          overrideRoleKey: { expected: overrideDiff.roleKey, actual: overrideDiff.roleKey },
          overrideRoleId: {
            expected: overrideDiff.roleDiscordId ?? null,
            actual: overrideDiff.roleDiscordId ?? null,
          },
          overrideAction: { expected: overrideDiff.action, actual: overrideDiff.action },
          allow: {
            expected: overrideDiff.allow?.to ?? '0',
            actual: overrideDiff.allow?.from ?? '0',
          },
          deny: {
            expected: overrideDiff.deny?.to ?? '0',
            actual: overrideDiff.deny?.from ?? '0',
          },
        },
        suggestedAction: 'repair',
      });
    }
  }

  return items;
}
