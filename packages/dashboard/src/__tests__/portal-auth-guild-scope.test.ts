/**
 * POST /api/portal/auth must scope the customer lookup to the target guild.
 *
 * Regression guard: the lookup was `.eq('discord_id', id).limit(1).single()` with
 * no guild filter, so a buyer who is a customer in >=2 guilds (customers is
 * UNIQUE(discord_id, guild_id)) bound their portal session — and every downstream
 * orders/licenses/downloads read — to an arbitrary, possibly wrong, guild.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    portalAuth: vi.fn(async () => ({ limited: false, retryAfterMs: 0 })),
    portalDashboardSession: vi.fn(async () => ({ limited: false, retryAfterMs: 0 })),
    portalData: vi.fn(async () => ({ limited: false, retryAfterMs: 0 })),
  },
}));
vi.mock('@/lib/api/require-owner', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/discord-runtime-config', () => ({
  getDiscordOAuthRuntimeConfig: vi.fn(async () => ({
    applicationId: 'app-id',
    clientSecret: 'secret',
    sources: { applicationId: 'env', clientSecret: 'env' },
  })),
}));

import { DELETE, POST } from '@/app/api/portal/auth/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { TRUSTED_PROXY_HOPS_ENV } from '@/lib/api/client-ip';
import { requireAuth } from '@/lib/api/require-owner';
import { rateLimits } from '@/lib/api/rate-limit';

// The same Discord identity is a customer in BOTH guilds.
const CUSTOMERS: Record<string, { id: string; guild_id: string; discord_id: string }> = {
  'guild-A': { id: 'cust-A', guild_id: 'guild-A', discord_id: 'discord-user-1' },
  'guild-B': { id: 'cust-B', guild_id: 'guild-B', discord_id: 'discord-user-1' },
};

let insertedSession: Record<string, unknown> | null = null;
const originalHops = process.env[TRUSTED_PROXY_HOPS_ENV];

function makeAdmin() {
  const guildConfigChain: any = {
    select: () => guildConfigChain,
    eq: () => guildConfigChain,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'issue_portal_session_atomic') {
        return { data: null, error: { message: `unexpected RPC ${name}` } };
      }
      insertedSession = {
        guild_id: args.p_guild_id,
        customer_id: args.p_customer_id,
        discord_id: args.p_discord_id,
        ip_address: args.p_ip_address,
      };
      return { data: '11111111-1111-4111-8111-111111111111', error: null };
    },
    from: (table: string) => {
      if (table === 'audit_logs') {
        // Append-only audit writer — a separate table; must not clobber
        // insertedSession (the portal_sessions insert we assert on).
        return { insert: async () => ({ error: null }) };
      }
      if (table === 'customers') {
        let guild = '';
        const chain: any = {
          select: () => chain,
          eq: (col: string, val: string) => { if (col === 'guild_id') guild = val; return chain; },
          maybeSingle: async () => ({ data: CUSTOMERS[guild] ?? null, error: null }),
        };
        return chain;
      }
      if (table === 'guild_config') return guildConfigChain;
      // portal_sessions
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        gt: () => chain,
        order: () => chain,
        limit: async () => ({ data: [], error: null }),
        insert: (row: Record<string, unknown>) => { insertedSession = row; return { error: null }; },
      };
      return chain;
    },
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('https://dash.example/api/portal/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://dash.example', 'x-forwarded-for': '1.2.3.4' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockReset();
  vi.mocked(rateLimits.portalAuth).mockReset().mockResolvedValue({
    limited: false,
    remaining: 9,
    retryAfterMs: 0,
  });
  vi.mocked(rateLimits.portalDashboardSession).mockReset().mockResolvedValue({
    limited: false,
    remaining: 5,
    retryAfterMs: 0,
  });
  vi.mocked(rateLimits.portalData).mockReset().mockResolvedValue({
    limited: false,
    remaining: 29,
    retryAfterMs: 0,
  });
  insertedSession = null;
  (createAdminSupabase as any).mockReturnValue(makeAdmin());
  process.env.DISCORD_APPLICATION_ID = 'app-id';
  process.env.DISCORD_CLIENT_SECRET = 'secret';
  process.env[TRUSTED_PROXY_HOPS_ENV] = '1';
  // Discord OAuth: token exchange, then /users/@me → the same identity.
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'tok', token_type: 'Bearer' }) } as any;
    if (u.includes('/users/@me')) return { ok: true, json: async () => ({ id: 'discord-user-1', username: 'buyer' }) } as any;
    return { ok: false, json: async () => ({}) } as any;
  }) as any;
});

afterEach(() => {
  if (originalHops === undefined) delete process.env[TRUSTED_PROXY_HOPS_ENV];
  else process.env[TRUSTED_PROXY_HOPS_ENV] = originalHops;
});

describe('POST /api/portal/auth guild scoping', () => {
  it('binds the session to the TARGET guild, not an arbitrary one', async () => {
    const res = await POST(makeRequest({ action: 'login', code: 'oauth-code', guild_id: 'guild-B' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.customer_id).toBe('cust-B'); // guild-B's customer, NOT guild-A's cust-A
    expect(insertedSession).toMatchObject({ guild_id: 'guild-B', customer_id: 'cust-B' });
  });

  it('rejects with 404 when the identity is not a customer in the target guild', async () => {
    const res = await POST(makeRequest({ action: 'login', code: 'oauth-code', guild_id: 'guild-C' }));
    expect(res.status).toBe(404);
    expect(insertedSession).toBeNull(); // no session created for the wrong tenant
  });

  it('rejects when guild_id is missing (schema requires it)', async () => {
    const res = await POST(makeRequest({ action: 'login', code: 'oauth-code' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(insertedSession).toBeNull();
  });

  it('uses the existing dashboard Discord identity without another OAuth exchange', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      ok: true,
      userId: 'dashboard-user-1',
      discordId: 'discord-user-1',
    });
    const fetchSpy = vi.mocked(global.fetch);

    const res = await POST(makeRequest({
      action: 'dashboard_session',
      guild_id: 'guild-B',
    }));

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(insertedSession).toMatchObject({
      guild_id: 'guild-B',
      customer_id: 'cust-B',
      discord_id: 'discord-user-1',
    });
  });

  it('does not mint a portal session without a valid dashboard session', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });

    const res = await POST(makeRequest({
      action: 'dashboard_session',
      guild_id: 'guild-B',
    }));

    expect(res.status).toBe(401);
    expect(insertedSession).toBeNull();
  });

  it('rate-limits unauthenticated exchange attempts before session lookup or audit writes', async () => {
    vi.mocked(rateLimits.portalAuth).mockResolvedValueOnce({
      limited: true,
      remaining: 0,
      retryAfterMs: 60_000,
    });

    const res = await POST(makeRequest({
      action: 'dashboard_session',
      guild_id: 'guild-B',
    }));

    expect(res.status).toBe(429);
    expect(requireAuth).not.toHaveBeenCalled();
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(insertedSession).toBeNull();
  });

  it('rate-limits malformed payloads before parsing their bodies', async () => {
    vi.mocked(rateLimits.portalAuth).mockResolvedValueOnce({
      limited: true,
      remaining: 0,
      retryAfterMs: 60_000,
    });
    const request = new NextRequest('https://dash.example/api/portal/auth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://dash.example',
        'x-forwarded-for': '1.2.3.4',
      },
      body: '{malformed-json',
    });

    const res = await POST(request);

    expect(res.status).toBe(429);
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it('confines local launcher exchanges to its configured guilds', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      ok: true,
      userId: 'local-owner',
      discordId: 'discord-user-1',
      localGuildIds: ['guild-A'],
    });

    const res = await POST(makeRequest({
      action: 'dashboard_session',
      guild_id: 'guild-B',
    }));

    expect(res.status).toBe(403);
    expect(insertedSession).toBeNull();
  });

  it('rejects cross-origin dashboard session exchanges before minting a token', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      ok: true,
      userId: 'dashboard-user-1',
      discordId: 'discord-user-1',
    });

    const res = await POST(new NextRequest('https://dash.example/api/portal/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ action: 'dashboard_session', guild_id: 'guild-B' }),
    }));

    expect(res.status).toBe(403);
    expect(requireAuth).not.toHaveBeenCalled();
    expect(insertedSession).toBeNull();
  });
});

/**
 * The address recorded on a portal login is not just a rate-limit bucket — it is
 * persisted as `portal_sessions.ip_address` and written into the commerce audit
 * trail, which is the record you reach for when investigating account takeover.
 *
 * The route previously read index 0 of X-Forwarded-For, i.e. whatever the caller
 * put there. That meant an attacker could BOTH rotate the header for a fresh
 * bucket against the 10-per-5-minutes brute-force limit, AND write an address of
 * their choosing into the evidence. These pin both halves shut.
 */
