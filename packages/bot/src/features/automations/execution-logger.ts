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
          } else {
            // The row may instead be a STARTED claim whose worker died
            // between the actions marker and finalize. It must never re-run
            // — the reclaim above refuses marked rows by design — but no
            // later writer exists either, so without this it reads
            // 'Conditions not met' forever.
            await this.finalizeStaleStartedClaim(params);
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

    // One atomic statement (reclaim_stale_automation_execution): the DELETE
    // pins every pre-action insert default, the age floor, AND a NOT EXISTS
    // over automation_mass_action_holds.execution_id — all evaluated by the
    // statement that removes the row. A HELD execution stays pre-action shaped
    // for as long as approval takes, and the earlier separate-statement
    // version raced hold creation: a redelivery could observe no hold, the
    // original worker could insert one, and the delete still removed the
    // now-held execution (ON DELETE SET NULL detaching the hold). Any error
    // fails closed: nothing reclaimed.
    const { data: removed, error } = await this.supabase.rpc(
      'reclaim_stale_automation_execution',
      {
        p_guild_id: params.guildId,
        p_automation_id: params.automationId,
        p_occurrence_id: params.occurrenceId,
        p_stale_before: staleBefore,
      },
    );
    if (error) {
      log.error('Failed to reclaim stale pre-action claim:', error.message);
      return false;
    }
    if (removed === true) {
      log.warn(
        `Reclaimed stranded pre-action execution claim for automation ${params.automationId} `
        + `occurrence ${params.occurrenceId}; the previous run released nothing durable.`,
      );
    }
    return removed === true;
  }

  /**
   * Guild-wide sweep of the same interrupted shape, for STARTUP: gateway
   * events never replay across restarts, so the claim-time terminalizer
   * alone cannot reach rows stranded by a crashed worker. Returns how many
   * rows turned truthful.
   */
  async finalizeStaleStartedSweep(guildId: string): Promise<number> {
    const staleBefore = new Date(Date.now() - STALE_PRE_ACTION_CLAIM_MS).toISOString();
    const { data, error } = await this.supabase.rpc(
      'finalize_stale_started_automation_executions',
      { p_guild_id: guildId, p_stale_before: staleBefore },
    );
    if (error) {
      throw new Error(`Failed to sweep stale started executions: ${error.message}`);
    }
    const count = typeof data === 'number' ? data : 0;
    if (count > 0) {
      log.warn(
        `Terminalized ${count} interrupted automation execution(s) left by an earlier run.`,
      );
    }
    return count;
  }

  /**
   * Terminalize a stale STARTED claim as interrupted (Definer-rights RPC,
   * lock-then-check, age floor, no linked hold). Actions may have reached
   * Discord, so the occurrence is never re-executed; only the history row
   * turns truthful. True when this call terminalized the row.
   */
  private async finalizeStaleStartedClaim(params: ClaimParams): Promise<boolean> {
    const staleBefore = new Date(Date.now() - STALE_PRE_ACTION_CLAIM_MS).toISOString();
    const { data, error } = await this.supabase.rpc(
      'finalize_stale_started_automation_execution',
      {
        p_guild_id: params.guildId,
        p_automation_id: params.automationId,
        p_occurrence_id: params.occurrenceId,
        p_stale_before: staleBefore,
      },
    );
    if (error) {
      log.error('Failed to finalize a stale started claim:', error.message);
      return false;
    }
    if (data === true) {
      log.warn(
        `Terminalized an interrupted execution for automation ${params.automationId} `
        + `occurrence ${params.occurrenceId}; its worker died after the actions marker was set.`,
      );
    }
    return data === true;
  }

  /**
   * Finalize a claimed execution row with the run's results (UPDATE by id). When
   * there is no claim row (the claim insert errored), fall back to a plain insert
   * so the execution is still logged.
   */
  /**
   * Durably mark that this claim is about to execute its first action. The
   * stale-claim reclaim refuses marked rows: after this point a crash before
   * finalize must NOT let a redelivery repeat external side effects. Throws
   * when the write fails or matches no row — callers must not execute.
   */
  async markActionsStarted(rowId: string | null): Promise<void> {
    if (!rowId) {
      throw new Error('Cannot mark actions started without a durable claim row');
    }
    const { data, error } = await this.supabase
      .from('automation_executions')
      .update({ actions_started: true })
      .eq('id', rowId)
      .select('id')
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to mark automation actions started: ${error.message}`);
    }
    if (!data) {
      throw new Error('Automation claim disappeared before actions could start');
    }
  }

  /**
   * finalize that THROWS on a failed row update. The interrupted-hold path
   * must know the truth landed before terminalizing the hold — a swallowed
   * error there left a terminal hold with pre-action history forever.
   */
  async finalizeStrict(
    rowId: string | null,
    result: ExecutionResult,
    opts?: { skipCountBump?: boolean },
  ): Promise<void> {
    if (!rowId) {
      await this.log(result);
      return;
    }
    const { data, error } = await this.supabase
      .from('automation_executions')
      .update({
        conditions_passed: result.conditionsPassed,
        actions_executed: result.actionsExecuted,
        actions_failed: result.actionsFailed,
        errors: result.errors,
        duration_ms: result.durationMs,
      })
      .eq('id', rowId)
      .select('id')
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to finalize execution: ${error.message}`);
    }
    if (!data) {
      throw new Error('Execution row disappeared before finalization');
    }
    // History is truthfully written; retain the same fired-counter
    // bookkeeping finalize()/log() perform so approved holds advance
    // execution_count / last_executed_at. The counter stays ADVISORY:
    // its failure must not throw an already-recorded history row back
    // into the retry path. skipCountBump lets a caller that already
    // counted this run (a landed success finalize being overwritten
    // with interruption details) avoid counting it twice.
    if (!opts?.skipCountBump) {
      try {
        await this.bumpCount(result);
      } catch (bumpError) {
        log.error('Failed to bump automation execution count:', bumpError);
      }
    }
  }

  /**
   * Revert the actions-started marker when it is PROVEN nothing ran (the
   * failure happened strictly between marking and the first action). Guarded
   * on the pre-action counters so a row with real progress is never
   * un-marked. Throws when the revert cannot be confirmed.
   */
  async revertActionsStarted(rowId: string | null): Promise<void> {
    if (!rowId) return;
    const { data, error } = await this.supabase
      .from('automation_executions')
      .update({ actions_started: false })
      .eq('id', rowId)
      .eq('actions_started', true)
      .eq('actions_executed', 0)
      .eq('actions_failed', 0)
      .select('id')
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to revert actions-started marker: ${error.message}`);
    }
    if (!data) {
      throw new Error('Actions-started marker could not be reverted');
    }
  }

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
