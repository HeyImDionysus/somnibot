/**
 * POST /api/portal/auth must scope the customer lookup to the target guild.
 *
 * Regression guard: the lookup was `.eq('discord_id', id).limit(1).single()` with
 * no guild filter, so a buyer who is a customer in >=2 guilds (customers is
 * UNIQUE(discord_id, guild_id)) bound their portal session — and every downstream
 * orders/licenses/downloads read — to an arbitrary, possibly wrong, guild.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: { portalAuth: vi.fn(async () => ({ limited: false, retryAfterMs: 0 })) },
}));

import { POST } from '@/app/api/portal/auth/route';
import { createAdminSupabase } from '@/lib/supabase/admin';

// The same Discord identity is a customer in BOTH guilds.
const CUSTOMERS: Record<string, { id: string; guild_id: string; discord_id: string }> = {
  'guild-A': { id: 'cust-A', guild_id: 'guild-A', discord_id: 'discord-user-1' },
  'guild-B': { id: 'cust-B', guild_id: 'guild-B', discord_id: 'discord-user-1' },
};

let insertedSession: Record<string, unknown> | null = null;

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
  // Discord OAuth: token exchange, then /users/@me → the same identity.
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'tok', token_type: 'Bearer' }) } as any;
    if (u.includes('/users/@me')) return { ok: true, json: async () => ({ id: 'discord-user-1', username: 'buyer' }) } as any;
    return { ok: false, json: async () => ({}) } as any;
  }) as any;
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
