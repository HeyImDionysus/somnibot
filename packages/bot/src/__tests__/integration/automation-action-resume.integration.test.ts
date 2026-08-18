import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa: SupabaseClient;
const guildId = `test-automation-resume-${Date.now()}`;
let automationId = '';
const executionIds: string[] = [];

async function createExecution(): Promise<string> {
  const occurrenceId = randomUUID();
  const execution = await supa.from('automation_executions').insert({
    automation_id: automationId,
    guild_id: guildId,
    triggered_by: '12345678901234567',
    trigger_event: 'member.verified',
    occurrence_id: occurrenceId,
    conditions_passed: false,
    actions_executed: 0,
    actions_failed: 0,
    errors: [],
    duration_ms: 0,
    actions_started: true,
  }).select('id').single();
  if (execution.error) throw new Error(`Execution seed failed: ${execution.error.message}`);
  executionIds.push(execution.data.id);
  return execution.data.id;
}

async function initialize(
  executionId: string,
  actions: readonly { readonly type: string; readonly retrySafe: boolean }[],
): Promise<void> {
  const initialized = await supa.rpc('initialize_automation_action_progress', {
    p_execution_id: executionId,
    p_actions: actions.map((action, actionIndex) => ({
      action_index: actionIndex,
      action_type: action.type,
      action_payload: { type: action.type, config: {} },
      target_id: '',
      retry_safe: action.retrySafe,
    })),
    p_recovery_context: { memberId: null, channelId: null, messageId: null, variables: {} },
  });
  expect(initialized.error).toBeNull();
}

async function claim(executionId: string, actionIndex: number, ownerToken: string) {
  return supa.rpc('claim_automation_action_progress', {
    p_execution_id: executionId,
    p_action_index: actionIndex,
    p_target_id: '',
    p_owner_token: ownerToken,
    p_lease_seconds: 120,
  });
}

beforeAll(async () => {
  supa = await requireSupabase();
  const guild = await supa.from('guild').insert({
    id: guildId,
    name: 'Automation action resume integration test',
    owner_discord_id: '12345678901234567',
  });
  if (guild.error) throw new Error(`Guild seed failed: ${guild.error.message}`);

  const automation = await supa.from('automations').insert({
    guild_id: guildId,
    name: 'Durable action recovery test',
    trigger_type: 'member.verified',
    actions: [{ type: 'wait_delay', config: { seconds: 0 } }],
  }).select('id').single();
  if (automation.error) throw new Error(`Automation seed failed: ${automation.error.message}`);
  automationId = automation.data.id;
});

afterAll(async () => {
  if (supa) {
    await supa.from('automations').delete().eq('id', automationId);
    await supa.from('guild').delete().eq('id', guildId);
  }
});

