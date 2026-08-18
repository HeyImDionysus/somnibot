import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecuteActions = vi.fn();

vi.mock('../features/automations/action-executor.js', () => ({
  executeActions: (...args: unknown[]) => mockExecuteActions(...args),
}));

import { AutomationActionResumeRunner } from '../features/automations/action-resume-runner.js';

describe('AutomationActionResumeRunner', () => {
  beforeEach(() => {
    mockExecuteActions.mockReset();
    mockExecuteActions.mockResolvedValue({ executed: 1, failed: 0, errors: [] });
  });

  it('executes the authoritative action payload returned by the database claim', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'initialize_automation_action_progress') return { data: true, error: null };
      if (name === 'claim_automation_action_progress') {
        return {
          data: [{
            claim_state: 'claimed',
            action_payload: { type: 'wait_delay', config: { seconds: 0 } },
            retry_safe: true,
            attempt_count: 1,
          }],
          error: null,
        };
      }
      if (name === 'settle_automation_action_progress') return { data: true, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    const runner = new AutomationActionResumeRunner({
      guild: {
        id: 'guild-1',
        members: { cache: new Map(), fetch: vi.fn() },
      } as never,
      supabase: { rpc } as never,
      rateLimiter: vi.fn() as never,
      executionLogger: {} as never,
    });

    await runner.execute({
      executionId: '00000000-0000-4000-8000-000000000001',
      actions: [{ type: 'wait_delay', config: { seconds: 99 } }],
      context: {
        guild: {} as never,
        member: null,
        channelId: null,
        messageId: null,
        message: null,
        supabase: {} as never,
        guildId: 'guild-1',
        rateLimiter: {} as never,
        automationId: '00000000-0000-4000-8000-000000000002',
        occurrenceId: 'occurrence-1',
        variables: {},
      },
      affectedMemberIds: [],
    });

    expect(mockExecuteActions).toHaveBeenCalledWith(
      [{ type: 'wait_delay', config: { seconds: 0 } }],
      expect.any(Object),
      0,
    );
  });

  it('finalizes an execution recovered after its last action already settled', async () => {
    const executionId = '00000000-0000-4000-8000-000000000003';
    const finalizeStrict = vi.fn().mockResolvedValue(undefined);
    const rpc = vi.fn(async (name: string) => {
      if (name === 'recover_stale_automation_action_progress') {
        return {
          data: [{
            execution_id: executionId,
            recovery_state: 'resumable',
            recovery_context: {
              automationId: '00000000-0000-4000-8000-000000000004',
              occurrenceId: 'occurrence-finalize',
              triggeredBy: 'system',
              triggerEvent: 'recovered',
              memberId: null,
              channelId: null,
              messageId: null,
              variables: {},
            },
          }],
          error: null,
        };
      }
      if (name === 'complete_automation_action_progress') return { data: true, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    const rows = [{
      action_index: 0,
      target_id: '',
      action_payload: { type: 'wait_delay', config: { seconds: 0 } },
      status: 'completed',
      result: { executed: 1, failed: 0, errors: [] },
    }];
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    let orderCall = 0;
    query.order = vi.fn(() => {
      orderCall += 1;
      return orderCall % 2 === 1 ? query : Promise.resolve({ data: rows, error: null });
    });
    const runner = new AutomationActionResumeRunner({
      guild: { id: 'guild-1' } as never,
      supabase: { rpc, from: vi.fn().mockReturnValue(query) } as never,
      rateLimiter: vi.fn() as never,
      executionLogger: { finalizeStrict } as never,
    });

    await runner.recover();

    expect(finalizeStrict).toHaveBeenCalledWith(
      executionId,
      expect.objectContaining({ actionsExecuted: 1, actionsFailed: 0 }),
    );
    expect(rpc).toHaveBeenCalledWith('complete_automation_action_progress', {
      p_execution_id: executionId,
      p_recovered: true,
    });
  });
});
