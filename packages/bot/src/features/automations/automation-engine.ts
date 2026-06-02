/**
 * Automation Engine — the central nervous system of SomniBot.
 * §20.1 of the architecture doc.
 *
 * Listens to platform events → matches triggers → evaluates scope/conditions → executes actions.
 */
import type { Guild, GuildMember, Message } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { PlatformEvent } from '@somnibot/shared';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { AutomationLoader, type LoadedAutomation } from './automation-loader.js';
import { evaluateConditions, type ConditionContext } from './condition-evaluator.js';
import { executeActions, type ActionContext } from './action-executor.js';
import type { AlertService } from '../../services/alert-service.js';
import { AUTOMATION_LIMITS , createLogger } from '@somnibot/shared';
import { AutomationRateLimiter } from './rate-limiter.js';
import { ExecutionLogger, type ExecutionResult } from './execution-logger.js';

const log = createLogger('AutomationEngine');

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
}

export class AutomationEngine {
  private loader: AutomationLoader;
  private rateLimiter: AutomationRateLimiter;
  private executionLogger: ExecutionLogger;
  private alertService: AlertService | null;
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
    this.loader.subscribe();

    // Listen to ALL platform events and check for matching automations.
    // V10 Audit §2: If an event arrives without _chainDepth but there are
    // active automation executions, inherit the highest active depth.
    // This handles side-effect events (e.g., role.gained from give_role)
    // that round-trip through Discord and lose async context.
    this.eventBus.onAny(async (event: PlatformEvent) => {
      if (event.guildId !== this.guild.id) return;
      if (event._chainDepth === undefined && this._activeDepths.size > 0) {
        let maxDepth = 0;
        for (const d of this._activeDepths.values()) {
          if (d > maxDepth) maxDepth = d;
        }
        if (maxDepth > 0) event._chainDepth = maxDepth;
      }
      await this.handleEvent(event);
    });

    log.info('Started and listening for events');
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

    // 3. Evaluate conditions
    const conditionCtx: ConditionContext = {
      guild: this.guild,
      member: ctx.member,
      channelId: ctx.channelId,
      messageContent: ctx.message?.content ?? null,
      supabase: this.supabase,
      guildId: this.guild.id,
    };

    const conditionsPassed = await evaluateConditions(
      automation.conditions as { type: string; config: Record<string, unknown> }[],
      conditionCtx,
    );

    if (!conditionsPassed) {
      // Log the execution as conditions-failed
      await this.executionLogger.log({
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
      variables: ctx.variables,
    };

    let actionResult: { executed: number; failed: number; errors: string[] };
    try {
      actionResult = await executeActions(
        automation.actions as { type: string; config: Record<string, unknown> }[],
        actionCtx,
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

    await this.executionLogger.log(result);

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
  private buildEventContext(event: PlatformEvent): AutomationEventContext {
    const data = event.data as Record<string, unknown>;
    const variables: Record<string, string> = {};
    let member: GuildMember | null = null;
    let channelId: string | null = null;
    let messageId: string | null = null;

    // Resolve member from discordId
    const discordId = data.discordId as string | undefined;
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
}
