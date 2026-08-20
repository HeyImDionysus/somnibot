import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { armDashboardLiveEnv, localSupabaseReachable } from './_session-harness';

const supabaseUrl = armDashboardLiveEnv();
const reachable = await localSupabaseReachable(supabaseUrl);

describe.skipIf(!reachable)('LIVE: portal session atomicity', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-portal-session-${suffix}`;
  const discordId = `e2e-portal-customer-${suffix}`;
  let admin: SupabaseClient | null = null;
  let customerId = '';

  function activeAdmin(): SupabaseClient {
    if (admin === null) throw new Error('live admin client is unavailable');
    return admin;
  }

  beforeAll(async () => {
    admin = createClient(
      supabaseUrl,
      process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const client = activeAdmin();
    const guild = await client.from('guild').insert({
      id: guildId,
      name: 'Portal Session Atomicity',
      owner_discord_id: discordId,
    });
    if (guild.error) throw guild.error;
    const customer = await client.from('customers').insert({
      guild_id: guildId,
      discord_id: discordId,
      discord_username: 'portal-session-customer',
    }).select('id').single();
    if (customer.error || !customer.data?.id) throw customer.error ?? new Error('customer insert returned no id');
    customerId = customer.data.id;
  });

  afterAll(async () => {
    if (admin === null) return;
    await admin.from('portal_sessions').delete().eq('customer_id', customerId);
    await admin.from('customers').delete().eq('id', customerId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  it('caps concurrent issuance at three and gives one concurrent logout the transition', async () => {
    const client = activeAdmin();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const tokenHashes = Array.from({ length: 4 }, (_, index) => `atomic-token-${suffix}-${index}`);
    const issued = await Promise.all(tokenHashes.map((tokenHash) => client.rpc(
      'issue_portal_session_atomic',
      {
        p_guild_id: guildId,
        p_customer_id: customerId,
        p_token_hash: tokenHash,
        p_discord_id: discordId,
        p_expires_at: expiresAt,
        p_ip_address: '198.51.100.10',
        p_user_agent: 'portal-atomicity-test',
        p_max_sessions: 3,
      },
    )));

    expect(issued.every((result) => result.error === null && typeof result.data === 'string')).toBe(true);
    const active = await client
      .from('portal_sessions')
      .select('id, token_hash')
      .eq('customer_id', customerId)
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString());
    expect(active.error).toBeNull();
    expect(active.data).toHaveLength(3);

    const logoutTokenHash = active.data?.[0]?.token_hash;
    if (!logoutTokenHash) throw new Error('active session readback returned no token hash');
    const logout = await Promise.all([
      client.rpc('revoke_portal_session_atomic', { p_token_hash: logoutTokenHash }),
      client.rpc('revoke_portal_session_atomic', { p_token_hash: logoutTokenHash }),
    ]);
    expect(logout.every((result) => result.error === null)).toBe(true);
    expect(logout.flatMap((result) => Array.isArray(result.data) ? result.data : [])).toHaveLength(1);
  }, 30_000);
});
