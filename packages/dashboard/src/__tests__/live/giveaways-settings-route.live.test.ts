/**
 * giveaways-settings-route.live.test — drive the REAL /api/giveaways/settings
 * handlers through the REAL auth guard against LOCAL Supabase (real-session
 * harness, zero prod edits). Un-gates community-giveaways dashboard config.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  armDashboardLiveEnv,
  localSupabaseReachable,
  createOwnerSession,
  buildNextHeadersMock,
  type OwnerSession,
} from './_session-harness';

const SUPA_URL = armDashboardLiveEnv();

const holder = vi.hoisted(() => ({
  cookies: async () => ({ getAll: () => [] as unknown[], get: () => undefined, set: () => {} }),
  headers: async () => ({ get: () => null, has: () => false }),
}));
vi.mock('next/headers', () => ({
  cookies: () => holder.cookies(),
  headers: () => holder.headers(),
}));

const reachable = await localSupabaseReachable(SUPA_URL);

describe.skipIf(!reachable)('LIVE: /api/giveaways/settings (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-giv-${suffix}`;
  const ownerDiscordId = `e2e-owner-giv-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Giveaways Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('guild_config').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function jsonReq(method: string, body?: unknown): import('next/server').NextRequest {
    return new Request(`http://localhost/api/giveaways/settings`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.8.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('PUT saves giveaway defaults into guild_config', async () => {
    const { PUT } = await import('../../app/api/giveaways/settings/route');
    const res = await PUT(jsonReq('PUT', {
      giveaway_default_winner_count: 3,
      giveaway_dm_winners: false,
      giveaway_entry_button_label: 'Enter the draw!',
      giveaway_winner_announcement_style: 'plain',
    }));
    expect(res.status).toBe(200);

    const { data } = await admin
      .from('guild_config')
      .select('giveaway_default_winner_count, giveaway_dm_winners, giveaway_entry_button_label, giveaway_winner_announcement_style')
      .eq('guild_id', guildId)
      .maybeSingle();
    expect(data).toMatchObject({
      giveaway_default_winner_count: 3,
      giveaway_dm_winners: false,
      giveaway_entry_button_label: 'Enter the draw!',
      giveaway_winner_announcement_style: 'plain',
    });
  });

  it('GET returns the saved giveaway config', async () => {
    const { GET } = await import('../../app/api/giveaways/settings/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { giveaway_default_winner_count: number; giveaway_winner_announcement_style: string } };
    expect(body.data.giveaway_default_winner_count).toBe(3);
    expect(body.data.giveaway_winner_announcement_style).toBe('plain');
  });

  it('denies a PUT for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { PUT } = await import('../../app/api/giveaways/settings/route');
    const res = await PUT(jsonReq('PUT', { giveaway_default_winner_count: 9 }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
    const { data } = await admin.from('guild_config').select('giveaway_default_winner_count').eq('guild_id', guildId).maybeSingle();
    expect(data?.giveaway_default_winner_count).toBe(3);
  });
});
