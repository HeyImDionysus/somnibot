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
import { writeGuildSnapshot } from '../services/guild-snapshot.js';
import type { DesiredState, DesiredRole, DesiredChannel, DesiredCategory } from '@somnibot/shared';

// ============================================================
// Deploy Status Tracking
// ============================================================

interface DeployStatus {
  deployId: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  currentStep: number;
  totalSteps: number;
  currentAction: string;
  startedAt: string;
  completedAt?: string;
  result?: DeployResult;
}

let currentDeploy: DeployStatus | null = null;

export function getDeployStatus(): DeployStatus | null {
  return currentDeploy;
}

// ============================================================
// Listener Setup
// ============================================================

/**
 * Start listening for deploy requests on the guild_desired_state table.
 */
export function startDeployListener(client: SomniClient): void {
  const guildId = client.guildId;

  console.log('[Deploy] Starting deploy listener for guild:', guildId);

  // Subscribe to changes on guild_desired_state
  client.supabase
    .channel('deploy-listener')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'guild_desired_state',
        filter: `guild_id=eq.${guildId}`,
      },
      async (payload) => {
        const newState = payload.new as Record<string, unknown>;

        // Deploy is requested when applied_at is cleared and there's data
        if (
          newState &&
          newState.applied_at === null &&
          Array.isArray(newState.roles) &&
          newState.roles.length > 0
        ) {
          console.log('[Deploy] Detected deploy request via Realtime');
          await executeDeploy(client, newState);
        }
      },
    )
    .subscribe((status) => {
      console.log(`[Deploy] Realtime subscription: ${status}`);
    });

  // Also listen via event bus for direct deploy requests (API / tests)
  client.eventBus.on('deploy.requested', async (event) => {
    console.log('[Deploy] Received deploy request via event bus');
    // For event-bus triggered deploys, fetch the desired state from Supabase
    const { data: stateRow } = await client.supabase
      .from('guild_desired_state')
      .select('*')
      .eq('guild_id', guildId)
      .single();

    if (stateRow) {
      await executeDeploy(client, stateRow as Record<string, unknown>);
    } else {
      console.error('[Deploy] No desired state found for guild:', guildId);
    }
  });

  console.log('[Deploy] Deploy listener active');
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

/**
 * Execute a deployment from a Supabase Realtime payload.
 */
async function executeDeploy(
  client: SomniClient,
  stateRow: Record<string, unknown>,
): Promise<void> {
  const desiredState = parseDesiredState(stateRow);
  await executeDeployDirect(client, desiredState);
}

/**
 * Execute a deployment with a pre-built desired state.
 */
async function executeDeployDirect(
  client: SomniClient,
  desiredState: DesiredState,
  optionOverrides?: Partial<DeployOptions>,
): Promise<void> {
  if (currentDeploy?.status === 'running') {
    console.warn('[Deploy] Deployment already in progress — ignoring');
    return;
  }

  const deployId = `deploy_${Date.now()}`;
  const guild = client.guilds.cache.get(guildId);

  if (!guild) {
    console.error('[Deploy] Guild not found:', guildId);
    return;
  }

  currentDeploy = {
    deployId,
    status: 'running',
    currentStep: 0,
    totalSteps: 0,
    currentAction: 'Initializing...',
    startedAt: new Date().toISOString(),
  };

  // Audit: deploy started
  await writeAuditLog(client.supabase, {
    guildId: guildId,
    actorType: 'bot',
    actorId: 'deployer',
    action: 'deploy.started',
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
      if (currentDeploy) {
        currentDeploy.currentStep = step;
        currentDeploy.totalSteps = total;
        currentDeploy.currentAction = action;
      }
      console.log(`[Deploy] [${step}/${total}] ${action}`);
    },
    ...optionOverrides,
  };

  try {
    console.log('[Deploy] Starting deployment:', deployId);
    const result = await deployServerState(
      guild,
      client.supabase,
      desiredState,
      options,
    );

    currentDeploy.status = result.success ? 'success' : 'failed';
    currentDeploy.completedAt = new Date().toISOString();
    currentDeploy.result = result;

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
        console.error('[Deploy] Failed to store ID mappings:', mapError.message);
      } else {
        console.log(`[Deploy] Stored ${result.idMappings.length} ID mappings`);
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
        console.error('[Deploy] Failed to update desired state:', updateError.message);
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

    // Write live state snapshot after deployment so dashboard sees the result immediately
    try {
      await writeGuildSnapshot(guild, client.supabase);
      console.log('[Deploy] Guild live state snapshot updated');
    } catch (snapshotErr) {
      console.error('[Deploy] Failed to write post-deploy snapshot:', snapshotErr);
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

    console.log(
      `[Deploy] ${result.success ? '✅ Succeeded' : '❌ Failed'} — ` +
        `${result.duration}ms, ${result.actions.length} actions, ` +
        `${result.errors.length} errors`,
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[Deploy] Fatal deployment error:', errMsg);

    currentDeploy.status = 'failed';
    currentDeploy.completedAt = new Date().toISOString();
    currentDeploy.currentAction = `Fatal error: ${errMsg}`;

    await writeAuditLog(client.supabase, {
      guildId: guildId,
      actorType: 'bot',
      actorId: 'deployer',
      action: 'deploy.fatal',
      details: { deployId },
      success: false,
      errorMessage: errMsg,
    });
  }
}
