import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getAnonTestClient, requireSupabase } from './helpers.js';

const claimSchema = z.object({
  status: z.enum(['claimed', 'wait', 'already_completed', 'stale_config', 'max_attempts', 'not_found']),
  intent_id: z.string().uuid().optional(),
  attempt_token: z.string().uuid().optional(),
});

let supa: SupabaseClient;
const guildId = `test-onboarding-fallback-${Date.now()}`;
const memberId = '900000000000000001';
const staleMemberId = '900000000000000002';
const retryMemberId = '900000000000000003';
const unauthorizedMemberId = '900000000000000004';
const terminatedMemberId = '900000000000000005';
const concurrentMemberId = '900000000000000006';
const leaseRaceMemberId = '900000000000000007';

beforeAll(async () => {
  supa = await requireSupabase();
  const guild = await supa.from('guild').insert({
    id: guildId,
    name: 'Onboarding fallback durability test',
    owner_discord_id: '900000000000000000',
  });
  if (guild.error) throw new Error(`Guild seed failed: ${guild.error.message}`);
  const config = await supa.from('guild_config').insert({
    guild_id: guildId,
    onboarding_enabled: true,
    member_role_id: '900000000000000010',
    fallback_mode: 'grant-after-timeout',
    fallback_timeout_minutes: 3,
  });
  if (config.error) throw new Error(`Config seed failed: ${config.error.message}`);
  const members = await supa.from('members').insert([
    { guild_id: guildId, discord_id: memberId, username: 'durable-member' },
    { guild_id: guildId, discord_id: staleMemberId, username: 'stale-member' },
    { guild_id: guildId, discord_id: retryMemberId, username: 'retry-member' },
    { guild_id: guildId, discord_id: unauthorizedMemberId, username: 'unauthorized-member' },
    { guild_id: guildId, discord_id: terminatedMemberId, username: 'terminated-member' },
    { guild_id: guildId, discord_id: concurrentMemberId, username: 'concurrent-member' },
    { guild_id: guildId, discord_id: leaseRaceMemberId, username: 'lease-race-member' },
  ]);
  if (members.error) throw new Error(`Member seed failed: ${members.error.message}`);
});

afterAll(async () => {
  if (supa) await supa.from('guild').delete().eq('id', guildId);
});