describe('POST /api/portal/auth — recorded client IP cannot be forged', () => {
  function loginWith(forwardedFor: string) {
    return POST(new NextRequest('https://dash.example/api/portal/auth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://dash.example',
        'x-forwarded-for': forwardedFor,
      },
      body: JSON.stringify({ action: 'login', code: 'oauth-code', guild_id: 'guild-B' }),
    }));
  }

  it('persists the proxy-observed address, not the caller-supplied prefix', async () => {
    const res = await loginWith('9.9.9.9, 198.51.100.2');

    expect(res.status).toBe(200);
    expect(insertedSession).toMatchObject({ ip_address: '198.51.100.2' });
    // The forged value must not reach the stored record at all.
    expect(insertedSession?.ip_address).not.toBe('9.9.9.9');
  });

  it('records the same address however the caller rewrites the prefix', async () => {
    const recorded = new Set<unknown>();
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      insertedSession = null;
      await loginWith(`${forged}, 198.51.100.2`);
      recorded.add(
        (insertedSession as Record<string, unknown> | null)?.ip_address,
      );
    }

    expect(recorded.size, 'forged prefixes must not produce distinct audit addresses').toBe(1);
    expect([...recorded][0]).toBe('198.51.100.2');
  });
});

describe('DELETE /api/portal/auth', () => {
  it('reports and audits exactly one successful transition for concurrent sign out', async () => {
    let active = true;
    let auditCount = 0;
    const logoutAdmin = {
      rpc: async () => {
        if (!active) return { data: [], error: null };
        active = false;
        return {
          data: [{
            id: 'session-1',
            guild_id: 'guild-B',
            customer_id: 'cust-B',
            discord_id: 'discord-user-1',
          }],
          error: null,
        };
      },
      from: () => ({
        upsert: async () => {
          auditCount += 1;
          return { error: null };
        },
      }),
    };
    vi.mocked(createAdminSupabase).mockReturnValue(
      logoutAdmin as unknown as ReturnType<typeof createAdminSupabase>,
    );

    const request = () => new NextRequest('https://dash.example/api/portal/auth', {
      method: 'DELETE',
      headers: { 'x-portal-token': 'current-session-token' },
    });
    const responses = await Promise.all([DELETE(request()), DELETE(request())]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(auditCount).toBe(1);
    expect(rateLimits.portalData).not.toHaveBeenCalled();
  });
});
