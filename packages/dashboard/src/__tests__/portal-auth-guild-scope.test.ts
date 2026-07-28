/**
 * POST /api/portal/auth must scope the customer lookup to the target guild.
 *
 * Regression guard: the lookup was `.eq('discord_id', id).limit(1).single()` with
 * no guild filter, so a buyer who is a customer in >=2 guilds (customers is
 * UNIQUE(discord_id, guild_id)) bound their portal session — and every downstream
 * orders/licenses/downloads read — to an arbitrary, possibly wrong, guild.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: { portalAuth: vi.fn(async () => ({ limited: false, retryAfterMs: 0 })) },
}));

import { POST } from '@/app/api/portal/auth/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { TRUSTED_PROXY_HOPS_ENV } from '@/lib/api/client-ip';

// The same Discord identity is a customer in BOTH guilds.
const CUSTOMERS: Record<string, { id: string; guild_id: string; discord_id: string }> = {
  'guild-A': { id: 'cust-A', guild_id: 'guild-A', discord_id: 'discord-user-1' },
  'guild-B': { id: 'cust-B', guild_id: 'guild-B', discord_id: 'discord-user-1' },
};

let insertedSession: Record<string, unknown> | null = null;
const originalHops = process.env[TRUSTED_PROXY_HOPS_ENV];

function makeAdmin() {
  return {
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
      recorded.add(insertedSession?.ip_address);
    }

    expect(recorded.size, 'forged prefixes must not produce distinct audit addresses').toBe(1);
    expect([...recorded][0]).toBe('198.51.100.2');
  });
});