describe('durable onboarding fallback intents', () => {
  it('records intent without success provenance, then commits success only after completion', async () => {
    const claimed = await supa.rpc('claim_onboarding_fallback_intent', {
      p_guild_id: guildId,
      p_discord_id: memberId,
      p_member_role_id: '900000000000000010',
      p_timeout_minutes: 3,
      p_correlation_id: `${guildId}:${memberId}`,
      p_role_add_authorized: true,
    });
    expect(claimed.error).toBeNull();
    const claim = claimSchema.parse(claimed.data);
    expect(claim.status).toBe('claimed');
    const listed = await supa.rpc('list_onboarding_fallback_intents', { p_guild_id: guildId });
    expect(listed).toMatchObject({
      data: [expect.objectContaining({
        discord_id: memberId,
        member_role_id: '900000000000000010',
        timeout_minutes: 3,
        role_add_authorized: true,
      })],
      error: null,
    });

    const beforeCompletion = await Promise.all([
      supa.from('members').select('onboarding_completed').eq('guild_id', guildId).eq('discord_id', memberId).single(),
      supa.from('audit_logs').select('id').eq('guild_id', guildId).eq('action', 'member.onboarding_fallback_granted'),
      supa.from('alerts').select('id').eq('guild_id', guildId).eq('alert_type', 'onboarding_fallback_granted'),
    ]);
    expect(beforeCompletion[0].data?.onboarding_completed).toBe(false);
    expect(beforeCompletion[1].data).toEqual([]);
    expect(beforeCompletion[2].data).toEqual([]);

    const completed = await supa.rpc('complete_onboarding_fallback_intent', {
      p_intent_id: claim.intent_id,
      p_attempt_token: claim.attempt_token,
    });
    expect(completed).toMatchObject({ data: { status: 'completed' }, error: null });

    const afterCompletion = await Promise.all([
      supa.from('members').select('onboarding_completed').eq('guild_id', guildId).eq('discord_id', memberId).single(),
      supa.from('audit_logs').select('id').eq('guild_id', guildId).eq('action', 'member.onboarding_fallback_granted'),
      supa.from('alerts').select('id').eq('guild_id', guildId).eq('alert_type', 'onboarding_fallback_granted'),
    ]);
    expect(afterCompletion[0].data?.onboarding_completed).toBe(true);
    expect(afterCompletion[1].data).toHaveLength(1);
    expect(afterCompletion[2].data).toHaveLength(1);
    const replayed = await supa.rpc('complete_onboarding_fallback_intent', {
      p_intent_id: claim.intent_id,
      p_attempt_token: claim.attempt_token,
    });
    expect(replayed).toMatchObject({ data: { status: 'already_completed' }, error: null });
  });

  it('rejects completion after current fallback configuration changes', async () => {
    const claimed = await supa.rpc('claim_onboarding_fallback_intent', {
      p_guild_id: guildId,
      p_discord_id: staleMemberId,
      p_member_role_id: '900000000000000010',
      p_timeout_minutes: 3,
      p_correlation_id: `${guildId}:${staleMemberId}`,
      p_role_add_authorized: true,
    });
    const claim = claimSchema.parse(claimed.data);
    expect(claim.status).toBe('claimed');

    const changed = await supa.from('guild_config').update({
      fallback_mode: 'manual-review',
    }).eq('guild_id', guildId);
    expect(changed.error).toBeNull();

    const completed = await supa.rpc('complete_onboarding_fallback_intent', {
      p_intent_id: claim.intent_id,
      p_attempt_token: claim.attempt_token,
    });
    expect(completed).toMatchObject({ data: { status: 'stale_config' }, error: null });
    const cancelled = await supa.rpc('cancel_onboarding_fallback_intent', {
      p_intent_id: claim.intent_id,
      p_attempt_token: claim.attempt_token,
    });
    expect(cancelled).toMatchObject({ data: { status: 'cancelled' }, error: null });
    const persisted = await supa.from('members')
      .select('onboarding_completed')
      .eq('guild_id', guildId)
      .eq('discord_id', staleMemberId)
      .single();
    expect(persisted.data?.onboarding_completed).toBe(false);
    const restored = await supa.from('guild_config').update({
      fallback_mode: 'grant-after-timeout',
    }).eq('guild_id', guildId);
    expect(restored.error).toBeNull();
  });

  it('persists bounded role failures and refuses a fourth automatic attempt', async () => {
    let claimed = claimSchema.parse((await supa.rpc('claim_onboarding_fallback_intent', {
      p_guild_id: guildId,
      p_discord_id: retryMemberId,
      p_member_role_id: '900000000000000010',
      p_timeout_minutes: 3,
      p_correlation_id: `${guildId}:${retryMemberId}`,
      p_role_add_authorized: true,
    })).data);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const failed = await supa.rpc('fail_onboarding_fallback_attempt', {
        p_intent_id: claimed.intent_id,
        p_attempt_token: claimed.attempt_token,
        p_error: 'Discord unavailable',
      });
      expect(failed.data?.status).toBe(attempt === 3 ? 'failed' : 'retry');
      if (attempt === 3) break;

      const due = await supa.from('onboarding_fallback_intents').update({
        next_attempt_at: new Date(0).toISOString(),
      }).eq('id', claimed.intent_id);
      expect(due.error).toBeNull();
      claimed = claimSchema.parse((await supa.rpc('claim_onboarding_fallback_intent', {
        p_guild_id: guildId,
        p_discord_id: retryMemberId,
        p_member_role_id: '900000000000000010',
        p_timeout_minutes: 3,
        p_correlation_id: `${guildId}:${retryMemberId}`,
        p_role_add_authorized: true,
      })).data);
      expect(claimed.status).toBe('claimed');
    }

    const fourth = await supa.rpc('claim_onboarding_fallback_intent', {
      p_guild_id: guildId,
      p_discord_id: retryMemberId,
      p_member_role_id: '900000000000000010',
      p_timeout_minutes: 3,
      p_correlation_id: `${guildId}:${retryMemberId}`,
      p_role_add_authorized: true,
    });
    expect(fourth).toMatchObject({ data: { status: 'max_attempts' }, error: null });
  });

  it('refuses to attribute a role without durable original add authorization', async () => {
    const attemptToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const inserted = await supa.from('onboarding_fallback_intents').insert({
      guild_id: guildId,
      discord_id: unauthorizedMemberId,
      member_role_id: '900000000000000010',
      timeout_minutes: 3,
      correlation_id: `${guildId}:${unauthorizedMemberId}`,
      role_add_authorized: false,
      attempt_count: 1,
      attempt_token: attemptToken,
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(inserted.error).toBeNull();

    const completed = await supa.rpc('complete_onboarding_fallback_intent', {
      p_intent_id: (await supa.from('onboarding_fallback_intents')
        .select('id')
        .eq('guild_id', guildId)
        .eq('discord_id', unauthorizedMemberId)
        .single()).data?.id,
      p_attempt_token: attemptToken,
    });
    expect(completed).toMatchObject({ data: { status: 'role_not_authorized' }, error: null });

    const [member, audits, alerts] = await Promise.all([
      supa.from('members').select('onboarding_completed').eq('guild_id', guildId).eq('discord_id', unauthorizedMemberId).single(),
      supa.from('audit_logs').select('id').eq('guild_id', guildId).eq('target_id', unauthorizedMemberId),
      supa.from('alerts').select('id').eq('guild_id', guildId).contains('metadata', { member_id: unauthorizedMemberId }),
    ]);
    expect(member.data?.onboarding_completed).toBe(false);
    expect(audits.data).toEqual([]);
    expect(alerts.data).toEqual([]);
  });

  it('terminates native-completion state without emitting fallback success', async () => {
    const claimed = await supa.rpc('claim_onboarding_fallback_intent', {
      p_guild_id: guildId,
      p_discord_id: terminatedMemberId,
      p_member_role_id: '900000000000000010',
      p_timeout_minutes: 3,
      p_correlation_id: `${guildId}:${terminatedMemberId}`,
      p_role_add_authorized: true,
    });
    const claim = claimSchema.parse(claimed.data);
    expect(claim.status).toBe('claimed');

    const terminated = await supa.rpc('terminate_onboarding_fallback_intent', {
      p_guild_id: guildId,
      p_discord_id: terminatedMemberId,
      p_reason: 'native_onboarding_completed',
    });
    expect(terminated).toMatchObject({ data: { status: 'cancelled' }, error: null });
    const completion = await supa.rpc('complete_onboarding_fallback_intent', {
      p_intent_id: claim.intent_id,
      p_attempt_token: claim.attempt_token,
    });
    expect(completion).toMatchObject({ data: { status: 'lost_claim' }, error: null });

    const [member, audits, alerts] = await Promise.all([
      supa.from('members').select('onboarding_completed').eq('guild_id', guildId).eq('discord_id', terminatedMemberId).single(),
      supa.from('audit_logs').select('id').eq('guild_id', guildId).eq('target_id', terminatedMemberId),
      supa.from('alerts').select('id').eq('guild_id', guildId).contains('metadata', { member_id: terminatedMemberId }),
    ]);
    expect(member.data?.onboarding_completed).toBe(false);
    expect(audits.data).toEqual([]);
    expect(alerts.data).toEqual([]);
  });

  it('serializes concurrent claim and completion without a deadlock', async () => {
    const initial = claimSchema.parse((await supa.rpc('claim_onboarding_fallback_intent', {
      p_guild_id: guildId,
      p_discord_id: concurrentMemberId,
      p_member_role_id: '900000000000000010',
      p_timeout_minutes: 3,
      p_correlation_id: `${guildId}:${concurrentMemberId}`,
      p_role_add_authorized: true,
    })).data);
    expect(initial.status).toBe('claimed');
    const expired = await supa.from('onboarding_fallback_intents').update({
      lease_expires_at: new Date(0).toISOString(),
      next_attempt_at: new Date(0).toISOString(),
    }).eq('id', initial.intent_id);
    expect(expired.error).toBeNull();

    const concurrent = Promise.all([
      supa.rpc('claim_onboarding_fallback_intent', {
        p_guild_id: guildId,
        p_discord_id: concurrentMemberId,
        p_member_role_id: '900000000000000010',
        p_timeout_minutes: 3,
        p_correlation_id: `${guildId}:${concurrentMemberId}`,
        p_role_add_authorized: true,
      }),
      supa.rpc('complete_onboarding_fallback_intent', {
        p_intent_id: initial.intent_id,
        p_attempt_token: initial.attempt_token,
      }),
    ]);
    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 5_000);
    });
    const outcome = await Promise.race([concurrent, timeout]);
    expect(outcome).not.toBe('timeout');
    if (outcome === 'timeout') return;
    expect(outcome[0].error).toBeNull();
    expect(outcome[1].error).toBeNull();
  });

  it('accepts only the winning completion token after lease expiry', async () => {
    const first = claimSchema.parse((await supa.rpc('claim_onboarding_fallback_intent', {
      p_guild_id: guildId,
      p_discord_id: leaseRaceMemberId,
      p_member_role_id: '900000000000000010',
      p_timeout_minutes: 3,
      p_correlation_id: `${guildId}:${leaseRaceMemberId}`,
      p_role_add_authorized: true,
    })).data);
    expect(first.status).toBe('claimed');
    const expired = await supa.from('onboarding_fallback_intents').update({
      lease_expires_at: new Date(0).toISOString(),
      next_attempt_at: new Date(0).toISOString(),
    }).eq('id', first.intent_id);
    expect(expired.error).toBeNull();

    const second = claimSchema.parse((await supa.rpc('claim_onboarding_fallback_intent', {
      p_guild_id: guildId,
      p_discord_id: leaseRaceMemberId,
      p_member_role_id: '900000000000000010',
      p_timeout_minutes: 3,
      p_correlation_id: `${guildId}:${leaseRaceMemberId}`,
      p_role_add_authorized: false,
    })).data);
    expect(second.status).toBe('claimed');
    expect(second.attempt_token).not.toBe(first.attempt_token);

    const winningCompletion = await supa.rpc('complete_onboarding_fallback_intent', {
      p_intent_id: second.intent_id,
      p_attempt_token: second.attempt_token,
    });
    expect(winningCompletion).toMatchObject({ data: { status: 'completed' }, error: null });
    const staleCompletion = await supa.rpc('complete_onboarding_fallback_intent', {
      p_intent_id: first.intent_id,
      p_attempt_token: first.attempt_token,
    });
    expect(staleCompletion).toMatchObject({ data: { status: 'lost_claim' }, error: null });
    const winnerReplay = await supa.rpc('complete_onboarding_fallback_intent', {
      p_intent_id: second.intent_id,
      p_attempt_token: second.attempt_token,
    });
    expect(winnerReplay).toMatchObject({ data: { status: 'already_completed' }, error: null });
  });

  it('denies browser roles direct table and RPC access', async () => {
    const anon = getAnonTestClient();
    const tableRead = await anon.from('onboarding_fallback_intents').select('id').limit(1);
    expect(tableRead.error).not.toBeNull();

    const rpcCall = await anon.rpc('list_onboarding_fallback_intents', { p_guild_id: guildId });
    expect(rpcCall.error).not.toBeNull();
    const terminateCall = await anon.rpc('terminate_onboarding_fallback_intent', {
      p_guild_id: guildId,
      p_discord_id: memberId,
      p_reason: 'unauthorized',
    });
    expect(terminateCall.error).not.toBeNull();
  });
});
