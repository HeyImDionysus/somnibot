/**
 * Deploy Listener — Subscribes to Supabase Realtime for deploy requests.
 *
 * When the dashboard atomically records a requested lifecycle row, this
 * listener detects the change and claims it before triggering the deployer.
 *
 * Flow:
 * 1. Dashboard stores desired state in guild_desired_state
 * 2. Dashboard POSTs /api/deploy → records a unique requested claim
 * 3. This listener detects and claims the request
 * 4. Deployer runs while renewing the claim lease
 * 5. Results are audited and the matching claim is settled
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
const RECOVERY_INTERVAL_MS = 30_000;

// ============================================================
// Listener Setup
// ============================================================

/**
 * Start listening for deploy requests on the guild_desired_state table.
 */
export function startDeployListener(client: SomniClient): void {
  const primaryGuildId = client.guildId;
  let recoveryStarted = false;
  let recoveryInFlight = false;
  const recover = async (): Promise<void> => {
    if (recoveryInFlight) return;
    recoveryInFlight = true;
    try {
      await recoverPendingDeploys(client);
    } finally {
      recoveryInFlight = false;
    }
  };

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
        void recover();
        const timer = setInterval(() => void recover(), RECOVERY_INTERVAL_MS);
        timer.unref();
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
