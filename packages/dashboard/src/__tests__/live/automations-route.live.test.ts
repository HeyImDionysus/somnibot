/**
 * automations-route.live.test — drive the REAL /api/automations handlers through
 * the REAL auth guard against LOCAL Supabase (real-session harness, zero prod
 * edits). Un-gates administration-automations: a full create→list→update→delete
 * lifecycle lands real `automations` rows scoped to the owner's guild.
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

const holder: ReturnType<typeof buildNextHeadersMock> = vi.hoisted(() => ({
  cookies: async () => ({ getAll: () => [] as import('./_session-harness').CookieRecord[], get: () => undefined, set: () => {} }),
  headers: async () => ({ get: () => null, has: () => false }),
}));
vi.mock('next/headers', () => ({
  cookies: () => holder.cookies(),
  headers: () => holder.headers(),
}));

const reachable = await localSupabaseReachable(SUPA_URL);

describe.skipIf(!reachable)('LIVE: /api/automations (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-autom-${suffix}`;
  const ownerDiscordId = `e2e-owner-autom-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;
  let createdId: string;

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Automations Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('automations').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function jsonReq(method: string, body?: unknown, query = ''): import('next/server').NextRequest {
    return new Request(`http://localhost/api/automations${query}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.3.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('POST creates an automation row scoped to the guild', async () => {
    const { POST } = await import('../../app/api/automations/route');
    const res = await POST(
      jsonReq('POST', {
        name: 'E2E Welcome Greeter',
        trigger_type: 'member.joined',
        actions: [{ type: 'send_message', config: { content: 'hi' } }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; enabled: boolean; guild_id: string } };
    expect(body.success).toBe(true);
    expect(body.data.guild_id).toBe(guildId);
    expect(body.data.enabled).toBe(true);
    createdId = body.data.id;

    const { data } = await admin
      .from('automations')
      .select('name, trigger_type, enabled, guild_id')
      .eq('id', createdId)
      .maybeSingle();
    expect(data).toMatchObject({ name: 'E2E Welcome Greeter', trigger_type: 'member.joined', enabled: true, guild_id: guildId });
  });

  it('GET lists the guild automations including the created one', async () => {
    const { GET } = await import('../../app/api/automations/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ id: string; name: string }> };
    expect(body.data.some((a) => a.id === createdId && a.name === 'E2E Welcome Greeter')).toBe(true);
  });

  it('PUT toggles the automation disabled', async () => {
    const { PUT } = await import('../../app/api/automations/route');
    const res = await PUT(jsonReq('PUT', { id: createdId, enabled: false }));
    expect(res.status).toBe(200);
    const { data } = await admin.from('automations').select('enabled').eq('id', createdId).maybeSingle();
    expect(data?.enabled).toBe(false);
  });

  it('DELETE removes the automation row', async () => {
    const { DELETE } = await import('../../app/api/automations/route');
    const res = await DELETE(jsonReq('DELETE', undefined, `?id=${createdId}`));
    expect(res.status).toBe(200);
    const { data } = await admin.from('automations').select('id').eq('id', createdId).maybeSingle();
    expect(data).toBeNull();
  });

  it('denies a POST for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { POST } = await import('../../app/api/automations/route');
    const res = await POST(jsonReq('POST', { name: 'Nope', trigger_type: 'member.joined' }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
    const { count } = await admin
      .from('automations')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', guildId);
    expect(count ?? 0).toBe(0); // created one was deleted; denied one never inserted
  });
});
