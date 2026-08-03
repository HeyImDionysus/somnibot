import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('RuntimeLease');
const TTL_SECONDS = 45;
const HEARTBEAT_MS = 10_000;
const LOSS_DEADLINE_MS = 35_000;

type RuntimeMode = 'regular-local' | 'vps';

type ClaimRow = {
  acquired: boolean;
  active_mode: RuntimeMode;
  lease_expires_at: string;
};

export interface RuntimeLeaseController {
  release(): Promise<void>;
}

export function resolveRuntimeHolderId(
  configured: string,
  applicationId: string,
  mode: RuntimeMode,
): string {
  if (configured.trim().length >= 16) return configured.trim();
  return createHash('sha256').update(`somnibot-runtime:${mode}:${applicationId}`).digest('hex');
}

function firstClaimRow(data: unknown): ClaimRow | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  const value = row as Record<string, unknown>;
  if (typeof value.acquired !== 'boolean') return null;
  return value as ClaimRow;
}

export async function acquireRuntimeLease(options: {
  supabase: SupabaseClient;
  holderId: string;
  mode: RuntimeMode;
  onLost: (reason: string) => void;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): Promise<RuntimeLeaseController> {
  const sessionId = randomUUID();
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const claim = await options.supabase.rpc('claim_somnibot_runtime', {
    p_holder_id: options.holderId,
    p_session_id: sessionId,
    p_runtime_mode: options.mode,
    p_ttl_seconds: TTL_SECONDS,
  });
  if (claim.error) throw new Error(`Runtime ownership check failed: ${claim.error.message}`);
  const row = firstClaimRow(claim.data);
  if (!row?.acquired) {
    const activeMode = row?.active_mode ?? 'another';
    throw new Error(`SomniBot is already active in ${activeMode} mode. Stop that runtime before starting this one.`);
  }

  let lastSuccess = now();
  let stopped = false;
  let lossReported = false;
  const heartbeat = async () => {
    if (stopped) return;
    const result = await options.supabase.rpc('heartbeat_somnibot_runtime', {
      p_holder_id: options.holderId,
      p_session_id: sessionId,
      p_ttl_seconds: TTL_SECONDS,
    });
    if (!result.error && result.data === true) {
      lastSuccess = now();
      return;
    }
    if (result.error) {
      log.warn('Runtime lease heartbeat failed; retrying before the safety deadline.');
    }
  };
  const timer = setIntervalFn(() => {
    if (!lossReported && now() - lastSuccess >= LOSS_DEADLINE_MS) {
      lossReported = true;
      options.onLost('Runtime ownership could not be renewed before its safety deadline.');
      return;
    }
    void heartbeat();
  }, HEARTBEAT_MS);
  timer.unref?.();

  return {
    async release() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
      const result = await options.supabase.rpc('release_somnibot_runtime', {
        p_holder_id: options.holderId,
        p_session_id: sessionId,
      });
      if (result.error) log.warn('Runtime lease release failed; it will expire automatically.');
    },
  };
}
