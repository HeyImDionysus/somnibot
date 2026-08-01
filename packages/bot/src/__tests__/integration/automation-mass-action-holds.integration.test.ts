import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MassActionHoldService } from '../../features/automations/mass-action-hold.js';
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

  it('turns an execution interrupted by process exit into visible failed evidence', async () => {
    const interruptedOccurrence = randomUUID();
    const inserted = await supa.from('automation_mass_action_holds').insert({
      ...holdPayload(),
      occurrence_id: interruptedOccurrence,
    }).select('id').single();
    expect(inserted.error).toBeNull();

    const approved = await supa.from('automation_mass_action_holds').update({
      status: 'approved',
      approved_by: '12345678901234567',
      approved_at: new Date().toISOString(),
    }).eq('id', inserted.data!.id);
    expect(approved.error).toBeNull();
    const claimed = await supa.rpc('claim_approved_automation_mass_action_hold', {
      p_hold_id: inserted.data!.id,
      p_guild_id: guildId,
    });
    expect(claimed.data).toHaveLength(1);
    const expired = await supa.from('automation_mass_action_holds').update({
      execution_lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
    }).eq('id', inserted.data!.id);
    expect(expired.error).toBeNull();

    const service = new MassActionHoldService(supa, { id: guildId } as never);
    await service.failInterruptedExecutions();

    const reconciled = await supa.from('automation_mass_action_holds')
      .select('status, last_error')
      .eq('id', inserted.data!.id)
      .single();
    expect(reconciled.error).toBeNull();
    expect(reconciled.data?.status).toBe('failed');
    expect(reconciled.data?.last_error).toContain('lease expired');
  });

  it('does not fail another worker while its execution lease is live', async () => {
    const inserted = await supa.from('automation_mass_action_holds').insert({
      ...holdPayload(),
      occurrence_id: randomUUID(),
      status: 'approved',
      approved_by: '12345678901234567',
      approved_at: new Date().toISOString(),
    }).select('id').single();
    expect(inserted.error).toBeNull();
    const claimed = await supa.rpc('claim_approved_automation_mass_action_hold', {
      p_hold_id: inserted.data!.id,
      p_guild_id: guildId,
      p_owner_token: 'live-worker',
    });
    expect(claimed.data).toHaveLength(1);

    const service = new MassActionHoldService(supa, { id: guildId } as never);
    await service.failInterruptedExecutions();

    const row = await supa.from('automation_mass_action_holds')
      .select('status, execution_owner_token')
      .eq('id', inserted.data!.id)
      .single();
    expect(row.data).toMatchObject({
      status: 'executing',
      execution_owner_token: 'live-worker',
    });
  });

  it('renews a lease only for its exact execution owner', async () => {
    const inserted = await supa.from('automation_mass_action_holds').insert({
      ...holdPayload(),
      occurrence_id: randomUUID(),
      status: 'approved',
      approved_by: '12345678901234567',
      approved_at: new Date().toISOString(),
    }).select('id').single();
    expect(inserted.error).toBeNull();
    const claimed = await supa.rpc('claim_approved_automation_mass_action_hold', {
      p_hold_id: inserted.data!.id,
      p_guild_id: guildId,
      p_owner_token: 'lease-owner',
    });
    expect(claimed.data).toHaveLength(1);

    const wrongOwner = await supa.rpc('renew_automation_mass_action_hold_lease', {
      p_hold_id: inserted.data!.id,
      p_guild_id: guildId,
      p_owner_token: 'different-owner',
    });
    const exactOwner = await supa.rpc('renew_automation_mass_action_hold_lease', {
      p_hold_id: inserted.data!.id,
      p_guild_id: guildId,
      p_owner_token: 'lease-owner',
    });
    expect(wrongOwner).toMatchObject({ data: false, error: null });
    expect(exactOwner).toMatchObject({ data: true, error: null });
  });

  it('prunes only old terminal hold snapshots', async () => {
    const oldId = randomUUID();
    const recentId = randomUUID();
    const inserted = await supa.from('automation_mass_action_holds').insert([
      {
        ...holdPayload(),
        occurrence_id: randomUUID(),
        id: oldId,
        status: 'failed',
        completed_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        updated_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      },
      {
        ...holdPayload(),
        occurrence_id: randomUUID(),
        id: recentId,
        status: 'failed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    expect(inserted.error).toBeNull();

    const service = new MassActionHoldService(supa, { id: guildId } as never);
    expect(await service.pruneTerminal(30)).toBeGreaterThanOrEqual(1);

    const remaining = await supa.from('automation_mass_action_holds')
      .select('id')
      .in('id', [oldId, recentId]);
    expect(remaining.error).toBeNull();
    expect(remaining.data?.map((row) => row.id)).toEqual([recentId]);
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
