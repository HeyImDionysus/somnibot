/**
 * Automation Engine — the central nervous system of SomniBot.
 * §20.1 of the architecture doc.
 *
 * Listens to platform events → matches triggers → evaluates scope/conditions → executes actions.
 */
import type { Guild, GuildMember, Message } from 'discord.js';
import { randomUUID, createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { PlatformEvent, PlatformEventType } from '@somnibot/shared';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { AutomationLoader, type LoadedAutomation } from './automation-loader.js';
import { evaluateConditions, createRegexBudget, type ConditionContext, type RegexBudget } from './condition-evaluator.js';
import {
  executeActions,
  type ActionContext,
  type AutomationAction,
} from './action-executor.js';
import type { AlertService } from '../../services/alert-service.js';
import { AUTOMATION_LIMITS , createLogger } from '@somnibot/shared';
import { AutomationRateLimiter } from './rate-limiter.js';
import { ExecutionLogger, type ExecutionResult } from './execution-logger.js';
import {
  MassActionHoldService,
  type MassActionHoldRow,
} from './mass-action-hold.js';

/**
 * A stable, uuid-shaped id derived from a durable seed. Same seed → same id, so
 * a redelivered gateway occurrence maps to the same automation occurrence id
 * (and the same automation_executions claim), which is how a redelivery is
 * recognized and skipped. Not RFC-versioned — only stability + uniqueness matter.
 */
function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const log = createLogger('AutomationEngine');
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
/**
 * The gateway side-effect events each member-targeted hold action produces,
 * keyed by action type. A depth hint is only consumable by ITS action's
 * events — an unrelated event that merely names the member must neither
 * inherit the hold depth nor spend the hint. Actions with no member-keyed
 * gateway side effect record no hint at all.
 */
const HOLD_ACTION_SIDE_EFFECT_EVENTS: Record<string, readonly string[]> = {
  give_role: ['role.gained'],
  remove_role: ['role.lost'],
  kick_member: ['member.left', 'member.kicked'],
  ban_member: ['member.left', 'member.banned'],
};

const MEMBER_CONDITION_TYPES = new Set([
  'has_role',
  'missing_role',
  'min_level',
  'max_level',
  'has_entitlement',
  'missing_entitlement',
  'is_returning_member',
  'is_new_member',
  'user_is',
]);

/**
 * Event context passed alongside platform events for automation processing.
 */
export interface AutomationEventContext {
  member: GuildMember | null;
  channelId: string | null;
  messageId: string | null;
  message: Message | null;
  /** Template variables resolved from the trigger event data */
  variables: Record<string, string>;
  /** Stable for every action spawned by this one in-memory event occurrence. */
  occurrenceId: string;
  /** Unique bulk member targets resolved by the event producer, when present. */
  affectedMemberIds: string[];
  /**
   * PR #269 review (P2): Shared regex-evaluation budget for this event.
   * One instance per platform event (created in buildEventContext) so the
   * aggregate time spent in message_matches_regex vm evaluations across ALL
   * automations triggered by the event is capped (EVENT_REGEX_BUDGET_MS).
   */
  regexBudget: RegexBudget;
}

export class AutomationEngine {
  private loader: AutomationLoader;
  private rateLimiter: AutomationRateLimiter;
  private executionLogger: ExecutionLogger;
  private massActionHolds: MassActionHoldService;
  private alertService: AlertService | null;
  private eventHandler: ((event: PlatformEvent) => Promise<void>) | null = null;
  private heldNoticeTimer: NodeJS.Timeout | null = null;
  private heldNoticeRecoveryRunning = false;
  private lastTerminalPruneAt = 0;
  /**
   * V10 Audit §2: Per-execution chain depth tracking.
   *
   * Maps a unique execution ID to the chain depth of that execution.
   * When a side-effect event arrives without `_chainDepth` (e.g., role.gained
   * from a give_role action round-tripping through Discord), the highest active
   * depth is inherited. This prevents concurrent automations from corrupting
   * a single shared field, while still guarding against infinite loops.
   */
  private _activeDepths = new Map<string, number>();
  /**
   * Member-correlated depth hints for APPROVED-HOLD side effects. A bulk hold
   * can run for minutes; publishing its depth through the guild-wide
   * _activeDepths map made EVERY undepthed event arriving during the run —
   * unrelated joins, purchases, moderation — inherit the hold's depth, and a
   * hold released near MAX_CHAIN_DEPTH dropped them at the chain guard. A
   * hint is keyed by the member the action just touched, is one-shot, and
   * expires in seconds, so only genuinely correlated side effects inherit.
   * Each member holds a QUEUE of per-action hints: several actions in one
   * hold, or two concurrent holds at different depths, each contribute their
   * own entry, consumed FIFO — a later hold must not replace an earlier
   * hold's outstanding correlation state.
   */
  private _holdMemberDepthHints = new Map<
    string,
    Array<{
      depth: number;
      events: readonly string[];
      /** For role actions: the exact role the action touched. */
      roleId: string | null;
      expiresAt: number;
    }>
  >();
  /** Mirrors the SQL lease interval in claim/renew RPCs. */
  private static readonly HOLD_EXECUTION_LEASE_MS = 2 * 60_000;
  private _execCounter = 0;
  /**
   * Reaction handlers need the full Message object, so they enter through
   * processReactionEvent before publishing the same data object on eventBus.
   * Remember that exact object once so the generic onAny route does not run the
   * same Discord occurrence a second time. A remove-then-readd uses a new data
   * object and remains a legitimate new occurrence.
   */
  private _specializedEventData = new WeakSet<object>();

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    valkey: Valkey,
    private eventBus: PlatformEventBus,
    alertService?: AlertService,
  ) {
    this.loader = new AutomationLoader(supabase, guild.id);
    this.rateLimiter = new AutomationRateLimiter(valkey);
    this.executionLogger = new ExecutionLogger(supabase);
    this.massActionHolds = new MassActionHoldService(supabase, guild);
    this.alertService = alertService ?? null;
  }

  /**
   * Set alert service after construction (for late-binding when boot order matters).
   */
  setAlertService(alertService: AlertService): void {
    this.alertService = alertService;
  }

  /**
   * Initialize: load automations, subscribe to changes, wire event bus.
   */
  async start(): Promise<void> {
    await this.loader.load();
    try {
      await this.massActionHolds.failInterruptedExecutions();
    } catch (err) {
      // Recovery visibility must not take ordinary automations offline.
      log.error('Failed to reconcile interrupted mass actions:', err);
    }
    try {
      await this.massActionHolds.pruneTerminal();
      this.lastTerminalPruneAt = Date.now();
    } catch (err) {
      log.error('Failed to prune terminal mass-action holds:', err);
    }
    this.loader.subscribe();

    // Register ordinary event handling before best-effort hold recovery. A
    // transient recovery read must never leave every automation offline.
    this.eventHandler = async (event: PlatformEvent) => {
      if (event.guildId !== this.guild.id) return;
      if (
        event.data !== null
        && typeof event.data === 'object'
        && this._specializedEventData.delete(event.data as object)
      ) {
        return;
      }
      if (event._chainDepth === undefined && this._holdMemberDepthHints.size > 0) {
        // Hold side effects are correlated by the member the action touched —
        // never by "a hold happens to be running". Platform events name that
        // member inconsistently: role/welcome events use discordId, temp
        // channels use memberId, most features use userId.
        const data = event.data as
          { memberId?: unknown; userId?: unknown; discordId?: unknown } | null;
        const candidate = typeof data?.memberId === 'string'
          ? data.memberId
          : typeof data?.userId === 'string'
            ? data.userId
            : typeof data?.discordId === 'string' ? data.discordId : null;
        if (candidate) {
          const queue = this._holdMemberDepthHints.get(candidate);
          if (queue) {
            // One hint per member-targeted ACTION, consumable only by that
            // action's own side-effect events: a hold that ran several
            // event-producing actions emits several gateway events, and the
            // first must not spend the member's entire correlation state —
            // while an unrelated event naming the member (moderation, temp
            // channels, levels) must neither inherit the depth nor spend a
            // hint the real side effect still needs.
            const now = Date.now();
            for (let index = queue.length - 1; index >= 0; index--) {
              if (queue[index]!.expiresAt < now) queue.splice(index, 1);
            }
            const eventRoleId = typeof (data as { roleId?: unknown } | null)?.roleId === 'string'
              ? (data as { roleId: string }).roleId
              : null;
            // A hint is consumable only by ITS action's event type AND, for
            // role actions, the exact role it touched — role.gained for a
            // DIFFERENT role during the window must neither inherit the depth
            // nor spend the hint the real side effect still needs.
            const match = queue.findIndex((hint) =>
              hint.events.includes(event.type)
              && (hint.roleId === null || hint.roleId === eventRoleId),
            );
            if (match !== -1) {
              event._chainDepth = queue[match]!.depth;
              queue.splice(match, 1);
            }
            if (queue.length === 0) this._holdMemberDepthHints.delete(candidate);
          }
        }
      }
      if (event._chainDepth === undefined && this._activeDepths.size > 0) {
        let maxDepth = 0;
        for (const d of this._activeDepths.values()) {
          if (d > maxDepth) maxDepth = d;
        }
        if (maxDepth > 0) event._chainDepth = maxDepth;
      }
      await this.handleEvent(event);
    };
    this.eventBus.onAny(this.eventHandler);

    try {
      await this.massActionHolds.subscribe((holdId) => {
        void this.runApprovedHold(holdId).catch((err) => {
          log.error(`Failed to run approved mass-action hold ${holdId}:`, err);
        });
      });
    } catch (err) {
      // The periodic approved-row scan remains active even if Realtime cannot
      // acknowledge. Recovery degrades to polling instead of losing approvals.
      log.error('Mass-action Realtime subscription was not ready; polling remains active:', err);
    }

    // Recovery is deliberately performed on every start. Held cards whose
    // Discord send committed before the DB acknowledgement are discovered by
    // their stable footer; approved rows are atomically claimed so multiple
    // bot instances or reconnects cannot execute the same release twice.
    const [heldResult, approvedResult] = await Promise.allSettled([
      this.massActionHolds.listHeldNeedingNotice(),
      this.massActionHolds.listApproved(),
    ]);
    const held = heldResult.status === 'fulfilled' ? heldResult.value : [];
    const approved = approvedResult.status === 'fulfilled' ? approvedResult.value : [];
    if (heldResult.status === 'rejected') {
      log.error('Failed to scan held mass actions during recovery:', heldResult.reason);
    }
    if (approvedResult.status === 'rejected') {
      log.error('Failed to scan approved mass actions during recovery:', approvedResult.reason);
    }
    await Promise.all(held.map(async (hold) => {
      try {
        const name = await this.automationName(hold.automation_id);
        await this.massActionHolds.ensureOwnerNotice(hold, name);
      } catch (err) {
        // A stale/misconfigured alert channel must not take the entire
        // automation engine offline. The durable held row remains available
        // for the next recovery attempt and on the dashboard.
        log.error(`Failed to recover mass-action notice ${hold.id}:`, err);
      }
    }));
    await Promise.all(approved.map(async (hold) => {
      try {
        await this.runApprovedHold(hold.id);
      } catch (err) {
        // An approved occurrence is independently claimed and marked failed;
        // ordinary automations must still register below.
        log.error(`Failed to recover approved mass-action hold ${hold.id}:`, err);
      }
    }));
    if (this.heldNoticeTimer) clearInterval(this.heldNoticeTimer);
    this.heldNoticeTimer = setInterval(() => {
      void this.recoverHeldNotices();
    }, 30_000);
    this.heldNoticeTimer.unref?.();

    log.info('Started and listening for events');
  }

  /**
   * Tear down: remove the Realtime subscription and the event-bus listener.
   * Called from guild teardown (destroyGuildServices) so a re-init doesn't
   * leak channels/listeners or collide with a stale subscribed channel.
   */
  stop(): void {
    this.loader.unsubscribe();
    this.massActionHolds.unsubscribe();
    if (this.heldNoticeTimer) {
      clearInterval(this.heldNoticeTimer);
      this.heldNoticeTimer = null;
    }
    if (this.eventHandler) {
      this.eventBus.off('*' as PlatformEventType, this.eventHandler);
      this.eventHandler = null;
    }
  }

  /**
   * Process a platform event against all matching automations.
   * Chain-depth guard: if an automation's action emits a new event that triggers
   * another automation, the depth counter increments. Events beyond MAX_CHAIN_DEPTH
   * are dropped to prevent infinite loops (e.g., role.gained → give_role → role.gained).
   */
  private async handleEvent(event: PlatformEvent): Promise<void> {
    // ── Chain-depth guard ──────────────────────────────────
    const depth = event._chainDepth ?? 0;
    if (depth >= AUTOMATION_LIMITS.MAX_CHAIN_DEPTH) {
      log.warn(
        `[AutomationEngine] Chain depth ${depth} exceeds max (${AUTOMATION_LIMITS.MAX_CHAIN_DEPTH}), ` +
        `dropping event "${event.type}" to prevent infinite loop`,
      );
      return;
    }

    const triggerType = event.type;
    const automations = this.loader.getForTrigger(triggerType);

    if (automations.length === 0) return;

    // Build context from the event data, carrying forward the chain depth
    const ctx = this.buildEventContext(event);

    for (const automation of automations) {
      // Run each automation independently — errors in one don't block others
      this.processAutomation(automation, event, ctx).catch((err) => {
        log.error(`Uncaught error in automation "${automation.name}":`, err);
      });
    }
  }

  /**
   * Process a single automation against an event.
   */
  private async processAutomation(
    automation: LoadedAutomation,
    event: PlatformEvent,
    ctx: AutomationEventContext,
  ): Promise<void> {
    const startTime = Date.now();
    const userId = ctx.member?.id ?? 'system';
    const actions = automation.actions as AutomationAction[];
    const hasMemberTargetedAction = actions.some((action) =>
      MEMBER_TARGETED_ACTIONS.has(action.type),
    );
    const bulkMemberIds = !ctx.member && ctx.affectedMemberIds.length > 0
      ? [...new Set(ctx.affectedMemberIds)]
      : null;
    const scopedBulkMemberIds = bulkMemberIds?.filter((memberId) =>
      this.checkUserScope(automation, memberId),
    ) ?? null;

    // 1. Scope check
    if (
      bulkMemberIds
        ? !this.checkChannelScope(automation, ctx.channelId)
          || scopedBulkMemberIds?.length === 0
        : !this.checkScope(automation, userId, ctx.channelId)
    ) {
      return; // Silently skip — scope filters are lightweight pre-checks
    }

    // 2. Rate limit check
    if (ctx.member) {
      const allowed = await this.rateLimiter.allowFire(this.guild.id, ctx.member.id);
      if (!allowed) {
        log.info(`Rate limited: ${automation.name} for user ${ctx.member.id}`);
        return;
      }

      // Custom per-automation rate limit
      if (automation.rateLimitPerUser && automation.rateLimitWindowSeconds) {
        const customAllowed = await this.rateLimiter.allowCustom(
          this.guild.id,
          automation.id,
          ctx.member.id,
          automation.rateLimitPerUser,
          automation.rateLimitWindowSeconds,
        );
        if (!customAllowed) return;
      }
    }

    // 2b. Durable occurrence claim (BEFORE any action runs). A redelivered
    //     gateway occurrence resolves to the same occurrenceId and its claim
    //     INSERT hits automation_executions_occurrence_uidx (23505) → claimed
    //     false → skip, so grant_entitlement / send_message / give_role never
    //     re-fire for the same occurrence. Events with no durable key get a
    //     random occurrenceId that never collides (unchanged behavior).
    const claim = await this.executionLogger.claim({
      automationId: automation.id,
      guildId: this.guild.id,
      triggeredBy: userId,
      triggerEvent: event.type,
      occurrenceId: ctx.occurrenceId,
    });
    if (!claim.claimed) {
      log.info(
        `Duplicate occurrence for "${automation.name}" (occurrence ${ctx.occurrenceId}) — skipping re-execution`,
      );
      return;
    }
    const claimRowId = claim.rowId;

    // 3. Evaluate conditions
    const conditionCtx: ConditionContext = {
      guild: this.guild,
      member: ctx.member,
      channelId: ctx.channelId,
      messageContent: ctx.message?.content ?? null,
      supabase: this.supabase,
      guildId: this.guild.id,
      regexBudget: ctx.regexBudget,
    };
    const conditions =
      automation.conditions as { type: string; config: Record<string, unknown> }[];
    let conditionedBulkMemberIds = scopedBulkMemberIds;
    let conditionsPassed: boolean;

    try {
      if (bulkMemberIds) {
        const eventConditions = conditions.filter((condition) =>
          !MEMBER_CONDITION_TYPES.has(condition.type),
        );
        const memberConditions = conditions.filter((condition) =>
          MEMBER_CONDITION_TYPES.has(condition.type),
        );
        const eventConditionsPassed = await evaluateConditions(eventConditions, conditionCtx);
        conditionedBulkMemberIds = [];

        if (eventConditionsPassed) {
          if (memberConditions.length === 0) {
            conditionedBulkMemberIds = scopedBulkMemberIds ?? [];
          } else {
            for (const memberId of scopedBulkMemberIds ?? []) {
              let member = this.guild.members.cache.get(memberId);
              if (!member) {
                try {
                  member = await this.guild.members.fetch(memberId);
                } catch (err) {
                  if ((err as { code?: number } | undefined)?.code === 10_007) {
                    // Discord authoritatively says the member left the guild.
                    continue;
                  }
                  throw new Error(
                    `Unable to evaluate bulk member ${memberId}; occurrence claim released for retry`,
                    { cause: err },
                  );
                }
              }
              if (!member) continue;
              const passed = await evaluateConditions(memberConditions, {
                ...conditionCtx,
                member,
              });
              if (passed) conditionedBulkMemberIds.push(memberId);
            }
          }
        }
        // Rate limits are NOT consumed here. The hold decision below must
        // see the condition-matched set without burning capacity: rejecting
        // a hold would otherwise waste the counters, and approving one later
        // would execute without rechecking them. Limits are applied at the
        // moment actions actually run — below for immediate execution, in
        // runApprovedHold for released holds.
        conditionsPassed = eventConditionsPassed && conditionedBulkMemberIds.length > 0;
      } else {
        conditionsPassed = await evaluateConditions(conditions, conditionCtx);
      }
    } catch (error) {
      await this.executionLogger.release(claimRowId);
      throw error;
    }

    if (!conditionsPassed) {
      // Finalize the claimed row as conditions-failed (no actions ran).
      await this.executionLogger.finalize(claimRowId, {
        automationId: automation.id,
        guildId: this.guild.id,
        triggeredBy: userId,
        triggerEvent: event.type,
        conditionsPassed: false,
        actionsExecuted: 0,
        actionsFailed: 0,
        errors: [],
        durationMs: Date.now() - startTime,
      });
      return;
    }

    const affectedMemberIds = hasMemberTargetedAction
      ? conditionedBulkMemberIds ?? [...new Set(ctx.affectedMemberIds)]
      : [];
    let massActionThreshold: number | null = null;
    if (affectedMemberIds.length > 1) {
      try {
        massActionThreshold = await this.massActionHolds.threshold();
      } catch (error) {
        // No action or hold exists yet, so the durable claim is safe to release
        // and a stable gateway occurrence can retry after the read recovers.
        await this.executionLogger.release(claimRowId);
        throw error;
      }
    }

    if (
      massActionThreshold !== null
      && affectedMemberIds.length > massActionThreshold
    ) {
      // A durable execution claim is mandatory for a held occurrence. Without
      // it an approval retry could not be tied back to the original occurrence,
      // so suppress safely rather than create an untracked destructive release.
      if (!claimRowId) {
        throw new Error('Mass-action occurrence could not obtain a durable execution claim');
      }
      const holdInput = {
        automationId: automation.id,
        executionId: claimRowId,
        occurrenceId: ctx.occurrenceId,
        memberIds: affectedMemberIds,
        threshold: massActionThreshold,
        triggerEvent: event.type,
        triggeredBy: userId,
        actions,
        context: {
          channelId: ctx.channelId,
          messageId: ctx.messageId,
          variables: ctx.variables,
          // The depth this execution WOULD have run at. An approved release
          // must resume the chain here, not restart it at zero — otherwise
          // mutually-triggering automations released from holds bypass
          // MAX_CHAIN_DEPTH entirely.
          chainDepth: (event._chainDepth ?? 0) + 1,
        },
      };
      let hold: MassActionHoldRow;
      try {
        ({ hold } = await this.massActionHolds.create(holdInput));
      } catch (error) {
        // The insert response can fail after commit. Re-read by the unique
        // occurrence identity before deciding whether the execution claim is
        // safe to release.
        const recovered = await this.verifyAmbiguousMassActionHold(
          automation.id,
          ctx.occurrenceId,
        );
        if (!recovered) {
          await this.executionLogger.release(claimRowId);
          throw error;
        }
        hold = recovered;
      }
      await this.massActionHolds.ensureOwnerNotice(hold, automation.name);
      log.warn(
        `Held "${automation.name}" occurrence ${ctx.occurrenceId}: ` +
        `${affectedMemberIds.length} members exceeds threshold ${massActionThreshold}`,
      );
      return;
    }

    // 4. Execute actions — V10 Audit §2: track chain depth per-execution
    //    so concurrent automations don't corrupt each other's depth.
    const depth = (event._chainDepth ?? 0) + 1;
    const execId = `${automation.id}:${++this._execCounter}`;
    this._activeDepths.set(execId, depth);

    const actionCtx: ActionContext = {
      guild: this.guild,
      member: ctx.member,
      channelId: ctx.channelId,
      messageId: ctx.messageId,
      message: ctx.message,
      supabase: this.supabase,
      guildId: this.guild.id,
      rateLimiter: this.rateLimiter,
      automationId: automation.id,
      occurrenceId: ctx.occurrenceId,
      variables: ctx.variables,
    };

    let actionResult: { executed: number; failed: number; errors: string[] };
    try {
      // Durable point of no return FIRST: rate-limit counters are consumed by
      // filterBulkRateLimits, so a marker failure after them would release
      // the claim with the counters already burned and the redelivery would
      // reject every target. Marker fails -> release with counters untouched.
      try {
        await this.executionLogger.markActionsStarted(claimRowId);
      } catch (markError) {
        await this.executionLogger.release(claimRowId);
        throw markError;
      }
      let rateLimitedMemberIds: string[];
      try {
        rateLimitedMemberIds = affectedMemberIds.length > 0
          ? await this.filterBulkRateLimits(automation, affectedMemberIds)
          : affectedMemberIds;
      } catch (limitError) {
        // Valkey failed strictly between the marker and the first action:
        // nothing external ran, so revert the marker and RELEASE — the stable
        // occurrence retries instead of being permanently suppressed by the
        // started-row reclaim guard. (Partially consumed counters may skip
        // some members on the retry; losing the whole occurrence silently
        // would be worse.) If even the revert cannot be confirmed, the claim
        // stays marked — safe, visible in history, never double-run.
        try {
          await this.executionLogger.revertActionsStarted(claimRowId);
          await this.executionLogger.release(claimRowId);
        } catch (revertError) {
          log.error('Could not revert a pre-action marker after a rate-limit fault:', revertError);
        }
        throw limitError;
      }
      if (affectedMemberIds.length > 0 && rateLimitedMemberIds.length === 0) {
        // Every target is rate-limited: nothing runs, but the conditions DID
        // match — history must say why nothing happened, not fabricate a
        // failed evaluation (approved holds record the same truth when
        // release-time limits empty their target set).
        await this.executionLogger.finalize(claimRowId, {
          automationId: automation.id,
          guildId: this.guild.id,
          triggeredBy: userId,
          triggerEvent: event.type,
          conditionsPassed: true,
          actionsExecuted: 0,
          actionsFailed: 0,
          errors: ['Every matched member was rate-limited; no action ran'],
          durationMs: Date.now() - startTime,
        });
        return;
      }
      actionResult = await this.executeResolvedActions(
        actions,
        actionCtx,
        rateLimitedMemberIds,
      );
    } finally {
      this._activeDepths.delete(execId);
    }
    const { executed, failed, errors } = actionResult;

    // 5. Log execution
    const result: ExecutionResult = {
      automationId: automation.id,
      guildId: this.guild.id,
      triggeredBy: userId,
      triggerEvent: event.type,
      conditionsPassed: true,
      actionsExecuted: executed,
      actionsFailed: failed,
      errors,
      durationMs: Date.now() - startTime,
    };

    await this.executionLogger.finalize(claimRowId, result);

    // V53 Phase 2: Track success/failure for alert service
    if (this.alertService) {
      if (failed > 0) {
        await this.alertService.recordFailure(
          automation.id,
          automation.name,
          errors.join('; '),
        );
      } else {
        await this.alertService.recordSuccess(automation.id);
      }
    }

    if (errors.length > 0) {
      log.warn(`"${automation.name}" completed with ${failed} error(s):`, errors);
    } else {
      log.info(`"${automation.name}" executed ${executed} action(s) in ${result.durationMs}ms`);
    }

    // Emit audit event so AuditService can log automation executions
    this.eventBus.emit('automation.executed', this.guild.id, {
      automationId: automation.id,
      automationName: automation.name,
      trigger: event.type,
      actionsExecuted: executed,
      actionsFailed: failed,
      success: failed === 0,
      duration: result.durationMs,
    });
  }

  /**
   * Check scope filters (§20.2.1).
   */
  private checkScope(
    automation: LoadedAutomation,
    userId: string,
    channelId: string | null,
  ): boolean {
    return this.checkUserScope(automation, userId)
      && this.checkChannelScope(automation, channelId);
  }

  private checkUserScope(automation: LoadedAutomation, userId: string): boolean {
    // Target user filter
    if (automation.scopeTargetUserIds.length > 0) {
      if (!automation.scopeTargetUserIds.includes(userId)) return false;
    }
    // Exclude user filter
    if (automation.scopeExcludeUserIds.length > 0) {
      if (automation.scopeExcludeUserIds.includes(userId)) return false;
    }
    return true;
  }

  private checkChannelScope(automation: LoadedAutomation, channelId: string | null): boolean {
    // Target channel filter
    if (automation.scopeTargetChannelIds.length > 0 && channelId) {
      if (!automation.scopeTargetChannelIds.includes(channelId)) return false;
    }
    // Exclude channel filter
    if (automation.scopeExcludeChannelIds.length > 0 && channelId) {
      if (automation.scopeExcludeChannelIds.includes(channelId)) return false;
    }
    return true;
  }

  /**
   * Build the event context from platform event data.
   * Maps event data to member, channel, message, and template variables.
   */
  /**
   * A durable occurrence id for the event: a STABLE id derived from the event's
   * durable Discord-native identity when one exists (so a gateway redelivery of
   * the same occurrence resolves to the same id and is deduped), otherwise a
   * fresh random id (events with no reliably-durable per-occurrence key are never
   * deduped — unchanged behavior, and no false-dedup of legitimately repeatable
   * events like member.joined / role.gained / voice.joined).
   */
  private occurrenceIdFor(event: PlatformEvent, data: Record<string, unknown>): string {
    const key = this.durableOccurrenceKey(event, data);
    return key ? stableUuid(key) : randomUUID();
  }

  private durableOccurrenceKey(event: PlatformEvent, data: Record<string, unknown>): string | null {
    const g = event.guildId;
    const t = event.type;
    const s = (v: unknown): string | null =>
      typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null;
    switch (t) {
      case 'message.sent': {
        // A message id is unique and immutable — a redelivery repeats it, and it
        // can never be legitimately re-sent, so it's a safe durable key.
        const m = s(data.messageId);
        return m ? `${t}:${g}:${m}` : null;
      }
      // NOTE: reaction.added deliberately has NO durable key. Discord reactions
      // carry no per-event id, and a remove-then-readd of the same (message,
      // user, emoji) tuple is a LEGITIMATE new occurrence — indistinguishable
      // from a gateway redelivery by tuple alone. Keying on the tuple would
      // wrongly dedupe the re-add, so reaction.added keeps a random id.
      case 'purchase.completed': {
        const o = s(data.orderId) ?? s(data.orderNumber);
        return o ? `${t}:${g}:${o}` : null;
      }
      case 'ticket.opened':
      case 'ticket.closed': {
        const k = s(data.ticketId) ?? s(data.ticketNumber);
        return k ? `${t}:${g}:${k}` : null;
      }
      case 'giveaway.ended': {
        const k = s(data.giveawayId) ?? s(data.messageId);
        return k ? `${t}:${g}:${k}` : null;
      }
      // level.up deliberately has NO durable identity: user+level is not a
      // lifetime-unique occurrence — /xp reset|remove|set can lower a member
      // below a milestone they then legitimately re-cross, and a finalized
      // executions row behind the permanent unique index would suppress every
      // automation for that milestone forever. The producer only emits on an
      // actual stored-level transition, so gateway redelivery cannot re-emit
      // it; the in-memory occurrence id is the correct dedupe scope.
      case 'member.verified': {
        const u = s(data.discordId);
        return u ? `${t}:${g}:${u}` : null;
      }
      case 'infraction.created': {
        const k = s(data.infractionId);
        return k ? `${t}:${g}:${k}` : null;
      }
      default:
        return null;
    }
  }

  private buildEventContext(event: PlatformEvent): AutomationEventContext {
    const data = event.data as Record<string, unknown>;
    const variables: Record<string, string> = {};
    let member: GuildMember | null = null;
    let channelId: string | null = null;
    let messageId: string | null = null;

    // Canonical event payloads do not all use the same member field. Resolve
    // only the documented field for each exceptional trigger; accepting a
    // synthetic `discordId` here previously let tests hide broken production
    // ticket and infraction context.
    const discordId = event.type === 'ticket.opened' || event.type === 'ticket.closed'
      ? data.userDiscordId as string | undefined
      : event.type === 'infraction.created'
        ? data.userId as string | undefined
        : data.discordId as string | undefined;
    if (discordId) {
      member = this.guild.members.cache.get(discordId) ?? null;
      variables['user'] = member ? `<@${discordId}>` : discordId;
      variables['user.name'] = member?.displayName ?? (data.username as string) ?? discordId;
    }

    // Resolve channel
    if (data.channelId) {
      channelId = data.channelId as string;
      const channel = this.guild.channels.cache.get(channelId);
      variables['channel'] = channel ? `<#${channelId}>` : channelId;
    }

    // Resolve message
    if (data.messageId) {
      messageId = data.messageId as string;
    }

    // Trigger-specific variables
    switch (event.type) {
      case 'member.joined':
        variables['memberCount'] = String(this.guild.memberCount);
        variables['returning'] = String(data.isReturning ?? false);
        break;
      case 'member.left':
        variables['memberCount'] = String(this.guild.memberCount);
        variables['duration'] = ''; // Could calculate from member data
        break;
      case 'member.verified':
        variables['memberNumber'] = String(data.memberNumber ?? '');
        break;
      case 'message.sent':
        variables['content'] = (data.content as string) ?? '';
        variables['message'] = (data.content as string) ?? '';
        break;
      case 'role.gained':
      case 'role.lost':
        variables['role'] = data.roleId ? `<@&${data.roleId}>` : '';
        variables['role.name'] = (data.roleName as string) ?? '';
        variables['source'] = (data.source as string) ?? '';
        break;
      case 'level.up':
        variables['oldLevel'] = String(data.previousLevel ?? data.oldLevel ?? '');
        variables['newLevel'] = String(data.newLevel ?? '');
        break;
      case 'purchase.completed':
        variables['product'] = (data.productName as string) ?? '';
        variables['order'] = (data.orderNumber as string) ?? '';
        variables['amount'] = String(data.amount ?? '');
        break;
      case 'subscription.activated':
      case 'subscription.lapsed':
      case 'subscription.expired':
        variables['plan'] = (data.planId as string) ?? '';
        break;
      case 'ticket.opened':
      case 'ticket.closed':
        variables['ticket'] = `#${data.ticketNumber ?? ''}`;
        variables['category'] = '';
        break;
      case 'giveaway.ended':
        variables['giveaway'] = (data.title as string) ?? '';
        variables['winners'] = Array.isArray(data.winnerIds)
          ? (data.winnerIds as string[]).map((id) => `<@${id}>`).join(', ')
          : '';
        break;
      case 'button.clicked':
        variables['buttonId'] = (data.buttonId as string) ?? '';
        break;
      case 'reaction.added':
        variables['emoji'] = (data.emoji as string) ?? '';
        break;
      case 'voice.joined':
      case 'voice.left':
        variables['channel'] = data.channelName ? (data.channelName as string) : (channelId ? `<#${channelId}>` : '');
        break;
      case 'infraction.created':
        variables['type'] = (data.type as string) ?? '';
        variables['reason'] = (data.reason as string) ?? '';
        variables['count'] = String(data.totalInfractions ?? '');
        break;
    }

    return {
      member,
      channelId,
      messageId,
      message: null, // Message object needs to be attached separately for message-based triggers
      variables,
      occurrenceId: this.occurrenceIdFor(event, data),
      affectedMemberIds: (
        Array.isArray(event.affectedMemberIds)
          ? event.affectedMemberIds
          : Array.isArray(data.affectedMemberIds)
            ? data.affectedMemberIds
            : Array.isArray(data.winnerIds)
              ? data.winnerIds
              : Array.isArray(data.memberIds)
                ? data.memberIds
                : []
      ).filter(
        (id): id is string => typeof id === 'string' && /^\d{17,20}$/.test(id),
      ),
      // One budget per event: buildEventContext is called exactly once per
      // event (handleEvent / processMessageEvent / processReactionEvent), so
      // every automation processed for this event draws from the same budget.
      regexBudget: createRegexBudget(),
    };
  }

  /**
   * Process a message-based event with the full Message object.
   * Called directly from the event handler for message.sent triggers.
   */
  async processMessageEvent(event: PlatformEvent, message: Message): Promise<void> {
    const automations = this.loader.getForTrigger('message.sent');
    if (automations.length === 0) return;

    const ctx = this.buildEventContext(event);
    ctx.message = message;
    ctx.messageId = message.id;

    for (const automation of automations) {
      this.processAutomation(automation, event, ctx).catch((err) => {
        log.error(`Uncaught error in message automation "${automation.name}":`, err);
      });
    }
  }

  /**
   * Process a reaction event with message reference.
   */
  async processReactionEvent(event: PlatformEvent, message: Message): Promise<void> {
    if (event.data !== null && typeof event.data === 'object') {
      this._specializedEventData.add(event.data as object);
    }
    const automations = this.loader.getForTrigger('reaction.added');
    if (automations.length === 0) return;

    const ctx = this.buildEventContext(event);
    ctx.message = message;
    ctx.messageId = message.id;

    for (const automation of automations) {
      this.processAutomation(automation, event, ctx).catch((err) => {
        log.error(`Uncaught error in reaction automation "${automation.name}":`, err);
      });
    }
  }

  private async automationName(automationId: string): Promise<string> {
    const { data } = await this.supabase
      .from('automations')
      .select('name')
      .eq('id', automationId)
      .eq('guild_id', this.guild.id)
      .maybeSingle();
    return (data?.name as string | undefined) ?? automationId;
  }

  private async recoverHeldNotices(): Promise<void> {
    if (this.heldNoticeRecoveryRunning) return;
    this.heldNoticeRecoveryRunning = true;
    try {
      // A replacement process may start while another worker's lease is still
      // live, then inherit the row only after that worker crashes. Reconcile
      // expired leases on every scan so those rows cannot remain executing
      // forever after the one-time startup pass.
      try {
        await this.massActionHolds.failInterruptedExecutions();
      } catch (err) {
        log.error('Failed to reconcile expired mass-action leases:', err);
      }
      if (Date.now() - this.lastTerminalPruneAt >= 6 * 60 * 60 * 1_000) {
        try {
          await this.massActionHolds.pruneTerminal();
          this.lastTerminalPruneAt = Date.now();
        } catch (err) {
          log.error('Failed to prune terminal mass-action holds:', err);
        }
      }
      this.pruneExpiredDepthHints();
      const held = await this.massActionHolds.listHeldNeedingNotice();
      await Promise.all(held.map(async (hold) => {
        try {
          const name = await this.automationName(hold.automation_id);
          await this.massActionHolds.ensureOwnerNotice(hold, name);
        } catch (err) {
          log.error(`Failed to retry mass-action notice ${hold.id}:`, err);
        }
      }));
    } catch (err) {
      log.error('Failed to scan held mass actions for notice retry:', err);
    } finally {
      this.heldNoticeRecoveryRunning = false;
    }
  }

  /**
   * Drop expired depth-hint entries. Recording and consumption both prune
   * lazily, but a large FAILED hold whose members never emit another event
   * would otherwise retain its entire target set until the next hold runs.
   */
  private pruneExpiredDepthHints(): void {
    const now = Date.now();
    for (const [key, queue] of this._holdMemberDepthHints) {
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index]!.expiresAt < now) queue.splice(index, 1);
      }
      if (queue.length === 0) this._holdMemberDepthHints.delete(key);
    }
  }

  private async filterBulkRateLimits(
    automation: LoadedAutomation,
    memberIds: string[],
  ): Promise<string[]> {
    const allowedIds: string[] = [];
    for (const memberId of memberIds) {
      const allowed = await this.rateLimiter.allowFire(this.guild.id, memberId);
      if (!allowed) {
        log.info(`Rate limited: ${automation.name} for bulk user ${memberId}`);
        continue;
      }
      if (automation.rateLimitPerUser && automation.rateLimitWindowSeconds) {
        const customAllowed = await this.rateLimiter.allowCustom(
          this.guild.id,
          automation.id,
          memberId,
          automation.rateLimitPerUser,
          automation.rateLimitWindowSeconds,
        );
        if (!customAllowed) continue;
      }
      allowedIds.push(memberId);
    }
    return allowedIds;
  }

  /**
   * Member-targeted actions are fanned out over the resolved target set while
   * channel/message actions execute once. The guard runs before this method, so
   * no target can be touched before an oversized set is durably held.
   */
  private async executeResolvedActions(
    actions: AutomationAction[],
    baseContext: ActionContext,
    affectedMemberIds: string[],
    assertLease?: () => void,
    onMemberAction?: (
      memberId: string,
      actionType: string,
      actionRoleId: string | null,
    ) => (() => void) | undefined,
    progress?: { executed: number; failed: number; errors: string[] },
  ): Promise<{ executed: number; failed: number; errors: string[] }> {
    if (affectedMemberIds.length === 0) {
      return executeActions(actions, baseContext);
    }

    const total = { executed: 0, failed: 0, errors: [] as string[] };
    const memberCache = new Map<string, GuildMember | null>();
    const add = (result: { executed: number; failed: number; errors: string[] }) => {
      total.executed += result.executed;
      total.failed += result.failed;
      total.errors.push(...result.errors);
      if (progress) {
        // Mirror progress OUTWARD as it happens: a mid-run throw (lease
        // expiry between members) must not erase how much of a destructive
        // bulk action already reached Discord.
        progress.executed = total.executed;
        progress.failed = total.failed;
        progress.errors = [...total.errors];
      }
    };

    for (const [actionIndex, action] of actions.entries()) {
      assertLease?.();
      if (!MEMBER_TARGETED_ACTIONS.has(action.type)) {
        add(await executeActions([action], baseContext, actionIndex));
        continue;
      }
      for (const memberId of affectedMemberIds) {
        assertLease?.();
        let member = memberCache.get(memberId);
        if (member === undefined) {
          member = this.guild.members.cache.get(memberId)
            ?? await this.guild.members.fetch(memberId).catch(() => null);
          memberCache.set(memberId, member);
        }
        if (!member) {
          total.failed += 1;
          total.errors.push(`member ${memberId}: target no longer belongs to the guild`);
          continue;
        }
        // PROVISIONAL hint, registered before the Discord call: give/remove
        // role sleep AFTER their REST operation, so the gateway side effect
        // can arrive before executeActions returns — a post-success recording
        // would miss it and the event would enter as a root. The returned
        // rollback removes the exact entry when the action fails, so no
        // unrelated event can inherit a failed hold's depth either.
        const rollbackHint = onMemberAction?.(
          memberId,
          action.type,
          typeof (action.config as { role_id?: unknown } | undefined)?.role_id === 'string'
            ? (action.config as { role_id: string }).role_id
            : null,
        );
        const memberResult = await executeActions([action], {
          ...baseContext,
          member,
          variables: {
            ...baseContext.variables,
            user: `<@${member.id}>`,
            'user.name': member.displayName,
          },
        }, actionIndex);
        add(memberResult);
        if (!(memberResult.executed > 0 && memberResult.failed === 0)) {
          rollbackHint?.();
        }
      }
    }
    return total;
  }

  private async runApprovedHold(holdId: string): Promise<void> {
    const hold = await this.massActionHolds.claimApproved(holdId);
    if (!hold) return;
    const startTime = Date.now();
    let leaseError: Error | null = null;
    let renewalInFlight = false;
    // Mirrors bulk progress OUTWARD so the interruption path can report how
    // much of a destructive run already reached Discord instead of zeros.
    const heldProgress = { executed: 0, failed: 0, errors: [] as string[] };
    // The deadline this worker has actually been ACKNOWLEDGED to hold. A
    // renewal that hangs or stays in flight past expiry leaves leaseError
    // null, so error-only checking let the worker keep running member actions
    // while the periodic recovery path marked the same hold failed for its
    // expired lease. The deadline only advances on a confirmed renewal.
    let leaseDeadlineMs = startTime + AutomationEngine.HOLD_EXECUTION_LEASE_MS;
    const renewLease = async () => {
      if (renewalInFlight || leaseError) return;
      renewalInFlight = true;
      try {
        await this.massActionHolds.renewExecutionLease(hold.id);
        leaseDeadlineMs = Date.now() + AutomationEngine.HOLD_EXECUTION_LEASE_MS;
      } catch (error) {
        leaseError = error instanceof Error ? error : new Error(String(error));
      } finally {
        renewalInFlight = false;
      }
    };
    const leaseTimer = setInterval(() => {
      void renewLease();
    }, 30_000);
    leaseTimer.unref?.();
    const assertLease = () => {
      if (leaseError) throw leaseError;
      if (Date.now() >= leaseDeadlineMs) {
        throw new Error('Mass-action execution lease expired before renewal was acknowledged');
      }
    };
    try {
      const context: ActionContext = {
        guild: this.guild,
        member: null,
        channelId: hold.context_snapshot.channelId,
        messageId: hold.context_snapshot.messageId,
        // A Discord Message object is intentionally not persisted. Bulk
        // member-targeted actions remain fully resumable; any one-shot message
        // action receives the same explicit missing-context failure as a normal
        // restart would instead of fabricating a stale Discord object.
        message: null,
        supabase: this.supabase,
        guildId: this.guild.id,
        rateLimiter: this.rateLimiter,
        automationId: hold.automation_id,
        occurrenceId: hold.occurrence_id,
        variables: hold.context_snapshot.variables,
      };
      // Resume the persisted chain depth for side effects of the approved
      // actions — correlated per MEMBER, not published guild-wide: a long bulk
      // run must never tax unrelated events with the hold's depth.
      const holdDepth = typeof hold.context_snapshot.chainDepth === 'number'
        ? hold.context_snapshot.chainDepth
        : 1;
      const recordMemberDepthHint = (
        memberId: string,
        actionType: string,
        actionRoleId: string | null,
      ): (() => void) | undefined => {
        const events = HOLD_ACTION_SIDE_EFFECT_EVENTS[actionType];
        if (!events || events.length === 0) return undefined;
        const roleId = actionType === 'give_role' || actionType === 'remove_role'
          ? actionRoleId
          : null;
        // A role action whose target role is unknown cannot be correlated
        // precisely; recording a wildcard hint would let an unrelated role
        // event inherit the depth, so record nothing and accept that the
        // side effect enters as a root.
        if ((actionType === 'give_role' || actionType === 'remove_role') && roleId === null) {
          return undefined;
        }
        const now = Date.now();
        for (const [key, queue] of this._holdMemberDepthHints) {
          for (let index = queue.length - 1; index >= 0; index--) {
            if (queue[index]!.expiresAt < now) queue.splice(index, 1);
          }
          if (queue.length === 0) this._holdMemberDepthHints.delete(key);
        }
        const queue = this._holdMemberDepthHints.get(memberId) ?? [];
        const entry = { depth: holdDepth, events, roleId, expiresAt: now + 10_000 };
        queue.push(entry);
        this._holdMemberDepthHints.set(memberId, queue);
        // Identity-based rollback: a consumed or already-rolled-back entry is
        // simply absent, so this never removes another action's hint.
        return () => {
          const current = this._holdMemberDepthHints.get(memberId);
          if (!current) return;
          const index = current.indexOf(entry);
          if (index !== -1) current.splice(index, 1);
          if (current.length === 0) this._holdMemberDepthHints.delete(memberId);
        };
      };
      // Rate limits are consumed when actions actually RUN: the hold stored
      // condition-matched targets without touching counters (a rejected hold
      // must not burn capacity), so an approval landing later still honours
      // limits filled by newer activity in the meantime.
      const loadedAutomation = this.loader
        .getForTrigger(hold.trigger_event)
        .find((candidate) => candidate.id === hold.automation_id);
      const heldTargets = await this.filterBulkRateLimits(
        loadedAutomation ?? ({
          id: hold.automation_id,
          name: 'approved mass action',
          rateLimitPerUser: 0,
          rateLimitWindowSeconds: 0,
        } as LoadedAutomation),
        hold.member_ids,
      );
      // Same durable point of no return as the immediate path.
      await this.executionLogger.markActionsStarted(hold.execution_id);
      let result: { executed: number; failed: number; errors: string[] };
      try {
        result = await this.executeResolvedActions(
          heldTargets.length === 0
            // Every held target is rate-limited at release time: member
            // actions are skipped entirely; the approved non-member actions
            // still run once.
            ? hold.action_snapshot.filter(
                (action) => !MEMBER_TARGETED_ACTIONS.has(action.type),
              )
            : hold.action_snapshot,
          context,
          heldTargets,
          assertLease,
          recordMemberDepthHint,
          heldProgress,
        );
      } finally {
        // One-shot hints expire on their own; nothing guild-wide to unwind.
      }
      await renewLease();
      assertLease();
      const executionResult: ExecutionResult = {
        automationId: hold.automation_id,
        guildId: this.guild.id,
        triggeredBy: hold.triggered_by,
        triggerEvent: hold.trigger_event,
        conditionsPassed: true,
        actionsExecuted: result.executed,
        actionsFailed: result.failed,
        errors: result.errors,
        durationMs: Date.now() - startTime,
      };
      await this.executionLogger.finalize(hold.execution_id, executionResult);
      const automationName = await this.automationName(hold.automation_id);
      if (result.failed > 0) {
        const failureMessage = result.errors.join('; ') || `${result.failed} action(s) failed`;
        await this.massActionHolds.fail(hold.id, failureMessage);
        if (this.alertService) {
          await this.alertService.recordFailure(
            hold.automation_id,
            automationName,
            failureMessage,
          );
        }
      } else {
        await this.massActionHolds.complete(hold.id);
      }
      this.eventBus.emit('automation.executed', this.guild.id, {
        automationId: hold.automation_id,
        automationName,
        trigger: hold.trigger_event,
        actionsExecuted: result.executed,
        actionsFailed: result.failed,
        success: result.failed === 0,
        duration: executionResult.durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // History must not read 'Conditions not met' for an APPROVED hold that
      // failed mid-flight — and it must show the PROGRESS that reached
      // Discord, not zeros. STRICT ordering: finalize first; only a
      // successful finalize may terminalize the hold. If finalization fails,
      // the hold stays 'executing' so the expired-lease recovery RPC later
      // fails it AND finalizes the execution in one transaction — a terminal
      // hold with defaulted history can never exist.
      let interruptedFinalized = false;
      try {
        await this.executionLogger.finalizeStrict(hold.execution_id, {
          automationId: hold.automation_id,
          guildId: this.guild.id,
          triggeredBy: hold.triggered_by,
          triggerEvent: hold.trigger_event,
          conditionsPassed: true,
          actionsExecuted: heldProgress.executed,
          actionsFailed: heldProgress.failed,
          errors: [
            ...heldProgress.errors,
            `Approved mass action was interrupted: ${message}`,
          ],
          durationMs: Date.now() - startTime,
        });
        interruptedFinalized = true;
      } catch (finalizeError) {
        log.error(
          `Failed to finalize interrupted execution for hold ${hold.id}; `
          + 'leaving it executing for lease-expiry recovery:',
          finalizeError,
        );
      }
      if (interruptedFinalized) {
        await this.massActionHolds.fail(hold.id, message);
      }
      throw err;
    } finally {
      clearInterval(leaseTimer);
    }
  }

  /**
   * An insert can commit even when its response is lost. Keep the execution
   * claim and retry the unique occurrence read until the database gives an
   * authoritative present/absent answer; otherwise a transient verification
   * outage could strand a claim with no recoverable hold.
   */
  private async verifyAmbiguousMassActionHold(
    automationId: string,
    occurrenceId: string,
  ): Promise<MassActionHoldRow | null> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.massActionHolds.findByOccurrence(automationId, occurrenceId);
      } catch (error) {
        attempt += 1;
        const delayMs = Math.min(250 * 2 ** Math.min(attempt - 1, 5), 5_000);
        log.warn('Mass-action hold verification is unavailable; retaining claim and retrying', {
          automationId,
          occurrenceId,
          attempt,
          delayMs,
          error: String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
