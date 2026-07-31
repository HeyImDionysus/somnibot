/**
 * AutomationEngine — Coverage tests
 *
 * Tests the core engine: start, handleEvent, processAutomation,
 * scope checks, buildEventContext for all event types, chain depth guard,
 * processMessageEvent, processReactionEvent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformEventMap } from '@somnibot/shared';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setColor(c: number) { this.data.color = c; return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
  },
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  AUTOMATION_LIMITS: {
    MAX_CHAIN_DEPTH: 5,
  },
}));

// We need to mock the sub-modules that AutomationEngine imports
const mockLoad = vi.fn().mockResolvedValue(undefined);
const mockSubscribe = vi.fn();
const mockGetForTrigger = vi.fn().mockReturnValue([]);
vi.mock('../features/automations/automation-loader.js', () => ({
  AutomationLoader: class {
    load = mockLoad;
    subscribe = mockSubscribe;
    getForTrigger = mockGetForTrigger;
  },
}));

const mockEvaluateConditions = vi.fn().mockResolvedValue(true);
vi.mock('../features/automations/condition-evaluator.js', () => ({
  evaluateConditions: (...args: unknown[]) => mockEvaluateConditions(...args),
  // PR #269: engine creates one shared regex budget per event
  createRegexBudget: () => ({ remainingMs: 500, exhaustedLogged: false }),
}));

const mockExecuteActions = vi.fn().mockResolvedValue({ executed: 1, failed: 0, errors: [] });
vi.mock('../features/automations/action-executor.js', () => ({
  executeActions: (...args: unknown[]) => mockExecuteActions(...args),
}));

const mockAllowFire = vi.fn().mockResolvedValue(true);
const mockAllowCustom = vi.fn().mockResolvedValue(true);
vi.mock('../features/automations/rate-limiter.js', () => ({
  AutomationRateLimiter: class {
    allowFire = mockAllowFire;
    allowCustom = mockAllowCustom;
  },
}));

const mockLogExecution = vi.fn().mockResolvedValue(undefined);
// The engine now stakes a durable occurrence claim before running, then
// finalizes it with the result (replacing the old single log() insert).
const mockClaim = vi.fn().mockResolvedValue({ claimed: true, rowId: 'exec-1' });
const mockFinalize = vi.fn().mockResolvedValue(undefined);
const mockRelease = vi.fn().mockResolvedValue(undefined);
vi.mock('../features/automations/execution-logger.js', () => ({
  ExecutionLogger: class {
    log = mockLogExecution;
    claim = mockClaim;
    finalize = mockFinalize;
    release = mockRelease;
  },
}));

const mockMassHoldCreate = vi.fn();
const mockMassHoldNotice = vi.fn().mockResolvedValue(undefined);
const mockMassThreshold = vi.fn().mockResolvedValue(25);
const mockMassClaimApproved = vi.fn().mockResolvedValue(null);
const mockMassComplete = vi.fn().mockResolvedValue(undefined);
const mockMassFail = vi.fn().mockResolvedValue(undefined);
const mockMassListHeld = vi.fn().mockResolvedValue([]);
const mockMassListApproved = vi.fn().mockResolvedValue([]);
const mockFailInterruptedExecutions = vi.fn().mockResolvedValue(undefined);
vi.mock('../features/automations/mass-action-hold.js', () => ({
  MassActionHoldService: class {
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    listHeld = mockMassListHeld;
    listApproved = mockMassListApproved;
    failInterruptedExecutions = mockFailInterruptedExecutions;
    threshold = mockMassThreshold;
    create = mockMassHoldCreate;
    ensureOwnerNotice = mockMassHoldNotice;
    claimApproved = mockMassClaimApproved;
    complete = mockMassComplete;
    fail = mockMassFail;
  },
}));

import { AutomationEngine } from '../features/automations/automation-engine.js';

// ── Helpers ───────────────────────────────────────────────

function makeGuild() {
  const cache = new Map<string, unknown>();
  cache.set('u1', { id: 'u1', displayName: 'TestUser' });
  cache.set('10000000000000000', { id: '10000000000000000', displayName: 'BulkOne' });
  cache.set('10000000000000001', { id: '10000000000000001', displayName: 'BulkTwo' });
  const channels = new Map<string, unknown>();
  channels.set('ch1', { id: 'ch1', name: 'general' });
  return {
    id: 'g1',
    memberCount: 42,
    members: { cache, fetch: vi.fn().mockResolvedValue(null) },
    channels: { cache: channels },
  };
}

function makeAutomation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'auto1',
    name: 'Test Automation',
    conditions: [],
    actions: [{ type: 'send_message', config: { channelId: 'ch1', content: 'hello' } }],
    scopeTargetUserIds: [] as string[],
    scopeExcludeUserIds: [] as string[],
    scopeTargetChannelIds: [] as string[],
    scopeExcludeChannelIds: [] as string[],
    rateLimitPerUser: 0,
    rateLimitWindowSeconds: 0,
    ...overrides,
  };
}

function makeValkey() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  };
}

function makeSupabase() {
  return { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnThis() }) };
}

function makeEventBus() {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    onAny: vi.fn((cb: (event: unknown) => void) => { listeners.push(cb); }),
    on: vi.fn(),
    emit: vi.fn(),
    _listeners: listeners,
    fire: (event: unknown) => {
      for (const fn of listeners) fn(event);
    },
  };
}

describe('AutomationEngine', () => {
  let engine: AutomationEngine;
  let guild: ReturnType<typeof makeGuild>;
  let eventBus: ReturnType<typeof makeEventBus>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockLoad.mockResolvedValue(undefined);
    mockGetForTrigger.mockReturnValue([]);
    mockEvaluateConditions.mockResolvedValue(true);
    mockExecuteActions.mockResolvedValue({ executed: 1, failed: 0, errors: [] });
    mockAllowFire.mockResolvedValue(true);
    mockAllowCustom.mockResolvedValue(true);
    mockLogExecution.mockResolvedValue(undefined);
    mockClaim.mockResolvedValue({ claimed: true, rowId: 'exec-1' });
    mockFinalize.mockResolvedValue(undefined);
    mockRelease.mockResolvedValue(undefined);
    mockMassThreshold.mockResolvedValue(25);
    mockMassHoldCreate.mockResolvedValue({
      created: true,
      hold: {
        id: 'hold-1',
        automation_id: 'auto1',
        member_count: 26,
        threshold: 25,
      },
    });
    mockMassHoldNotice.mockResolvedValue(undefined);
    mockMassClaimApproved.mockResolvedValue(null);
    mockMassComplete.mockResolvedValue(undefined);
    mockMassFail.mockResolvedValue(undefined);
    mockMassListHeld.mockResolvedValue([]);
    mockMassListApproved.mockResolvedValue([]);
    mockFailInterruptedExecutions.mockResolvedValue(undefined);
    guild = makeGuild();
    eventBus = makeEventBus();
    engine = new AutomationEngine(
      guild as any,
      makeSupabase() as any,
      makeValkey() as any,
      eventBus as any,
    );
  });

  describe('start', () => {
    it('loads automations and subscribes', async () => {
      await engine.start();
      expect(mockLoad).toHaveBeenCalled();
      expect(mockFailInterruptedExecutions).toHaveBeenCalledTimes(1);
      expect(mockSubscribe).toHaveBeenCalled();
      expect(eventBus.onAny).toHaveBeenCalled();
    });

    it('registers event handler that ignores other guilds', async () => {
      await engine.start();
      mockGetForTrigger.mockReturnValue([]);
      // Fire event from different guild
      eventBus.fire({ type: 'member.joined', guildId: 'other', data: {} });
      // processAutomation should not be called
      expect(mockGetForTrigger).not.toHaveBeenCalled();
    });

    it('handles events for matching guild', async () => {
      await engine.start();
      mockGetForTrigger.mockReturnValue([]);
      eventBus.fire({ type: 'member.joined', guildId: 'g1', data: {} });
      expect(mockGetForTrigger).toHaveBeenCalledWith('member.joined');
    });

    it('keeps ordinary automations online when one held notice cannot recover', async () => {
      mockMassListHeld.mockResolvedValue([{
        id: 'hold-broken-notice',
        automation_id: 'auto1',
      }]);
      mockMassHoldNotice.mockRejectedValueOnce(new Error('Missing Permissions'));

      await expect(engine.start()).resolves.toBeUndefined();
      expect(eventBus.onAny).toHaveBeenCalledTimes(1);
    });
  });

  describe('setAlertService', () => {
    it('sets alert service', () => {
      const alertService = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
      engine.setAlertService(alertService as any);
      // No error thrown
    });
  });

  describe('handleEvent / processAutomation', () => {
    it('durably holds an oversized resolved member set before any action executes', async () => {
      mockGetForTrigger.mockReturnValue([
        makeAutomation({
          actions: [{ type: 'give_role', config: { role_id: 'role1' } }],
        }),
      ]);
      await engine.start();
      eventBus.fire({
        type: 'giveaway.ended',
        guildId: 'g1',
        data: {
          title: 'Bulk winners',
          winnerIds: Array.from(
            { length: 26 },
            (_, index) => String(10000000000000000n + BigInt(index)),
          ),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockMassHoldCreate).toHaveBeenCalledWith(expect.objectContaining({
        automationId: 'auto1',
        memberIds: expect.arrayContaining(['10000000000000000', '10000000000000025']),
        threshold: 25,
      }));
      expect(mockMassHoldNotice).toHaveBeenCalledTimes(1);
      expect(mockExecuteActions).not.toHaveBeenCalled();
      expect(mockFinalize).not.toHaveBeenCalled();
    });

    it('releases the occurrence claim when the mass-action threshold read fails', async () => {
      mockGetForTrigger.mockReturnValue([
        makeAutomation({
          actions: [{ type: 'give_role', config: { role_id: 'role1' } }],
        }),
      ]);
      mockMassThreshold.mockRejectedValueOnce(new Error('guild_config unavailable'));
      await engine.start();
      eventBus.fire({
        type: 'giveaway.ended',
        guildId: 'g1',
        data: {
          title: 'Bulk winners',
          winnerIds: ['10000000000000000', '10000000000000001'],
        },
      });

      await vi.waitFor(() => {
        expect(mockRelease).toHaveBeenCalledWith('exec-1');
      });
      expect(mockExecuteActions).not.toHaveBeenCalled();
      expect(mockMassHoldCreate).not.toHaveBeenCalled();
    });

    it('preserves configured action order while fanning member actions out', async () => {
      mockGetForTrigger.mockReturnValue([
        makeAutomation({
          actions: [
            { type: 'give_role', config: { role_id: 'role1' } },
            { type: 'wait_delay', config: { seconds: 1 } },
            { type: 'remove_role', config: { role_id: 'role1' } },
          ],
        }),
      ]);
      await engine.start();
      eventBus.fire({
        type: 'giveaway.ended',
        guildId: 'g1',
        data: {
          winnerIds: ['10000000000000000', '10000000000000001'],
        },
      });

      await vi.waitFor(() => expect(mockFinalize).toHaveBeenCalled());
      expect(mockExecuteActions.mock.calls.map((call) => call[0][0].type)).toEqual([
        'give_role',
        'give_role',
        'wait_delay',
        'remove_role',
        'remove_role',
      ]);
    });

    it('applies user include and exclude scopes to each resolved bulk member', async () => {
      mockGetForTrigger.mockReturnValue([
        makeAutomation({
          actions: [{ type: 'give_role', config: { role_id: 'role1' } }],
          scopeTargetUserIds: ['10000000000000000', '10000000000000001'],
          scopeExcludeUserIds: ['10000000000000001'],
        }),
      ]);
      await engine.start();
      eventBus.fire({
        type: 'giveaway.ended',
        guildId: 'g1',
        data: {
          winnerIds: ['10000000000000000', '10000000000000001'],
        },
      });

      await vi.waitFor(() => expect(mockFinalize).toHaveBeenCalled());
      const targetIds = mockExecuteActions.mock.calls.map((call) => call[1].member?.id);
      expect(targetIds).toEqual(['10000000000000000']);
    });

    it('atomically released hold fans member actions out once and finalizes the original claim', async () => {
      mockMassClaimApproved.mockResolvedValue({
        id: 'hold-1',
        automation_id: 'auto1',
        execution_id: 'exec-1',
        occurrence_id: '10000000-0000-8000-8000-000000000001',
        member_ids: ['10000000000000000', '10000000000000001'],
        member_count: 2,
        threshold: 1,
        trigger_event: 'member.verified',
        triggered_by: 'system',
        action_snapshot: [{ type: 'give_role', config: { role_id: 'role1' } }],
        context_snapshot: { channelId: null, messageId: null, variables: {} },
      });
      (engine as unknown as { automationName(id: string): Promise<string> }).automationName =
        vi.fn().mockResolvedValue('Test Automation');

      await (engine as unknown as { runApprovedHold(id: string): Promise<void> })
        .runApprovedHold('hold-1');

      expect(mockMassClaimApproved).toHaveBeenCalledWith('hold-1');
      expect(mockExecuteActions).toHaveBeenCalledTimes(2);
      expect(mockFinalize).toHaveBeenCalledWith(
        'exec-1',
        expect.objectContaining({ actionsExecuted: 2, actionsFailed: 0 }),
      );
      expect(mockMassComplete).toHaveBeenCalledWith('hold-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'automation.executed',
        'g1',
        expect.objectContaining({ actionsExecuted: 2, success: true }),
      );
    });

    it('drops event exceeding chain depth', async () => {
      await engine.start();
      eventBus.fire({ type: 'member.joined', guildId: 'g1', data: {}, _chainDepth: 10 });
      expect(mockGetForTrigger).not.toHaveBeenCalled();
    });

    it('processes automation when trigger matches', async () => {
      const auto = makeAutomation();
      mockGetForTrigger.mockReturnValue([auto]);
      await engine.start();

      eventBus.fire({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u1' },
      });

      // Wait for async processAutomation
      await new Promise((r) => setTimeout(r, 50));
      expect(mockExecuteActions).toHaveBeenCalled();
      expect(mockFinalize).toHaveBeenCalled();
    });

    it('skips automation when scope excludes user', async () => {
      const auto = makeAutomation({ scopeExcludeUserIds: ['u1'] });
      mockGetForTrigger.mockReturnValue([auto]);
      await engine.start();

      eventBus.fire({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u1' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(mockExecuteActions).not.toHaveBeenCalled();
    });

    it('skips automation when scope targets different user', async () => {
      const auto = makeAutomation({ scopeTargetUserIds: ['u2'] });
      mockGetForTrigger.mockReturnValue([auto]);
      await engine.start();

      eventBus.fire({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u1' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(mockExecuteActions).not.toHaveBeenCalled();
    });

    it('skips automation when scope excludes channel', async () => {
      const auto = makeAutomation({ scopeExcludeChannelIds: ['ch1'] });
      mockGetForTrigger.mockReturnValue([auto]);
      await engine.start();

      eventBus.fire({
        type: 'message.sent',
        guildId: 'g1',
        data: { discordId: 'u1', channelId: 'ch1' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(mockExecuteActions).not.toHaveBeenCalled();
    });

    it('skips automation when scope targets different channel', async () => {
      const auto = makeAutomation({ scopeTargetChannelIds: ['ch2'] });
      mockGetForTrigger.mockReturnValue([auto]);
      await engine.start();

      eventBus.fire({
        type: 'message.sent',
        guildId: 'g1',
        data: { discordId: 'u1', channelId: 'ch1' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(mockExecuteActions).not.toHaveBeenCalled();
    });

    it('skips when rate limited', async () => {
      const auto = makeAutomation();
      mockGetForTrigger.mockReturnValue([auto]);
      mockAllowFire.mockResolvedValue(false);
      await engine.start();

      eventBus.fire({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u1' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(mockExecuteActions).not.toHaveBeenCalled();
    });

    it('skips when custom rate limited', async () => {
      const auto = makeAutomation({ rateLimitPerUser: 3, rateLimitWindowSeconds: 60 });
      mockGetForTrigger.mockReturnValue([auto]);
      mockAllowFire.mockResolvedValue(true);
      mockAllowCustom.mockResolvedValue(false);
      await engine.start();

      eventBus.fire({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u1' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(mockExecuteActions).not.toHaveBeenCalled();
    });

    it('logs conditions-failed when conditions not met', async () => {
      const auto = makeAutomation({ conditions: [{ type: 'has_role', config: {} }] });
      mockGetForTrigger.mockReturnValue([auto]);
      mockEvaluateConditions.mockResolvedValue(false);
      await engine.start();

      eventBus.fire({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u1' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(mockFinalize).toHaveBeenCalled();
      // finalize(rowId, result) — the result object is the second arg.
      const logged = mockFinalize.mock.calls[0][1];
      expect(logged.conditionsPassed).toBe(false);
    });

    it('reports failures to alert service', async () => {
      const alertService = {
        recordSuccess: vi.fn().mockResolvedValue(undefined),
        recordFailure: vi.fn().mockResolvedValue(undefined),
      };
      engine.setAlertService(alertService as any);

      const auto = makeAutomation();
      mockGetForTrigger.mockReturnValue([auto]);
      mockEvaluateConditions.mockResolvedValue(true);
      mockExecuteActions.mockResolvedValue({ executed: 1, failed: 1, errors: ['oops'] });
      await engine.start();

      eventBus.fire({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u1' },
      });

      // processAutomation runs async — wait enough time
      await vi.waitFor(() => {
        expect(alertService.recordFailure).toHaveBeenCalledWith('auto1', 'Test Automation', 'oops');
      }, { timeout: 2000 });
    });

    it('reports success to alert service', async () => {
      const alertService = {
        recordSuccess: vi.fn().mockResolvedValue(undefined),
        recordFailure: vi.fn().mockResolvedValue(undefined),
      };
      engine.setAlertService(alertService as any);

      const auto = makeAutomation();
      mockGetForTrigger.mockReturnValue([auto]);
      mockEvaluateConditions.mockResolvedValue(true);
      mockExecuteActions.mockResolvedValue({ executed: 1, failed: 0, errors: [] });
      await engine.start();

      eventBus.fire({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u1' },
      });

      await vi.waitFor(() => {
        expect(alertService.recordSuccess).toHaveBeenCalledWith('auto1');
      }, { timeout: 2000 });
    });
  });

  describe('buildEventContext variables', () => {
    async function fireAndCapture(eventType: string, data: Record<string, unknown>) {
      const auto = makeAutomation();
      mockGetForTrigger.mockReturnValue([auto]);
      mockEvaluateConditions.mockResolvedValue(true);
      mockExecuteActions.mockResolvedValue({ executed: 1, failed: 0, errors: [] });
      await engine.start();

      eventBus.fire({ type: eventType, guildId: 'g1', data });
      await new Promise((r) => setTimeout(r, 50));

      // Capture the ActionContext passed to executeActions
      return mockExecuteActions.mock.calls[0]?.[1] as {
        variables: Record<string, string>;
        occurrenceId: string;
        member: { id: string } | null;
      } | undefined;
    }

    it('resolves member.joined variables', async () => {
      const ctx = await fireAndCapture('member.joined', { discordId: 'u1', isReturning: true });
      expect(ctx?.variables.memberCount).toBe('42');
      expect(ctx?.variables.returning).toBe('true');
      expect(ctx?.occurrenceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('resolves member.left variables', async () => {
      const ctx = await fireAndCapture('member.left', { discordId: 'u1' });
      expect(ctx?.variables.memberCount).toBe('42');
    });

    it('resolves member.verified variables', async () => {
      const ctx = await fireAndCapture('member.verified', {
        discordId: 'u1',
        username: 'TestUser',
        memberNumber: 42,
      } satisfies PlatformEventMap['member.verified']);
      expect(ctx?.variables.memberNumber).toBe('42');
    });

    it('resolves message.sent variables', async () => {
      const ctx = await fireAndCapture('message.sent', { discordId: 'u1', channelId: 'ch1', content: 'hello world' });
      expect(ctx?.variables.content).toBe('hello world');
      expect(ctx?.variables.message).toBe('hello world');
    });

    it('resolves role.gained variables', async () => {
      const ctx = await fireAndCapture('role.gained', { discordId: 'u1', roleId: 'r1', roleName: 'Admin', source: 'manual' });
      expect(ctx?.variables['role']).toBe('<@&r1>');
      expect(ctx?.variables['role.name']).toBe('Admin');
      expect(ctx?.variables['source']).toBe('manual');
    });

    it('resolves role.lost variables', async () => {
      const ctx = await fireAndCapture('role.lost', { discordId: 'u1', roleId: 'r1', roleName: 'Admin' });
      expect(ctx?.variables['role']).toBe('<@&r1>');
    });

    it('resolves level.up variables', async () => {
      const ctx = await fireAndCapture('level.up', { discordId: 'u1', previousLevel: 5, newLevel: 6 });
      expect(ctx?.variables.oldLevel).toBe('5');
      expect(ctx?.variables.newLevel).toBe('6');
    });

    it('resolves purchase.completed variables', async () => {
      const ctx = await fireAndCapture('purchase.completed', { discordId: 'u1', productName: 'VIP', orderNumber: 'ORD-1', amount: 9.99 });
      expect(ctx?.variables.product).toBe('VIP');
      expect(ctx?.variables.order).toBe('ORD-1');
      expect(ctx?.variables.amount).toBe('9.99');
    });

    it('resolves subscription.activated variables', async () => {
      const ctx = await fireAndCapture('subscription.activated', { discordId: 'u1', planId: 'premium' });
      expect(ctx?.variables.plan).toBe('premium');
    });

    it('resolves subscription.lapsed variables', async () => {
      const ctx = await fireAndCapture('subscription.lapsed', { discordId: 'u1', planId: 'premium' });
      expect(ctx?.variables.plan).toBe('premium');
    });

    it('resolves subscription.expired variables', async () => {
      const ctx = await fireAndCapture('subscription.expired', { discordId: 'u1', planId: 'premium' });
      expect(ctx?.variables.plan).toBe('premium');
    });

    it('resolves ticket.opened variables', async () => {
      const ctx = await fireAndCapture('ticket.opened', {
        ticketId: 'ticket-1',
        ticketNumber: 42,
        channelId: 'ch1',
        userDiscordId: 'u1',
        panelId: 'panel-1',
      } satisfies PlatformEventMap['ticket.opened']);
      expect(ctx?.variables.ticket).toBe('#42');
      expect(ctx?.member?.id).toBe('u1');
    });

    it('resolves ticket.closed variables', async () => {
      const ctx = await fireAndCapture('ticket.closed', {
        ticketId: 'ticket-1',
        ticketNumber: 42,
        channelId: 'ch1',
        userDiscordId: 'u1',
        panelId: 'panel-1',
      } satisfies PlatformEventMap['ticket.closed']);
      expect(ctx?.variables.ticket).toBe('#42');
      expect(ctx?.member?.id).toBe('u1');
    });

    it('resolves giveaway.ended variables', async () => {
      const ctx = await fireAndCapture('giveaway.ended', {
        discordId: '10000000000000000',
        title: 'Epic Giveaway',
        winnerIds: ['10000000000000000', '10000000000000001'],
      });
      expect(ctx?.variables.giveaway).toBe('Epic Giveaway');
      expect(ctx?.variables.winners).toContain('<@10000000000000000>');
    });

    it('resolves button.clicked variables', async () => {
      const ctx = await fireAndCapture('button.clicked', {
        interactionId: 'interaction-1',
        discordId: 'u1',
        username: 'TestUser',
        buttonId: 'btn_verify',
        channelId: 'ch1',
        messageId: 'message-1',
      } satisfies PlatformEventMap['button.clicked']);
      expect(ctx?.variables.buttonId).toBe('btn_verify');
    });

    it('resolves reaction.added variables', async () => {
      const ctx = await fireAndCapture('reaction.added', { discordId: 'u1', emoji: '👍' });
      expect(ctx?.variables.emoji).toBe('👍');
    });

    it('resolves voice.joined variables', async () => {
      const ctx = await fireAndCapture('voice.joined', { discordId: 'u1', channelId: 'ch1', channelName: 'General' });
      expect(ctx?.variables.channel).toBe('General');
    });

    it('resolves voice.left variables', async () => {
      const ctx = await fireAndCapture('voice.left', { discordId: 'u1', channelId: 'ch1' });
      expect(ctx?.variables.channel).toContain('ch1');
    });

    it('resolves infraction.created variables', async () => {
      const ctx = await fireAndCapture('infraction.created', {
        infractionId: 'infraction-1',
        userId: 'u1',
        moderatorId: 'moderator-1',
        type: 'warn',
        reason: 'spam',
        totalInfractions: 3,
      } satisfies PlatformEventMap['infraction.created']);
      expect(ctx?.variables.type).toBe('warn');
      expect(ctx?.variables.reason).toBe('spam');
      expect(ctx?.variables.count).toBe('3');
      expect(ctx?.member?.id).toBe('u1');
    });

    it('resolves unknown discordId gracefully', async () => {
      const ctx = await fireAndCapture('member.joined', { discordId: 'unknown_user' });
      expect(ctx?.variables['user']).toBe('unknown_user');
    });
  });

  describe('processMessageEvent', () => {
    it('processes message event with message object', async () => {
      const auto = makeAutomation();
      mockGetForTrigger.mockReturnValue([auto]);
      await engine.start();

      const message = { id: 'msg1', content: 'hello', channel: { id: 'ch1' } };
      await engine.processMessageEvent(
        { type: 'message.sent', guildId: 'g1', data: { discordId: 'u1', channelId: 'ch1', content: 'hello' } } as any,
        message as any,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(mockExecuteActions).toHaveBeenCalled();
    });

    it('skips when no message.sent automations', async () => {
      mockGetForTrigger.mockReturnValue([]);
      await engine.start();
      await engine.processMessageEvent(
        { type: 'message.sent', guildId: 'g1', data: {} } as any,
        {} as any,
      );
      expect(mockExecuteActions).not.toHaveBeenCalled();
    });
  });

  describe('processReactionEvent', () => {
    it('processes reaction event', async () => {
      const auto = makeAutomation();
      mockGetForTrigger.mockReturnValue([auto]);
      await engine.start();

      const message = { id: 'msg1', content: '', channel: { id: 'ch1' } };
      await engine.processReactionEvent(
        { type: 'reaction.added', guildId: 'g1', data: { discordId: 'u1', emoji: '👍' } } as any,
        message as any,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(mockExecuteActions).toHaveBeenCalled();
    });

    it('skips when no reaction.added automations', async () => {
      mockGetForTrigger.mockReturnValue([]);
      await engine.start();
      await engine.processReactionEvent(
        { type: 'reaction.added', guildId: 'g1', data: {} } as any,
        {} as any,
      );
      expect(mockExecuteActions).not.toHaveBeenCalled();
    });

    it('suppresses only the generic replay of the same specialized reaction object', async () => {
      const auto = makeAutomation();
      mockGetForTrigger.mockReturnValue([auto]);
      await engine.start();
      const message = { id: 'msg1', content: '', channel: { id: 'ch1' } };

      const firstData = {
        discordId: 'u1', emoji: '👍', channelId: 'ch1', messageId: 'msg1',
      };
      await engine.processReactionEvent(
        { type: 'reaction.added', guildId: 'g1', data: firstData } as any,
        message as any,
      );
      eventBus.fire({ type: 'reaction.added', guildId: 'g1', data: firstData });

      await vi.waitFor(() => expect(mockExecuteActions).toHaveBeenCalledTimes(1));
      const firstOccurrence = (
        mockExecuteActions.mock.calls[0]?.[1] as { occurrenceId: string }
      ).occurrenceId;

      // A real remove-then-readd has the same visible tuple but arrives as a
      // new event data object. It must remain a distinct automation occurrence.
      const readdData = {
        discordId: 'u1', emoji: '👍', channelId: 'ch1', messageId: 'msg1',
      };
      await engine.processReactionEvent(
        { type: 'reaction.added', guildId: 'g1', data: readdData } as any,
        message as any,
      );
      eventBus.fire({ type: 'reaction.added', guildId: 'g1', data: readdData });

      await vi.waitFor(() => expect(mockExecuteActions).toHaveBeenCalledTimes(2));
      const secondOccurrence = (
        mockExecuteActions.mock.calls[1]?.[1] as { occurrenceId: string }
      ).occurrenceId;
      expect(secondOccurrence).not.toBe(firstOccurrence);
    });
  });

  // ── durable occurrence claim dedup ──────
  describe('occurrence claim dedup', () => {
    it('skips re-execution when the occurrence claim is rejected (redelivery)', async () => {
      const auto = makeAutomation();
      mockGetForTrigger.mockReturnValue([auto]);
      mockEvaluateConditions.mockResolvedValue(true);
      mockExecuteActions.mockResolvedValue({ executed: 1, failed: 0, errors: [] });
      // First delivery claims the occurrence; the redelivery's claim is rejected
      // (the unique index → 23505 → claimed:false), so actions must NOT re-run.
      mockClaim
        .mockResolvedValueOnce({ claimed: true, rowId: 'r1' })
        .mockResolvedValueOnce({ claimed: false, rowId: null });
      await engine.start();

      const message = { id: 'msg1', content: 'hi', channel: { id: 'ch1' } };
      const event = {
        type: 'message.sent',
        guildId: 'g1',
        data: { discordId: 'u1', channelId: 'ch1', messageId: 'msg1', content: 'hi' },
      };
      await engine.processMessageEvent(event as any, message as any);
      await engine.processMessageEvent(event as any, message as any); // redelivery
      await new Promise((r) => setTimeout(r, 50));

      // Exactly one execution despite two deliveries of the same occurrence.
      expect(mockExecuteActions).toHaveBeenCalledTimes(1);
    });
  });

  // ── per-event regex budget wiring (PR #269 review) ──────

  describe('regex budget wiring', () => {
    it('passes ONE shared regex budget to all automations of an event, and a fresh one per event', async () => {
      const autos = [makeAutomation({ id: 'a1' }), makeAutomation({ id: 'a2' })];
      mockGetForTrigger.mockReturnValue(autos);
      mockEvaluateConditions.mockResolvedValue(true);
      await engine.start();

      eventBus.fire({ type: 'member.joined', guildId: 'g1', data: { discordId: 'u1' } });
      await new Promise((r) => setTimeout(r, 50));
      eventBus.fire({ type: 'member.joined', guildId: 'g1', data: { discordId: 'u1' } });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockEvaluateConditions).toHaveBeenCalledTimes(4);
      const budgets = mockEvaluateConditions.mock.calls.map(
        (c) => (c[1] as { regexBudget: unknown }).regexBudget,
      );
      for (const b of budgets) expect(b).toBeDefined();
      // Both automations of event 1 share the same budget object…
      expect(budgets[0]).toBe(budgets[1]);
      // …event 2 gets its own.
      expect(budgets[2]).toBe(budgets[3]);
      expect(budgets[0]).not.toBe(budgets[2]);
    });
  });
});
