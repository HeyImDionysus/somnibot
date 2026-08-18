import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AutomationAction } from './action-executor.js';

const claimSchema = z.object({
  claim_state: z.enum(['claimed', 'busy', 'completed', 'failed', 'manual_reconcile', 'missing']),
  action_payload: z.object({
    type: z.string(),
    config: z.record(z.unknown()),
  }).nullable(),
  retry_safe: z.boolean(),
  attempt_count: z.number().int().nonnegative(),
});

const recoverySchema = z.object({
  execution_id: z.string().uuid(),
  recovery_state: z.literal('resumable'),
  recovery_context: z.object({
    automationId: z.string().uuid(),
    occurrenceId: z.string(),
    triggeredBy: z.string(),
    triggerEvent: z.string(),
    memberId: z.string().nullable(),
    channelId: z.string().nullable(),
    messageId: z.string().nullable(),
    variables: z.record(z.string()),
  }),
});

const progressSchema = z.object({
  action_index: z.number().int().nonnegative(),
  target_id: z.string(),
  action_payload: z.object({
    type: z.string(),
    config: z.record(z.unknown()),
  }),
  status: z.enum(['pending', 'executing', 'completed', 'failed', 'manual_reconcile']),
  result: z.object({
    executed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errors: z.array(z.string()),
  }).nullable(),
});

export type ActionProgressContext = z.infer<typeof recoverySchema>['recovery_context'];
export type RecoveredExecution = z.infer<typeof recoverySchema>;
export type ActionProgressRow = z.infer<typeof progressSchema>;

export type ActionPlanEntry = {
  readonly actionIndex: number;
  readonly targetId: string;
  readonly action: AutomationAction;
};

export type ActionLease = {
  readonly executionId: string;
  readonly entry: ActionPlanEntry;
  readonly ownerToken: string;
};

const RETRY_SAFE_ACTIONS = new Set(['grant_entitlement', 'wait_delay']);
export const ACTION_PROGRESS_LEASE_MS = 120_000;

export class AutomationActionProgress {
  constructor(private readonly supabase: SupabaseClient) {}

  async initialize(
    executionId: string,
    entries: readonly ActionPlanEntry[],
    context: ActionProgressContext,
  ): Promise<void> {
    const { error } = await this.supabase.rpc('initialize_automation_action_progress', {
      p_execution_id: executionId,
      p_actions: entries.map((entry) => ({
        action_index: entry.actionIndex,
        target_id: entry.targetId,
        action_type: entry.action.type,
        action_payload: entry.action,
        retry_safe: RETRY_SAFE_ACTIONS.has(entry.action.type),
      })),
      p_recovery_context: context,
    });
    if (error) throw new Error(`Failed to initialize automation action progress: ${error.message}`);
  }

  async claim(lease: ActionLease): Promise<z.infer<typeof claimSchema>> {
    const { data, error } = await this.supabase.rpc('claim_automation_action_progress', {
      p_execution_id: lease.executionId,
      p_action_index: lease.entry.actionIndex,
      p_target_id: lease.entry.targetId,
      p_owner_token: lease.ownerToken,
      p_lease_seconds: ACTION_PROGRESS_LEASE_MS / 1_000,
    });
    if (error) throw new Error(`Failed to claim automation action: ${error.message}`);
    return claimSchema.parse(Array.isArray(data) ? data[0] : null);
  }

  async settle(
    lease: ActionLease,
    result: { readonly executed: number; readonly failed: number; readonly errors: readonly string[] },
  ): Promise<void> {
    const { data, error } = await this.supabase.rpc('settle_automation_action_progress', {
      p_execution_id: lease.executionId,
      p_action_index: lease.entry.actionIndex,
      p_target_id: lease.entry.targetId,
      p_owner_token: lease.ownerToken,
      p_success: result.failed === 0,
      p_result: result,
    });
    if (error) throw new Error(`Failed to settle automation action: ${error.message}`);
    if (data !== true) throw new Error('Automation action lease was lost before settlement');
  }

  async recover(guildId: string): Promise<readonly RecoveredExecution[]> {
    const staleBefore = new Date(Date.now() - ACTION_PROGRESS_LEASE_MS).toISOString();
    const { data, error } = await this.supabase.rpc('recover_stale_automation_action_progress', {
      p_guild_id: guildId,
      p_stale_before: staleBefore,
    });
    if (error) throw new Error(`Failed to recover stale automation actions: ${error.message}`);
    return z.array(recoverySchema).parse(data ?? []);
  }

  async rows(executionId: string): Promise<readonly ActionProgressRow[]> {
    const { data, error } = await this.supabase
      .from('automation_action_progress')
      .select('action_index, target_id, action_payload, status, result')
      .eq('execution_id', executionId)
      .order('action_index', { ascending: true })
      .order('target_id', { ascending: true });
    if (error) throw new Error(`Failed to read automation action progress: ${error.message}`);
    return z.array(progressSchema).parse(data ?? []);
  }

  async complete(executionId: string, recovered: boolean): Promise<void> {
    const { data, error } = await this.supabase.rpc('complete_automation_action_progress', {
      p_execution_id: executionId,
      p_recovered: recovered,
    });
    if (error) throw new Error(`Failed to complete automation action progress: ${error.message}`);
    if (data !== true) throw new Error('Automation action progress was not ready to complete');
  }

  newOwnerToken(): string {
    return randomUUID();
  }
}
