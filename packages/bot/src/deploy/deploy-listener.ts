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
import { createLogger } from '@somnibot/shared';
import {
  claimDeployRequest,
  desiredStateFromDeployRow,
  failInterruptedDeployRequests,
  parseRequestedDeployRow,
  type RequestedDeployRow,
} from './deploy-request-lifecycle.js';
import { executeClaimedDeployment } from './deploy-executor.js';
export { getDeployStatus } from './deploy-executor.js';

const log = createLogger('DeployListener');

// ============================================================
// Listener Setup
// ============================================================

/**
 * Start listening for deploy requests on the guild_desired_state table.
 */
export function startDeployListener(client: SomniClient): void {
  const primaryGuildId = client.guildId;
  let recoveryStarted = false;

  log.info('Starting deploy listener for all guilds', { primaryGuildId });

  // Subscribe to changes on guild_desired_state
  client.supabase
    .channel('deploy-listener')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'guild_desired_state',
      },
      async (payload) => {
        const request = parseRequestedDeployRow(payload.new, primaryGuildId);
        if (!request) return;
        log.info('Detected deploy request via Realtime', {
          guildId: request.guild_id,
          requestId: request.deploy_request_id,
        });
        await executeDeploy(client, request);
      },
    )
    .subscribe((status) => {
      log.info(`Realtime subscription: ${status}`);
      if (status === 'SUBSCRIBED' && !recoveryStarted) {
        recoveryStarted = true;
        void recoverPendingDeploys(client);
      }
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

    const request = parseRequestedDeployRow(stateRow, guildId);
    if (request) {
      await executeDeploy(client, request);
    } else {
      log.error('No requested deployment found for guild:', guildId);
    }
  });

  log.info('Deploy listener active');
}

async function recoverPendingDeploys(client: SomniClient): Promise<void> {
  try {
    const interrupted = await failInterruptedDeployRequests(client);
    if (interrupted > 0) log.warn('Marked interrupted deployments as failed', { interrupted });
  } catch (error) {
    log.error('Failed to reconcile interrupted deployments:', error);
    return;
  }
  const { data, error } = await client.supabase
    .from('guild_desired_state')
    .select('*')
    .eq('deploy_status', 'requested');

  if (error) {
    log.error('Failed to recover pending deploy requests:', error.message);
    return;
  }

  if (!Array.isArray(data)) return;

  for (const row of data) {
    const request = parseRequestedDeployRow(row, client.guildId);
    if (request) await executeDeploy(client, request);
  }
}

// ============================================================
// Deploy Execution
// ============================================================

async function executeDeploy(
  client: SomniClient,
  request: RequestedDeployRow,
): Promise<void> {
  const claimed = await claimDeployRequest(client, request);
  if (!claimed) {
    log.info('Deployment request was already claimed or settled', {
      guildId: request.guild_id,
      requestId: request.deploy_request_id,
    });
    return;
  }
  await executeClaimedDeployment(client, desiredStateFromDeployRow(claimed), claimed, {
    cleanExisting: claimed.deploy_mode === 'destructive',
  });
}
