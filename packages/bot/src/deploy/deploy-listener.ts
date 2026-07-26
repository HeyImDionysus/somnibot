/**
 * Deploy Listener — Subscribes to Supabase Realtime for deploy requests.
 *
 * When the dashboard saves a desired state and sets `applied_at = null`,
 * this listener detects the change and triggers the deployer.
 *
 * Flow:
 * 1. Dashboard stores desired state in guild_desired_state
 * 2. Dashboard POSTs /api/deploy → clears applied_at (signals "deploy me")
 * 3. This listener detects the Realtime change
 * 4. Deployer runs, reports progress
 * 5. Results stored in audit_logs, applied_at set to now()
 */

import type { SomniClient } from '../client.js';
import { deployServerState, type DeployOptions, type DeployResult } from './deployer.js';
import { writeAuditLog, writeAuditBatch } from '../services/audit.js';
import { recordAdminChange, undoByDeleting } from '../services/admin-changes.js';
import { writeGuildSnapshot } from '../services/guild-snapshot.js';
import type { DesiredState, DesiredRole, DesiredChannel, DesiredCategory } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('DeployListener');

// ============================================================
// Deploy Status Tracking
// ============================================================

interface DeployStatus {
  guildId: string;
  deployId: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  currentStep: number;
  totalSteps: number;
  currentAction: string;
  startedAt: string;
  completedAt?: string;
  result?: DeployResult;
}

const deployStatuses = new Map<string, DeployStatus>();
let latestDeployGuildId: string | null = null;

export function getDeployStatus(guildId?: string): DeployStatus | null {
  if (guildId) return deployStatuses.get(guildId) ?? null;
  if (latestDeployGuildId) return deployStatuses.get(latestDeployGuildId) ?? null;
  return null;
}

// ============================================================
// Listener Setup
// ============================================================

/**
 * Start listening for deploy requests on the guild_desired_state table.
 */
export function startDeployListener(client: SomniClient): void {
  const primaryGuildId = client.guildId;

  log.info('Starting deploy listener for all guilds', { primaryGuildId });

  // Subscribe to changes on guild_desired_state
  client.supabase
    .channel('deploy-listener')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'guild_desired_state',
      },
      async (payload) => {
        const newState = payload.new as Record<string, unknown>;
        const guildId = getGuildIdFromRow(newState, primaryGuildId);

        // Deploy is requested when applied_at is cleared and there's data
        if (
          newState &&
          newState.applied_at === null &&
          Array.isArray(newState.roles) &&
          newState.roles.length > 0
        ) {
          log.info('Detected deploy request via Realtime', { guildId });
          await executeDeploy(client, newState, guildId);
        }
      },
    )
    .subscribe((status) => {
      log.info(`Realtime subscription: ${status}`);
    });

  // Also listen via event bus for direct deploy requests (API / tests)
  client.eventBus.on('deploy.requested', async (event) => {
    const guildId = event.guildId || primaryGuildId;

    log.info('Received deploy request via event bus', { guildId });
    // For event-bus triggered deploys, fetch the desired state from Supabase
    const { data: stateRow } = await client.supabase
      .from('guild_desired_state')
      .select('*')
      .eq('guild_id', guildId)
      .single();

    if (stateRow) {
      await executeDeploy(client, stateRow as Record<string, unknown>, guildId);
    } else {
      log.error('No desired state found for guild:', guildId);
    }
  });

  log.info('Deploy listener active');
}

// ============================================================
// Deploy Execution
// ============================================================

/**
 * Build a DesiredState from a Supabase Realtime row payload.
 */
