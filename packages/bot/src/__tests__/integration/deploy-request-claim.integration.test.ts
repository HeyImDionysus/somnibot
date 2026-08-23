import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supabase: SupabaseClient;
const guildIds = [
  `test-deploy-claim-live-${Date.now()}`,
  `test-deploy-claim-expired-${Date.now()}`,
];

async function requestAndClaim(guildId: string) {
  const requestId = randomUUID();
  const requested = await supabase.rpc('request_server_deployment', {
    p_guild_id: guildId,
    p_request_id: requestId,
    p_roles: [],
    p_channels: [],
    p_categories: [],
    p_permission_map: {},
    p_deploy_mode: 'safe',
    p_requested_at: new Date().toISOString(),
  });
  expect(requested).toMatchObject({ error: null });
  const claimed = await supabase.rpc('claim_deploy_request', {
    p_guild_id: guildId,
    p_request_id: requestId,
  });
  expect(claimed.error).toBeNull();
  expect(claimed.data).toMatchObject({
    guild_id: guildId,
    deploy_request_id: requestId,
    deploy_status: 'running',
  });
  return claimed.data as {
    deploy_request_id: string;
    deploy_claim_token: string;
    deploy_lease_expires_at: string;
  };
}

beforeAll(async () => {
  supabase = await requireSupabase();
  const seeded = await supabase.from('guild').insert(guildIds.map((id) => ({
    id,
    name: id,
    owner_discord_id: '12345678901234567',
  })));
  if (seeded.error) throw new Error(`Guild seed failed: ${seeded.error.message}`);
});

afterAll(async () => {
  if (supabase) await supabase.from('guild').delete().in('id', guildIds);
});

describe('deployment request claim leases', () => {
  it('keeps a renewed live claim while recovering only an expired owner', async () => {
    const live = await requestAndClaim(guildIds[0]!);
    const expired = await requestAndClaim(guildIds[1]!);

    const renewed = await supabase.rpc('renew_deploy_request_claim', {
      p_guild_id: guildIds[0],
      p_request_id: live.deploy_request_id,
      p_claim_token: live.deploy_claim_token,
    });
    expect(renewed).toMatchObject({ data: true, error: null });

    const expiredWrite = await supabase.from('guild_desired_state').update({
      deploy_lease_expires_at: new Date(0).toISOString(),
    }).eq('guild_id', guildIds[1]);
    expect(expiredWrite.error).toBeNull();

    const recovered = await supabase.rpc('fail_interrupted_deploy_requests');
    expect(recovered).toMatchObject({ data: 1, error: null });

    const rows = await supabase.from('guild_desired_state')
      .select('guild_id, deploy_status, deploy_claim_token')
      .in('guild_id', guildIds);
    expect(rows.error).toBeNull();
    expect(rows.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        guild_id: guildIds[0],
        deploy_status: 'running',
        deploy_claim_token: live.deploy_claim_token,
      }),
      expect.objectContaining({
        guild_id: guildIds[1],
        deploy_status: 'failed',
        deploy_claim_token: null,
      }),
    ]));

    const staleSettlement = await supabase.rpc('settle_deploy_request', {
      p_guild_id: guildIds[1],
      p_request_id: expired.deploy_request_id,
      p_claim_token: expired.deploy_claim_token,
      p_success: true,
      p_error: null,
    });
    expect(staleSettlement).toMatchObject({ data: false, error: null });
  });
});
