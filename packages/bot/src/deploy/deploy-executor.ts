import type { SomniClient } from '../client.js';
import type { DesiredState } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';
import { deployServerState, type DeployOptions, type DeployResult } from './deployer.js';
import type { ClaimedDeployRow } from './deploy-request-lifecycle.js';
import { renewDeployRequestClaim, settleDeployRequest } from './deploy-request-lifecycle.js';
import { recordCreatedResourceChanges } from './deploy-created-resources.js';
import { writeAuditBatch, writeAuditLog } from '../services/audit.js';
import { writeGuildSnapshot } from '../services/guild-snapshot.js';

const log = createLogger('DeployListener');
const LEASE_RENEWAL_INTERVAL_MS = 30_000;

type DeployLeaseHeartbeat = {
  signal: AbortSignal;
  stop(): Promise<Error | null>;
};

function startDeployLeaseHeartbeat(
  client: SomniClient,
  request: ClaimedDeployRow,
): DeployLeaseHeartbeat {
  const abortController = new AbortController();
  let stopped = false;
  let failure: Error | null = null;
  let renewal = Promise.resolve();

  const renew = (): void => {
    renewal = renewal.then(async () => {
      if (stopped || failure) return;
      try {
        const renewed = await renewDeployRequestClaim(client, request);
        if (!renewed) throw new Error('Deployment claim lease is no longer owned by this executor');
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        abortController.abort(failure);
      }
    });
  };

  const timer = setInterval(renew, LEASE_RENEWAL_INTERVAL_MS);
  timer.unref();

  return {
    signal: abortController.signal,
    async stop(): Promise<Error | null> {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await renewal;
      return failure;
    },
  };
}

type DeployStatus = {
  guildId: string;
  deployId: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  currentStep: number;
  totalSteps: number;
  currentAction: string;
  startedAt: string;
  completedAt?: string;
  result?: DeployResult;
};

const deployStatuses = new Map<string, DeployStatus>();
let latestDeployGuildId: string | null = null;

export function getDeployStatus(guildId?: string): DeployStatus | null {
  if (guildId) return deployStatuses.get(guildId) ?? null;
  if (latestDeployGuildId) return deployStatuses.get(latestDeployGuildId) ?? null;
  return null;
}