describe('automation per-action recovery', () => {
  it('elects one worker when a crash occurs before the first action', async () => {
    // Given
    const executionId = await createExecution();
    await initialize(executionId, [
      { type: 'wait_delay', retrySafe: true },
      { type: 'wait_delay', retrySafe: true },
    ]);

    // When
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) => claim(executionId, 0, `worker-${index}`)),
    );

    // Then
    expect(claims.filter((result) => result.data?.[0]?.claim_state === 'claimed')).toHaveLength(1);
    expect(claims.filter((result) => result.data?.[0]?.claim_state === 'busy')).toHaveLength(7);
    expect((await claim(executionId, 1, 'out-of-order-worker')).data?.[0]?.claim_state).toBe('busy');
  });

  it('reclaims an expired retry-safe action after its side effect committed before settlement', async () => {
    // Given
    const executionId = await createExecution();
    await initialize(executionId, [{ type: 'grant_entitlement', retrySafe: true }]);
    expect((await claim(executionId, 0, 'dead-worker')).data?.[0]?.claim_state).toBe('claimed');
    await supa.from('automation_action_progress').update({
      lease_expires_at: new Date(0).toISOString(),
    }).eq('execution_id', executionId).eq('action_index', 0);

    // When
    const resumed = await claim(executionId, 0, 'replacement-worker');

    // Then
    expect(resumed.data?.[0]).toMatchObject({ claim_state: 'claimed', attempt_count: 2 });
  });

  it('resumes the next pending action without replaying a settled action', async () => {
    // Given
    const executionId = await createExecution();
    await initialize(executionId, [
      { type: 'grant_entitlement', retrySafe: true },
      { type: 'wait_delay', retrySafe: true },
    ]);
    await claim(executionId, 0, 'first-worker');
    const settled = await supa.rpc('settle_automation_action_progress', {
      p_execution_id: executionId,
      p_action_index: 0,
      p_target_id: '',
      p_owner_token: 'first-worker',
      p_success: true,
      p_result: { executed: 1, failed: 0, errors: [] },
    });
    expect(settled).toMatchObject({ data: true, error: null });

    // When
    const replayed = await claim(executionId, 0, 'replacement-worker');
    const next = await claim(executionId, 1, 'replacement-worker');

    // Then
    expect(replayed.data?.[0]?.claim_state).toBe('completed');
    expect(next.data?.[0]?.claim_state).toBe('claimed');
  });

  it('does not reclaim an execution while a mass-action hold owns it', async () => {
    // Given
    const executionId = await createExecution();
    await initialize(executionId, [{ type: 'send_message', retrySafe: false }]);
    await claim(executionId, 0, 'dead-worker');
    await supa.from('automation_action_progress').update({
      lease_expires_at: new Date(0).toISOString(),
    }).eq('execution_id', executionId).eq('action_index', 0);
    const hold = await supa.from('automation_mass_action_holds').insert({
      guild_id: guildId,
      automation_id: automationId,
      execution_id: executionId,
      occurrence_id: randomUUID(),
      member_ids: Array.from({ length: 26 }, (_, index) => String(10000000000000000n + BigInt(index))),
      member_count: 26,
      threshold: 25,
      trigger_event: 'member.verified',
      triggered_by: '12345678901234567',
      action_snapshot: [{ type: 'send_message', config: {} }],
      context_snapshot: { channelId: null, messageId: null, variables: {} },
    });
    expect(hold.error).toBeNull();

    // When
    const sweep = await supa.rpc('recover_stale_automation_action_progress', {
      p_guild_id: guildId,
      p_stale_before: new Date().toISOString(),
    });

    // Then
    expect(sweep.error).toBeNull();
    const row = await supa.from('automation_action_progress')
      .select('status')
      .eq('execution_id', executionId)
      .single();
    expect(row.data?.status).toBe('executing');
  });

  it('fails an expired ambiguous side effect closed with one recovery audit', async () => {
    // Given
    const executionId = await createExecution();
    await initialize(executionId, [{ type: 'send_message', retrySafe: false }]);
    await claim(executionId, 0, 'dead-worker');
    await supa.from('automation_action_progress').update({
      lease_expires_at: new Date(0).toISOString(),
    }).eq('execution_id', executionId).eq('action_index', 0);

    // When
    const sweep = await supa.rpc('recover_stale_automation_action_progress', {
      p_guild_id: guildId,
      p_stale_before: new Date().toISOString(),
    });
    const repeatedSweep = await supa.rpc('recover_stale_automation_action_progress', {
      p_guild_id: guildId,
      p_stale_before: new Date().toISOString(),
    });

    // Then
    expect(sweep.error).toBeNull();
    expect(repeatedSweep.error).toBeNull();
    const row = await supa.from('automation_action_progress')
      .select('status, result')
      .eq('execution_id', executionId)
      .single();
    expect(row.data?.status).toBe('manual_reconcile');
    const audits = await supa.from('audit_logs')
      .select('action, occurrence_key, success')
      .eq('guild_id', guildId)
      .eq('action', 'automation.recovery_failed')
      .eq('target_id', executionId);
    expect(audits.data).toHaveLength(1);
    expect(audits.data?.[0]?.success).toBe(false);
  });

  it('returns pending retry-safe work from the restart sweep', async () => {
    // Given
    const executionId = await createExecution();
    await initialize(executionId, [
      { type: 'grant_entitlement', retrySafe: true },
      { type: 'wait_delay', retrySafe: true },
    ]);
    await claim(executionId, 0, 'dead-worker');
    await supa.from('automation_action_progress').update({
      lease_expires_at: new Date(0).toISOString(),
    }).eq('execution_id', executionId).eq('action_index', 0);

    // When
    const sweep = await supa.rpc('recover_stale_automation_action_progress', {
      p_guild_id: guildId,
      p_stale_before: new Date().toISOString(),
    });

    // Then
    expect(sweep.error).toBeNull();
    expect(sweep.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ execution_id: executionId, recovery_state: 'resumable' }),
    ]));
  });

  it('does not return fresh pending work but returns it after the shared stale window', async () => {
    // Given
    const executionId = await createExecution();
    await initialize(executionId, [{ type: 'wait_delay', retrySafe: true }]);
    const staleBefore = new Date(Date.now() - 120_000).toISOString();

    // When
    const freshSweep = await supa.rpc('recover_stale_automation_action_progress', {
      p_guild_id: guildId,
      p_stale_before: staleBefore,
    });
    const freshRow = await supa.from('automation_action_progress')
      .select('status, owner_token')
      .eq('execution_id', executionId)
      .single();
    await supa.from('automation_action_progress').update({ updated_at: new Date(0).toISOString() })
      .eq('execution_id', executionId);
    const staleSweep = await supa.rpc('recover_stale_automation_action_progress', {
      p_guild_id: guildId,
      p_stale_before: staleBefore,
    });

    // Then
    expect(freshSweep.error).toBeNull();
    expect(freshSweep.data).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ execution_id: executionId }),
    ]));
    expect(freshRow.data).toMatchObject({ status: 'pending', owner_token: null });
    expect(staleSweep.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ execution_id: executionId, recovery_state: 'resumable' }),
    ]));
  });

  it('rejects replay when the stored action plan conflicts with the requested plan', async () => {
    // Given
    const executionId = await createExecution();
    await initialize(executionId, [{ type: 'wait_delay', retrySafe: true }]);

    // When
    const replay = await supa.rpc('initialize_automation_action_progress', {
      p_execution_id: executionId,
      p_actions: [{
        action_index: 0,
        action_type: 'wait_delay',
        action_payload: { type: 'wait_delay', config: { seconds: 99 } },
        target_id: '',
        retry_safe: true,
      }],
      p_recovery_context: { memberId: null, channelId: null, messageId: null, variables: {} },
    });

    // Then
    expect(replay.data).toBeNull();
    expect(replay.error?.message).toContain('malformed or conflicting action plan');
    const stored = await supa.from('automation_action_progress')
      .select('action_payload')
      .eq('execution_id', executionId)
      .single();
    expect(stored.data?.action_payload).toEqual({ type: 'wait_delay', config: {} });
  });

  it('returns a stale execution that crashed after its last action settled', async () => {
    // Given
    const executionId = await createExecution();
    await initialize(executionId, [{ type: 'wait_delay', retrySafe: true }]);
    await claim(executionId, 0, 'last-action-worker');
    const settled = await supa.rpc('settle_automation_action_progress', {
      p_execution_id: executionId,
      p_action_index: 0,
      p_target_id: '',
      p_owner_token: 'last-action-worker',
      p_success: true,
      p_result: { executed: 1, failed: 0, errors: [] },
    });
    expect(settled).toMatchObject({ data: true, error: null });
    await supa.from('automation_action_progress').update({ updated_at: new Date(0).toISOString() })
      .eq('execution_id', executionId);

    // When
    const sweep = await supa.rpc('recover_stale_automation_action_progress', {
      p_guild_id: guildId,
      p_stale_before: new Date(Date.now() - 120_000).toISOString(),
    });

    // Then
    expect(sweep.error).toBeNull();
    expect(sweep.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ execution_id: executionId, recovery_state: 'resumable' }),
    ]));
  });

  it('locks recovery context initialization and rejects a conflicting concurrent replay', async () => {
    // Given
    const executionId = await createExecution();
    const actionPlan = [{
      action_index: 0,
      action_type: 'wait_delay',
      action_payload: { type: 'wait_delay', config: {} },
      target_id: '',
      retry_safe: true,
    }];
    const contexts = [
      { memberId: null, channelId: 'channel-a', messageId: null, variables: { source: 'a' } },
      { memberId: null, channelId: 'channel-b', messageId: null, variables: { source: 'b' } },
    ];

    // When
    const attempts = await Promise.all(contexts.map((context) => supa.rpc(
      'initialize_automation_action_progress',
      { p_execution_id: executionId, p_actions: actionPlan, p_recovery_context: context },
    )));

    // Then
    expect(attempts.filter((attempt) => attempt.error === null)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.error?.message.includes('conflicting recovery context')))
      .toHaveLength(1);
    const stored = await supa.from('automation_executions')
      .select('recovery_context')
      .eq('id', executionId)
      .single();
    const winningContext = contexts[attempts.findIndex((attempt) => attempt.error === null)];
    expect(stored.data?.recovery_context).toMatchObject(winningContext!);
  });
});
