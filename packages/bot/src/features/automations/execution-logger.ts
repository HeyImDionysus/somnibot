/**
 * Automation execution logger — writes results to Supabase.
 * §20.7 of the architecture doc.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('ExecLogger');

export interface ExecutionResult {
  automationId: string;
  guildId: string;
  triggeredBy: string;
  triggerEvent: string;
  conditionsPassed: boolean;
  actionsExecuted: number;
  actionsFailed: number;
  errors: string[];
  durationMs: number;
}

export class ExecutionLogger {
  constructor(private supabase: SupabaseClient) {}

  async log(result: ExecutionResult): Promise<void> {
    const { error } = await this.supabase.from('automation_executions').insert({
      automation_id: result.automationId,
      guild_id: result.guildId,
      triggered_by: result.triggeredBy,
      trigger_event: result.triggerEvent,
      conditions_passed: result.conditionsPassed,
      actions_executed: result.actionsExecuted,
      actions_failed: result.actionsFailed,
      errors: result.errors,
      duration_ms: result.durationMs,
    });

    if (error) {
      log.error('Failed to log execution:', error.message);
    }

    // Update execution count on the automation via RPC
    if (result.conditionsPassed) {
      const { error: rpcError } = await this.supabase.rpc('increment_automation_count', {
        automation_uuid: result.automationId,
      });

      if (rpcError) {
        // Fallback: just update the timestamp
        await this.supabase
          .from('automations')
          .update({ last_executed_at: new Date().toISOString() })
          .eq('id', result.automationId);
      }
    }
  }
}
