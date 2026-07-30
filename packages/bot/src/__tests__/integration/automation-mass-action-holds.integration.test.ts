import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAnonTestClient,
  getAuthenticatedTestClient,
  requireSupabase,
} from './helpers.js';

let supa!: SupabaseClient;
let automationId = '';
let executionId = '';
const guildId = `test-mass-action-${Date.now()}`;
const occurrenceId = randomUUID();
const memberIds = Array.from({ length: 26 }, (_, index) =>
  String(10000000000000000n + BigInt(index)),
);

beforeAll(async () => {
  supa = await requireSupabase();
  const guild = await supa.from('guild').insert({
    id: guildId,
    name: 'Automation mass-action hold integration test',
    owner_discord_id: '12345678901234567',
  });
  if (guild.error) throw new Error(`Guild seed failed: ${guild.error.message}`);

  const automation = await supa.from('automations').insert({
    guild_id: guildId,
    name: 'Bulk role safety test',
    trigger_type: 'member.verified',
    actions: [{ type: 'give_role', config: { role_id: '99999999999999999' } }],
  }).select('id').single();
  if (automation.error) throw new Error(`Automation seed failed: ${automation.error.message}`);
  automationId = automation.data.id;

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
  }).select('id').single();
  if (execution.error) throw new Error(`Execution seed failed: ${execution.error.message}`);
  executionId = execution.data.id;
});

afterAll(async () => {
  if (supa) await supa.from('guild').delete().eq('id', guildId);
});

function holdPayload() {
  return {
    guild_id: guildId,
    automation_id: automationId,
    execution_id: executionId,
    occurrence_id: occurrenceId,
    member_ids: memberIds,
    member_count: memberIds.length,
    threshold: 25,
    trigger_event: 'member.verified',
    triggered_by: '12345678901234567',
    action_snapshot: [{ type: 'give_role', config: { role_id: '99999999999999999' } }],
    context_snapshot: { channelId: null, messageId: null, variables: {} },
  };
}

describe('automation mass-action holds', () => {
  it('elects one durable held occurrence and writes exactly one held audit', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        supa.from('automation_mass_action_holds').insert(holdPayload()).select('id').single(),
      ),
    );
    expect(attempts.filter((attempt) => !attempt.error)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.error?.code === '23505')).toHaveLength(7);

    const { data: holds, error: holdsError } = await supa
      .from('automation_mass_action_holds')
      .select('*')
      .eq('guild_id', guildId)
      .eq('automation_id', automationId)
      .eq('occurrence_id', occurrenceId);
    expect(holdsError).toBeNull();
    expect(holds).toHaveLength(1);
    expect(holds?.[0]).toMatchObject({
      status: 'held',
      member_count: 26,
      threshold: 25,
    });

    const { data: audits, error: auditError } = await supa
      .from('audit_logs')
      .select('action, details, occurrence_key')
      .eq('guild_id', guildId)
      .eq('action', 'automation.mass_action_held');
    expect(auditError).toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits?.[0].details).toMatchObject({ memberCount: 26, threshold: 25 });
  });

  it('allows exactly one worker to claim an approved occurrence', async () => {
    const approved = await supa
      .from('automation_mass_action_holds')
      .update({
        status: 'approved',
        approved_by: '12345678901234567',
        approved_at: new Date().toISOString(),
      })
      .eq('guild_id', guildId)
      .eq('automation_id', automationId)
      .eq('occurrence_id', occurrenceId);
    expect(approved.error).toBeNull();

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        supa.rpc('claim_approved_automation_mass_action_hold', {
          p_hold_id: null,
          p_guild_id: guildId,
        }),
      ),
    );
    // A null id proves the RPC is strict about identity but cannot test its
    // atomic winner. Read the real id and race it below.
    expect(claims.every((claim) => !claim.error && claim.data.length === 0)).toBe(true);

    const { data: row } = await supa
      .from('automation_mass_action_holds')
      .select('id')
      .eq('guild_id', guildId)
      .eq('automation_id', automationId)
      .single();
    const raced = await Promise.all(
      Array.from({ length: 8 }, () =>
        supa.rpc('claim_approved_automation_mass_action_hold', {
          p_hold_id: row!.id,
          p_guild_id: guildId,
        }),
      ),
    );
    expect(raced.filter((claim) => claim.data.length === 1)).toHaveLength(1);
    expect(raced.filter((claim) => claim.data.length === 0)).toHaveLength(7);
  });

  it('rejects malformed or below-threshold held rows at the database boundary', async () => {
    const invalid = await supa.from('automation_mass_action_holds').insert({
      ...holdPayload(),
      occurrence_id: randomUUID(),
      member_count: 1,
      member_ids: [memberIds[0]],
      threshold: 25,
    });
    expect(invalid.error?.code).toBe('23514');
  });

  it('keeps held target snapshots unavailable to anon and authenticated browser roles', async () => {
    const [anon, authenticated] = await Promise.all([
      getAnonTestClient().from('automation_mass_action_holds').select('*').eq('guild_id', guildId),
      getAuthenticatedTestClient().from('automation_mass_action_holds').select('*').eq('guild_id', guildId),
    ]);
    expect(anon.data ?? []).toHaveLength(0);
    expect(authenticated.data ?? []).toHaveLength(0);
    expect(anon.error).not.toBeNull();
    expect(authenticated.error).not.toBeNull();
  });
});
