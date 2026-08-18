import type { Guild, GuildMember, Message } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { executeActions, type ActionContext, type AutomationAction } from './action-executor.js';
import { AutomationRateLimiter } from './rate-limiter.js';
import { ExecutionLogger, type ExecutionResult } from './execution-logger.js';
import {
  AutomationActionProgress,
  type ActionLease,
  type ActionPlanEntry,
  type ActionProgressContext,
} from './action-progress.js';

const MEMBER_TARGETED_ACTIONS = new Set([
  'send_dm',
  'give_role',
  'remove_role',
  'grant_entitlement',
  'create_ticket',
  'ban_member',
  'kick_member',
  'mute_member',
]);

type ActionCounts = { executed: number; failed: number; errors: string[] };

type RunnerDependencies = {
  readonly guild: Guild;
  readonly supabase: SupabaseClient;
  readonly rateLimiter: () => AutomationRateLimiter;
  readonly executionLogger: ExecutionLogger;
};

type ActionRun = {
  readonly executionId: string;
  readonly actions: readonly AutomationAction[];
  readonly context: ActionContext;
  readonly affectedMemberIds: readonly string[];
};

export class AutomationActionResumeRunner {
  private readonly progress: AutomationActionProgress;

  private readonly guild: Guild;
  private readonly supabase: SupabaseClient;
  private readonly rateLimiter: () => AutomationRateLimiter;
  private readonly executionLogger: ExecutionLogger;

  constructor(dependencies: RunnerDependencies) {
    this.guild = dependencies.guild;
    this.supabase = dependencies.supabase;
    this.rateLimiter = dependencies.rateLimiter;
    this.executionLogger = dependencies.executionLogger;
    this.progress = new AutomationActionProgress(dependencies.supabase);
  }

  async execute(run: ActionRun): Promise<ActionCounts> {
    const entries = this.buildPlan(run.actions, run.context, run.affectedMemberIds);
    const recoveryContext: ActionProgressContext = {
      automationId: run.context.automationId,
      occurrenceId: run.context.occurrenceId,
      triggeredBy: run.context.member?.id ?? 'system',
      triggerEvent: 'recovered',
      memberId: run.context.member?.id ?? null,
      channelId: run.context.channelId,
      messageId: run.context.messageId,
      variables: run.context.variables,
    };
    await this.progress.initialize(run.executionId, entries, recoveryContext);

    const total: ActionCounts = { executed: 0, failed: 0, errors: [] };
    for (const entry of entries) {
      const lease: ActionLease = {
        executionId: run.executionId,
        entry,
        ownerToken: this.progress.newOwnerToken(),
      };
      const claimed = await this.progress.claim(lease);
      if (claimed.claim_state !== 'claimed' || !claimed.action_payload) {
        throw new Error(`Automation action ${entry.actionIndex} was not claimable: ${claimed.claim_state}`);
      }
      const claimedEntry: ActionPlanEntry = { ...entry, action: claimed.action_payload };
      const member = await this.resolveMember(entry.targetId, run.context.member);
      const result = await executeActions(
        [claimedEntry.action],
        this.withMember(run.context, member),
        claimedEntry.actionIndex,
      );
      await this.progress.settle({ ...lease, entry: claimedEntry }, result);
      total.executed += result.executed;
      total.failed += result.failed;
      total.errors.push(...result.errors);
    }
    return total;
  }

  async complete(executionId: string): Promise<void> {
    await this.progress.complete(executionId, false);
  }

  async recover(): Promise<void> {
    const recovered = await this.progress.recover(this.guild.id);
    for (const execution of recovered) {
      const rows = await this.progress.rows(execution.execution_id);
      for (const row of rows) {
        if (row.status !== 'pending') continue;
        const entry: ActionPlanEntry = {
          actionIndex: row.action_index,
          targetId: row.target_id,
          action: row.action_payload,
        };
        const lease: ActionLease = {
          executionId: execution.execution_id,
          entry,
          ownerToken: this.progress.newOwnerToken(),
        };
        const claim = await this.progress.claim(lease);
        if (claim.claim_state !== 'claimed' || !claim.action_payload) continue;
        const member = await this.resolveMember(
          row.target_id || execution.recovery_context.memberId || '',
          null,
        );
        const message = await this.resolveMessage(
          execution.recovery_context.channelId,
          execution.recovery_context.messageId,
        );
        const context: ActionContext = {
          guild: this.guild,
          member,
          channelId: execution.recovery_context.channelId,
          messageId: execution.recovery_context.messageId,
          message,
          supabase: this.supabase,
          guildId: this.guild.id,
          rateLimiter: this.rateLimiter(),
          automationId: execution.recovery_context.automationId,
          occurrenceId: execution.recovery_context.occurrenceId,
          variables: execution.recovery_context.variables,
        };
        const claimedEntry: ActionPlanEntry = { ...entry, action: claim.action_payload };
        const result = await executeActions(
          [claimedEntry.action],
          this.withMember(context, member),
          claimedEntry.actionIndex,
        );
        await this.progress.settle({ ...lease, entry: claimedEntry }, result);
      }
      await this.finalizeRecovered(execution.execution_id, execution.recovery_context);
    }
  }

  private buildPlan(
    actions: readonly AutomationAction[],
    context: ActionContext,
    affectedMemberIds: readonly string[],
  ): readonly ActionPlanEntry[] {
    return actions.flatMap((action, actionIndex) => {
      if (!MEMBER_TARGETED_ACTIONS.has(action.type)) {
        return [{ actionIndex, targetId: '', action }];
      }
      const targets = affectedMemberIds.length > 0
        ? affectedMemberIds
        : context.member ? [context.member.id] : [''];
      return targets.map((targetId) => ({ actionIndex, targetId, action }));
    });
  }

  private async resolveMember(targetId: string, fallback: GuildMember | null): Promise<GuildMember | null> {
    if (!targetId) return fallback;
    return this.guild.members.cache.get(targetId)
      ?? await this.guild.members.fetch(targetId).catch(() => null);
  }

  private withMember(context: ActionContext, member: GuildMember | null): ActionContext {
    return {
      ...context,
      member,
      variables: member ? {
        ...context.variables,
        user: `<@${member.id}>`,
        'user.name': member.displayName,
      } : context.variables,
    };
  }

  private async resolveMessage(channelId: string | null, messageId: string | null): Promise<Message | null> {
    if (!channelId || !messageId) return null;
    const channel = this.guild.channels.cache.get(channelId)
      ?? await this.guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !('messages' in channel)) return null;
    return channel.messages.fetch(messageId).catch(() => null);
  }

  private async finalizeRecovered(
    executionId: string,
    context: ActionProgressContext,
  ): Promise<void> {
    const settled = await this.progress.rows(executionId);
    if (settled.some((row) => row.status === 'pending' || row.status === 'executing')) return;
    if (settled.some((row) => row.status === 'manual_reconcile')) return;
    const results = settled.flatMap((row) => row.result ? [row.result] : []);
    const executionResult: ExecutionResult = {
      automationId: context.automationId,
      guildId: this.guild.id,
      triggeredBy: context.triggeredBy,
      triggerEvent: context.triggerEvent,
      conditionsPassed: true,
      actionsExecuted: results.reduce((count, result) => count + result.executed, 0),
      actionsFailed: results.reduce((count, result) => count + result.failed, 0),
      errors: results.flatMap((result) => result.errors),
      durationMs: 0,
    };
    await this.executionLogger.finalizeStrict(executionId, executionResult);
    await this.progress.complete(executionId, true);
  }
}
