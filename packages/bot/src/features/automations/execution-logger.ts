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

export interface ClaimParams {
  automationId: string;
  guildId: string;
  triggeredBy: string;
  triggerEvent: string;
  /** Durable occurrence id; a redelivery of the same occurrence is deduped. */
  occurrenceId: string;
}

export type ClaimResult =
  | { claimed: true; rowId: string | null }
  | { claimed: false; rowId: null };

/**
 * Age floor before a pre-action claim may be reclaimed. Real runs finish in
 * seconds; ten minutes cannot race a live evaluation, only recover a dead one.
 */
const STALE_PRE_ACTION_CLAIM_MS = 10 * 60_000;

export class ExecutionLogger {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Stake a durable claim on (guild, automation, occurrence) BEFORE running any
   * actions. The unique index automation_executions_occurrence_uidx makes a
   * redelivered occurrence's INSERT fail with 23505 → claimed:false → the caller
   * skips the automation, so grant_entitlement / send_message / give_role never
   * re-fire for the same occurrence. Returns the claim row id to finalize later.
   * A non-conflict insert error still allows processing (claimed:true, rowId:null)
   * so a transient logging failure never silently drops a real automation.
   */
  async claim(params: ClaimParams): Promise<ClaimResult> {
    const { data, error } = await this.supabase
      .from('automation_executions')
      .insert({
        automation_id: params.automationId,
        guild_id: params.guildId,
        triggered_by: params.triggeredBy,
        trigger_event: params.triggerEvent,
        occurrence_id: params.occurrenceId,
        conditions_passed: false,
        actions_executed: 0,
        actions_failed: 0,
        errors: [],
        duration_ms: 0,
      })
      .select('id')
      .single();

    if (error) {
      if ((error as { code?: string }).code === '23505') {
        // The existing row may be a STRANDED PRE-ACTION claim: a run whose
        // condition evaluation failed during an outage and whose release
        // DELETE failed in the same outage (or a process that died
        // mid-evaluation). No action ran and no durable hold exists, so
        // without reclaim every redelivery hits this 23505 and the
        // automation skips the occurrence forever. Reclaim ONLY when the row
        // still carries the exact pre-action insert defaults AND is old
        // enough that no live run can be holding it — and delete with those
        // same fields in the WHERE so a finalize that lands concurrently
        // wins, not us.
        if (params.occurrenceId) {
          const reclaimed = await this.reclaimStalePreActionClaim(params);
          if (reclaimed) {
            const retry = await this.supabase
              .from('automation_executions')
              .insert({
                automation_id: params.automationId,
                guild_id: params.guildId,
                triggered_by: params.triggeredBy,
                trigger_event: params.triggerEvent,
                occurrence_id: params.occurrenceId,
                conditions_passed: false,
                actions_executed: 0,
                actions_failed: 0,
                errors: [],
                duration_ms: 0,
              })
              .select('id')
              .single();
            if (!retry.error) {
              return { claimed: true, rowId: (retry.data as { id: string } | null)?.id ?? null };
            }
            // Lost the re-insert race to another shard: genuinely claimed.
          }
        }
        return { claimed: false, rowId: null };
      }
      log.error('Failed to claim execution:', error.message);
      return { claimed: true, rowId: null };
    }
    return { claimed: true, rowId: (data as { id: string } | null)?.id ?? null };
  }

  /**
   * Delete a stranded pre-action claim for this occurrence, compare-and-set
   * style. True only when a row was actually removed. A live run is protected
   * twice over: the age floor (real runs finish in seconds), and every
   * pre-action default in the WHERE — a finalized row matches none of them.
   */
  private async reclaimStalePreActionClaim(params: ClaimParams): Promise<boolean> {
    const staleBefore = new Date(Date.now() - STALE_PRE_ACTION_CLAIM_MS).toISOString();
    const { data, error } = await this.supabase
      .from('automation_executions')
      .delete()
      .eq('guild_id', params.guildId)
      .eq('automation_id', params.automationId)
      .eq('occurrence_id', params.occurrenceId)
      .eq('conditions_passed', false)
      .eq('actions_executed', 0)
      .eq('actions_failed', 0)
      .eq('duration_ms', 0)
      .lt('created_at', staleBefore)
      .select('id');
    if (error) {
      log.error('Failed to reclaim stale pre-action claim:', error.message);
      return false;
    }
    const removed = Array.isArray(data) && data.length > 0;
    if (removed) {
      log.warn(
        `Reclaimed stranded pre-action execution claim for automation ${params.automationId} `
        + `occurrence ${params.occurrenceId}; the previous run released nothing durable.`,
      );
    }
    return removed;
  }

  /**
   * Finalize a claimed execution row with the run's results (UPDATE by id). When
   * there is no claim row (the claim insert errored), fall back to a plain insert
   * so the execution is still logged.
   */
  async finalize(rowId: string | null, result: ExecutionResult): Promise<void> {
    if (rowId) {
      const { error } = await this.supabase
        .from('automation_executions')
        .update({
          conditions_passed: result.conditionsPassed,
          actions_executed: result.actionsExecuted,
          actions_failed: result.actionsFailed,
          errors: result.errors,
          duration_ms: result.durationMs,
        })
        .eq('id', rowId);
      if (error) log.error('Failed to finalize execution:', error.message);
    } else {
      await this.log(result);
    }

    await this.bumpCount(result);
  }

  /**
   * Release a claim when processing failed before any action or durable hold
   * was created. A redelivery can then safely retry the same occurrence.
   */
  async release(rowId: string | null): Promise<void> {
    if (!rowId) return;
    // A transient failure here strands a pre-action claim (see claim()'s
    // reclaim path for the backstop) — retry in place first so the common
    // blip never needs the backstop at all.
    let lastMessage = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await this.supabase
        .from('automation_executions')
        .delete()
        .eq('id', rowId);
      if (!error) return;
      lastMessage = error.message;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
    throw new Error(`Failed to release automation execution claim: ${lastMessage}`);
  }

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

    await this.bumpCount(result);
  }

  /** Increment the automation's execution count (only when conditions passed). */
  private async bumpCount(result: ExecutionResult): Promise<void> {
    if (!result.conditionsPassed) return;
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
