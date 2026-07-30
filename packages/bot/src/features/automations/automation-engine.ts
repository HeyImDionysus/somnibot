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
    this.loader.subscribe();
    this.massActionHolds.subscribe((holdId) => {
      void this.runApprovedHold(holdId).catch((err) => {
        log.error(`Failed to run approved mass-action hold ${holdId}:`, err);
      });
    });

    // Recovery is deliberately performed on every start. Held cards whose
    // Discord send committed before the DB acknowledgement are discovered by
    // their stable footer; approved rows are atomically claimed so multiple
    // bot instances or reconnects cannot execute the same release twice.
    const [held, approved] = await Promise.all([
      this.massActionHolds.listHeld(),
      this.massActionHolds.listApproved(),
    ]);
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

    // Listen to ALL platform events and check for matching automations.
    // V10 Audit §2: If an event arrives without _chainDepth but there are
    // active automation executions, inherit the highest active depth.
    // This handles side-effect events (e.g., role.gained from give_role)
    // that round-trip through Discord and lose async context.
    this.eventHandler = async (event: PlatformEvent) => {
      if (event.guildId !== this.guild.id) return;
      if (
        event.data !== null
        && typeof event.data === 'object'
        && this._specializedEventData.delete(event.data as object)
      ) {
        return;
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

    // 1. Scope check
    if (!this.checkScope(automation, userId, ctx.channelId)) {
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

    const conditionsPassed = await evaluateConditions(
      automation.conditions as { type: string; config: Record<string, unknown> }[],
      conditionCtx,
    );

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

    const actions = automation.actions as AutomationAction[];
    const hasMemberTargetedAction = actions.some((action) =>
      MEMBER_TARGETED_ACTIONS.has(action.type),
    );
    const affectedMemberIds = hasMemberTargetedAction
      ? [...new Set(ctx.affectedMemberIds)]
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
      const { hold } = await this.massActionHolds.create({
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
        },
      });
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
      actionResult = await this.executeResolvedActions(actions, actionCtx, affectedMemberIds);
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
    // Target user filter
    if (automation.scopeTargetUserIds.length > 0) {
      if (!automation.scopeTargetUserIds.includes(userId)) return false;
    }
    // Exclude user filter
    if (automation.scopeExcludeUserIds.length > 0) {
      if (automation.scopeExcludeUserIds.includes(userId)) return false;
    }
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
      case 'level.up': {
        const u = s(data.discordId);
        const lvl = s(data.newLevel);
        return u && lvl ? `${t}:${g}:${u}:${lvl}` : null;
      }
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

  /**
   * Member-targeted actions are fanned out over the resolved target set while
   * channel/message actions execute once. The guard runs before this method, so
   * no target can be touched before an oversized set is durably held.
   */
  private async executeResolvedActions(
    actions: AutomationAction[],
    baseContext: ActionContext,
    affectedMemberIds: string[],
  ): Promise<{ executed: number; failed: number; errors: string[] }> {
    if (affectedMemberIds.length === 0) {
      return executeActions(actions, baseContext);
    }

    const onceActions = actions.filter((action) => !MEMBER_TARGETED_ACTIONS.has(action.type));
    const perMemberActions = actions.filter((action) => MEMBER_TARGETED_ACTIONS.has(action.type));
    const total = { executed: 0, failed: 0, errors: [] as string[] };
    const add = (result: { executed: number; failed: number; errors: string[] }) => {
      total.executed += result.executed;
      total.failed += result.failed;
      total.errors.push(...result.errors);
    };

    if (onceActions.length > 0) add(await executeActions(onceActions, baseContext));
    for (const memberId of affectedMemberIds) {
      const member = this.guild.members.cache.get(memberId)
        ?? await this.guild.members.fetch(memberId).catch(() => null);
      if (!member) {
        total.failed += perMemberActions.length;
        total.errors.push(`member ${memberId}: target no longer belongs to the guild`);
        continue;
      }
      add(await executeActions(perMemberActions, {
        ...baseContext,
        member,
        variables: {
          ...baseContext.variables,
          user: `<@${member.id}>`,
          'user.name': member.displayName,
        },
      }));
    }
    return total;
  }

  private async runApprovedHold(holdId: string): Promise<void> {
    const hold = await this.massActionHolds.claimApproved(holdId);
    if (!hold) return;
    const startTime = Date.now();
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
      const result = await this.executeResolvedActions(
        hold.action_snapshot,
        context,
        hold.member_ids,
      );
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
      await this.massActionHolds.complete(hold.id);
      this.eventBus.emit('automation.executed', this.guild.id, {
        automationId: hold.automation_id,
        automationName: await this.automationName(hold.automation_id),
        trigger: hold.trigger_event,
        actionsExecuted: result.executed,
        actionsFailed: result.failed,
        success: result.failed === 0,
        duration: executionResult.durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.massActionHolds.fail(hold.id, message);
      throw err;
    }
  }
}