function parseDesiredState(row: Record<string, unknown>): DesiredState {
  const roles = (row.roles as DesiredRole[]) ?? [];
  const channels = (row.channels as DesiredChannel[]) ?? [];

  // Extract unique categories from channels
  const seenCats = new Set<string>();
  const categories: DesiredCategory[] = [];
  for (const ch of channels) {
    if (ch.categoryKey && !seenCats.has(ch.categoryKey)) {
      seenCats.add(ch.categoryKey);
      categories.push({
        key: ch.categoryKey,
        name: ch.categoryKey
          .replace(/^cat-/, '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        position: categories.length,
      });
    }
  }

  return {
    everyonePermissions: '0',
    roles,
    categories,
    channels,
  };
}

function getGuildIdFromRow(row: Record<string, unknown>, fallbackGuildId: string): string {
  return typeof row.guild_id === 'string' && row.guild_id.length > 0
    ? row.guild_id
    : fallbackGuildId;
}

/**
 * Execute a deployment from a Supabase Realtime payload.
 */
async function executeDeploy(
  client: SomniClient,
  stateRow: Record<string, unknown>,
  requestedGuildId?: string,
): Promise<void> {
  const guildId = getGuildIdFromRow(stateRow, requestedGuildId ?? client.guildId);
  const desiredState = parseDesiredState(stateRow);
  await executeDeployDirect(client, desiredState, guildId);
}

/**
 * Execute a deployment with a pre-built desired state.
 */
async function executeDeployDirect(
  client: SomniClient,
  desiredState: DesiredState,
  guildId: string,
  optionOverrides?: Partial<DeployOptions>,
): Promise<void> {
  const existingDeploy = deployStatuses.get(guildId);
  if (existingDeploy?.status === 'running') {
    log.warn('Deployment already in progress for guild — ignoring', { guildId });
    return;
  }

  const deployId = `deploy_${Date.now()}`;
  const guild = client.guilds.cache.get(guildId);

  if (!guild) {
    log.error('Guild not found:', guildId);
    return;
  }

  const deployStatus: DeployStatus = {
    guildId,
    deployId,
    status: 'running',
    currentStep: 0,
    totalSteps: 0,
    currentAction: 'Initializing...',
    startedAt: new Date().toISOString(),
  };
  deployStatuses.set(guildId, deployStatus);
  latestDeployGuildId = guildId;

  // Audit: deploy started
  await writeAuditLog(client.supabase, {
    guildId: guildId,
    actorType: 'bot',
    actorId: 'deployer',
    action: 'deploy.started',
    category: 'sync',
    details: {
      deployId,
      roleCount: desiredState.roles.length,
      channelCount: desiredState.channels.length,
      categoryCount: desiredState.categories.length,
    },
  });

  const options: DeployOptions = {
    cleanExisting: true,
    dryRun: false,
    onProgress: (step, total, action) => {
      const activeStatus = deployStatuses.get(guildId);
      if (activeStatus?.deployId === deployId) {
        activeStatus.currentStep = step;
        activeStatus.totalSteps = total;
        activeStatus.currentAction = action;
      }
      log.info(`[${step}/${total}] ${action}`);
    },
    ...optionOverrides,
  };

  try {
    log.info('Starting deployment:', deployId);
    const result = await deployServerState(
      guild,
      client.supabase,
      desiredState,
      options,
    );

    deployStatus.status = result.success ? 'success' : 'failed';
    deployStatus.completedAt = new Date().toISOString();
    deployStatus.result = result;

    // Store ID mappings in discord_id_map
    if (result.idMappings.length > 0) {
      const { error: mapError } = await client.supabase
        .from('discord_id_map')
        .upsert(
          result.idMappings.map((m) => ({
            guild_id: guildId,
            entity_type: m.entityType,
            template_key: m.key,
            discord_id: m.discordId,
          })),
          { onConflict: 'guild_id,entity_type,template_key' },
        );

      if (mapError) {
        log.error('Failed to store ID mappings:', mapError.message);
      } else {
        log.info(`Stored ${result.idMappings.length} ID mappings`);
      }
    }

    // Mark desired state as applied
    if (result.success) {
      const { error: updateError } = await client.supabase
        .from('guild_desired_state')
        .update({
          applied_at: new Date().toISOString(),
          drift_detected: false,
          drift_details: null,
        })
        .eq('guild_id', guildId);

      if (updateError) {
        log.error('Failed to update desired state:', updateError.message);
      }
    }

    // Audit: batch log all individual actions
    await writeAuditBatch(
      client.supabase,
      guildId,
      deployId,
      result.actions.map((a) => ({
        action: a.action,
        entityType: a.entityType,
        entityName: a.entityName,
        discordId: a.discordId,
        success: a.success,
        error: a.error,
      })),
    );

    // Audit: deploy completed
    await writeAuditLog(client.supabase, {
      guildId: guildId,
      actorType: 'bot',
      actorId: 'deployer',
      action: result.success ? 'deploy.completed' : 'deploy.failed',
      category: 'sync',
      details: {
        deployId,
        duration: result.duration,
        actionCount: result.actions.length,
        errorCount: result.errors.length,
      },
      success: result.success,
      errorMessage:
        result.errors.length > 0
          ? result.errors.map((e) => `${e.entityName}: ${e.error}`).join('; ')
          : undefined,
    });

    // Record each created object as its own admin change.
    //
    // The audit row above says "deploy.completed, 14 actions", which is a
    // receipt, not an explanation: it does not tell the owner WHICH roles and
    // channels appeared in their server, and offers no way to reverse them.
    // One row per object gives the Admin Changes page something readable and,
    // because we know the id of everything we created, a genuine undo.
    for (const action of result.actions) {
      if (action.action !== 'create' || !action.success || !action.discordId) continue;
      if (action.entityType !== 'role'
        && action.entityType !== 'channel'
        && action.entityType !== 'category') continue;

      await recordAdminChange(client.supabase, {
        guildId,
        actorId: 'deployer',
        action: `server_deploy.${action.entityType}_created`,
        targetType: action.entityType,
        targetId: action.discordId,
        description: `Server setup created the ${action.entityType} "${action.entityName}".`,
        // It did not exist before, so there is no prior state to show.
        before: null,
        after: { name: action.entityName, discord_id: action.discordId },
        // Deleting a channel the bot just made destroys nothing of the
        // operator's, but it is still structural — worth a confirmation.
        blastRadius: action.entityType === 'role' ? 'medium' : 'high',
        undo: undoByDeleting(action.entityType, action.discordId),
      });
    }

    // Write live state snapshot after deployment so dashboard sees the result immediately
    try {
      await writeGuildSnapshot(guild, client.supabase);
      log.info('Guild live state snapshot updated');
    } catch (snapshotErr) {
      log.error('Failed to write post-deploy snapshot:', snapshotErr);
    }

    // Emit event
    if (result.success) {
      client.eventBus.emit('server.deployed', guildId, {
        deployId,
        rolesCreated: result.actions.filter(a => a.entityType === 'role' && a.action === 'create').length,
        channelsCreated: result.actions.filter(a => a.entityType === 'channel' && a.action === 'create').length,
        categoriesCreated: result.actions.filter(a => a.entityType === 'category' && a.action === 'create').length,
        overridesApplied: result.actions.filter(a => a.entityType === 'override').length,
        duration: result.duration,
      });
    } else {
      client.eventBus.emit('deploy.failed', guildId, {
        deployId,
        error: result.errors.map(e => `${e.entityName}: ${e.error}`).join('; '),
        duration: result.duration,
      });
    }

    log.info(
      `[Deploy] ${result.success ? '✅ Succeeded' : '❌ Failed'} — ` +
        `${result.duration}ms, ${result.actions.length} actions, ` +
        `${result.errors.length} errors`,
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error('Fatal deployment error:', errMsg);

    deployStatus.status = 'failed';
    deployStatus.completedAt = new Date().toISOString();
    deployStatus.currentAction = `Fatal error: ${errMsg}`;

    await writeAuditLog(client.supabase, {
      guildId: guildId,
      actorType: 'bot',
      actorId: 'deployer',
      action: 'deploy.fatal',
      category: 'sync',
      details: { deployId },
      success: false,
      errorMessage: errMsg,
    });
  }
}