export async function executeClaimedDeployment(
  client: SomniClient,
  desiredState: DesiredState,
  request: ClaimedDeployRow,
  optionOverrides?: Partial<DeployOptions>,
): Promise<void> {
  const guildId = request.guild_id;
  const existingDeploy = deployStatuses.get(guildId);
  if (existingDeploy?.status === 'running') {
    log.warn('Deployment already in progress for guild — ignoring', { guildId });
    return;
  }

  const deployId = `deploy_${request.deploy_request_id}`;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    log.error('Guild not found:', guildId);
    const settled = await settleDeployRequest(
      client,
      request,
      false,
      'Guild is not available to the bot',
    );
    if (!settled) log.error('Failed to settle unavailable-guild deployment claim', { guildId });
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

  const heartbeat = startDeployLeaseHeartbeat(client, request);
  const callerProgress = optionOverrides?.onProgress;
  const options: DeployOptions = {
    cleanExisting: false,
    dryRun: false,
    ...optionOverrides,
    abortSignal: heartbeat.signal,
    onProgress: (step, total, action) => {
      const activeStatus = deployStatuses.get(guildId);
      if (activeStatus?.deployId === deployId) {
        activeStatus.currentStep = step;
        activeStatus.totalSteps = total;
        activeStatus.currentAction = action;
      }
      callerProgress?.(step, total, action);
      log.info(`[${step}/${total}] ${action}`);
    },
  };

  try {
    await writeAuditLog(client.supabase, {
      guildId,
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

    log.info('Starting deployment:', deployId);
    const result = await deployServerState(guild, client.supabase, desiredState, options);

    await writeAuditBatch(
      client.supabase,
      guildId,
      deployId,
      result.actions.map((action) => ({
        action: action.action,
        entityType: action.entityType,
        entityName: action.entityName,
        discordId: action.discordId,
        success: action.success,
        error: action.error,
      })),
    );
    await recordCreatedResourceChanges(client, guildId, result);

    try {
      await writeGuildSnapshot(guild, client.supabase);
      log.info('Guild live state snapshot updated');
    } catch (snapshotError) {
      log.error('Failed to write post-deploy snapshot:', snapshotError);
    }

    const leaseFailure = await heartbeat.stop();
    if (leaseFailure) throw leaseFailure;

    const resultError = result.errors
      .map((error) => `${error.entityName}: ${error.error}`)
      .join('; ');
    const settled = await settleDeployRequest(
      client,
      request,
      result.success,
      resultError || undefined,
    );
    if (!settled) {
      result.success = false;
      result.errors.push({
        step: result.actions.length + 1,
        entityType: 'system',
        entityName: 'Deployment completion',
        error: 'Failed to settle the claimed deployment request',
      });
      deployStatus.status = 'failed';
      deployStatus.completedAt = new Date().toISOString();
      deployStatus.currentAction = 'Claim ownership was lost before terminal settlement';
      deployStatus.result = result;
      log.error('Deployment claim was no longer owned; terminal events remain authoritative to storage', {
        guildId,
        deployId,
      });
      return;
    }

    const finalError = result.errors
      .map((error) => `${error.entityName}: ${error.error}`)
      .join('; ');
    try {
      await writeAuditLog(client.supabase, {
        guildId,
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
        errorMessage: finalError || undefined,
      });
    } catch (auditError) {
      log.error('Failed to write terminal deployment audit:', auditError);
    }

    deployStatus.status = result.success ? 'success' : 'failed';
    deployStatus.completedAt = new Date().toISOString();
    deployStatus.result = result;

    if (result.success) {
      client.eventBus.emit('server.deployed', guildId, {
        deployId,
        rolesCreated: result.actions.filter((action) =>
          action.entityType === 'role' && action.action === 'create').length,
        channelsCreated: result.actions.filter((action) =>
          action.entityType === 'channel' && action.action === 'create').length,
        categoriesCreated: result.actions.filter((action) =>
          action.entityType === 'category' && action.action === 'create').length,
        overridesApplied: result.actions.filter((action) =>
          action.entityType === 'override').length,
        duration: result.duration,
      });
    } else {
      client.eventBus.emit('deploy.failed', guildId, {
        deployId,
        error: result.errors.map((error) => `${error.entityName}: ${error.error}`).join('; '),
        duration: result.duration,
      });
    }

    log.info(
      `[Deploy] ${result.success ? '✅ Succeeded' : '❌ Failed'} — `
      + `${result.duration}ms, ${result.actions.length} actions, `
      + `${result.errors.length} errors`,
    );
  } catch (error) {
    const heartbeatFailure = await heartbeat.stop();
    const primaryError = error instanceof Error ? error : new Error(String(error));
    const errorMessage = heartbeatFailure && heartbeatFailure.message !== primaryError.message
      ? `${primaryError.message}; ${heartbeatFailure.message}`
      : primaryError.message;
    log.error('Fatal deployment error:', errorMessage);
    deployStatus.status = 'failed';
    deployStatus.completedAt = new Date().toISOString();
    deployStatus.currentAction = `Fatal error: ${errorMessage}`;

    let settled = false;
    try {
      settled = await settleDeployRequest(client, request, false, errorMessage);
      if (!settled) log.error('Fatal deployment claim was no longer owned', { guildId, deployId });
    } catch (settlementError) {
      log.error('Failed to settle fatal deployment:', settlementError);
    }
    if (settled) {
      try {
        await writeAuditLog(client.supabase, {
          guildId,
          actorType: 'bot',
          actorId: 'deployer',
          action: 'deploy.fatal',
          category: 'sync',
          details: { deployId },
          success: false,
          errorMessage,
        });
      } catch (auditError) {
        log.error('Failed to write fatal deployment audit:', auditError);
      }
    }
  }
}
