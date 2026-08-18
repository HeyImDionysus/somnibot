import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import {
  armDashboardLiveEnv,
  buildNextHeadersMock,
  createOwnerSession,
  localSupabaseReachable,
  type OwnerSession,
} from './_session-harness';

const supabaseUrl = armDashboardLiveEnv();

const holder: ReturnType<typeof buildNextHeadersMock> = vi.hoisted(() => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
  headers: async () => ({ get: () => null, has: () => false }),
}));
vi.mock('next/headers', () => ({
  cookies: () => holder.cookies(),
  headers: () => holder.headers(),
}));

const reachable = await localSupabaseReachable(supabaseUrl);

describe.skipIf(!reachable)('LIVE: shared dashboard authorization denials', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-denial-${suffix}`;
  const ownerDiscordId = `e2e-owner-denial-${suffix}`;
  const memberDiscordId = `e2e-member-denial-${suffix}`;
  let admin: SupabaseClient | null = null;
  let session: OwnerSession;

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
    await client.from('guild').upsert(
      { id: guildId, name: 'E2E Dashboard Denial Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    const finance = await client
      .from('dashboard_roles')
      .select('id')
      .eq('guild_id', guildId)
      .eq('name', 'finance')
      .single();
    if (!finance.data?.id) throw new Error('missing seeded finance role');

    session = await createOwnerSession(memberDiscordId);
    await client
      .from('dashboard_user_roles')
      .delete()
      .eq('guild_id', guildId)
      .eq('discord_id', memberDiscordId);
    await client.from('dashboard_user_roles').upsert(
      {
        guild_id: guildId,
        discord_id: memberDiscordId,
        role_id: finance.data.id,
        assigned_by: ownerDiscordId,
      },
      { onConflict: 'guild_id,discord_id,role_id' },
    );

    const base = buildNextHeadersMock(session, guildId);
    holder.cookies = base.cookies;
    holder.headers = async () => {
      const requestHeaders = await base.headers();
      return {
        get: (name: string) => {
          if (name === 'x-somnibot-request-route') return '/api/incidents';
          if (name === 'x-somnibot-request-method') return 'GET';
          if (name === 'x-somnibot-request-occurrence-id') return `dashboard-denial-${suffix}`;
          return requestHeaders.get(name);
        },
        has: (name: string) => requestHeaders.has(name),
      };
    };
  });

  afterAll(async () => {
    if (admin === null) return;
    await admin.from('audit_logs').delete().eq('guild_id', guildId);
    await admin.from('dashboard_user_roles').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  it('returns 403 without a content leak and persists one denial', async () => {
    // Given
    const { GET } = await import('../../app/api/incidents/route');
    const request = new NextRequest('http://localhost/api/incidents?pageSize=1');

    // When
    const response = await GET(request);

    // Then
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    const audit = await activeAdmin()
      .from('audit_logs')
      .select('actor_id, action, details, success, occurrence_key')
      .eq('guild_id', guildId)
      .eq('action', 'dashboard.authorization_denied');
    expect(audit.error).toBeNull();
    expect(audit.data).toEqual([
      expect.objectContaining({
        actor_id: memberDiscordId,
        success: false,
        occurrence_key: `dashboard.authorization_denied:dashboard-denial-${suffix}`,
        details: expect.objectContaining({
          route: '/api/incidents',
          method: 'GET',
          required_permission: 'dashboard.manage_incidents',
          reason: 'permission_denied',
          status: 403,
        }),
      }),
    ]);
  }, 15_000);

  it('preserves the 403 body when audit persistence returns a forced failure', async () => {
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
      if (requestUrl.includes('/rest/v1/audit_logs') && init?.method === 'POST') {
        return new Response(JSON.stringify({ message: 'forced audit persistence failure' }), { status: 500 });
      }
      return nativeFetch(input, init);
    });

    try {
      const { GET } = await import('../../app/api/incidents/route');
      const response = await GET(new NextRequest('http://localhost/api/incidents?pageSize=1'));
      const body = await response.text();

      expect(response.status).toBe(403);
      expect(body).toBe('{"error":"Forbidden"}');
      expect(body).not.toContain('/api/incidents');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('dedupes repeated unauthenticated denials with the same unscoped occurrence', async () => {
    const savedCookies = holder.cookies;
    const savedHeaders = holder.headers;
    const occurrenceId = 'dashboard-anonymous-denial-live-proof-v1';
    holder.cookies = async () => ({ getAll: () => [], get: () => undefined, set: () => {} });
    holder.headers = async () => {
      const requestHeaders = await savedHeaders();
      return {
        get: (name: string) =>
          name === 'x-somnibot-request-occurrence-id'
            ? occurrenceId
            : requestHeaders.get(name),
        has: (name: string) => requestHeaders.has(name),
      };
    };

    try {
      const { GET } = await import('../../app/api/incidents/route');
      const request = new NextRequest('http://localhost/api/incidents?pageSize=1');
      const first = await GET(request);
      const second = await GET(request);

      expect(first.status).toBe(401);
      expect(await first.json()).toEqual({ error: 'Unauthorized' });
      expect(second.status).toBe(401);
      expect(await second.json()).toEqual({ error: 'Unauthorized' });

      const audit = await activeAdmin()
        .from('audit_logs')
        .select('actor_id, details, unscoped_occurrence_key')
        .eq('unscoped_occurrence_key', `dashboard.authorization_denied:${occurrenceId}`);
      expect(audit.error).toBeNull();
      expect(audit.data).toHaveLength(1);
      expect(audit.data?.[0]).toEqual(expect.objectContaining({
        actor_id: 'anonymous',
        details: expect.objectContaining({ status: 401, reason: 'unauthenticated' }),
      }));
    } finally {
      holder.cookies = savedCookies;
      holder.headers = savedHeaders;
    }
  }, 15_000);
});
