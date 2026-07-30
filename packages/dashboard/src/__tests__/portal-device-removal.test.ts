/**
 * DELETE /api/portal/licenses/sessions/[id] — customer device sign-out.
 *
 * The security-critical part is ownership. `license_sessions` carries no
 * guild_id and no customer_id of its own — it hangs off `license_keys`. If the
 * route trusted the URL id alone, ANY customer could deactivate ANY other
 * customer's device by guessing a UUID, across guilds. So the tests below care
 * far more about who is refused than about the happy path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: { portalData: vi.fn().mockResolvedValue({ limited: false }) },
}));

import { NextRequest } from 'next/server';
import { DELETE } from '@/app/api/portal/licenses/sessions/[id]/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = 'cust-1';
const GUILD = '222222222222222222';

/**
 * Two-table stub: portal_sessions resolves the caller, license_sessions
 * resolves (or refuses) the target. `sessionRow` null models "no row matched
 * the ownership filters", which is what a cross-customer id produces.
 */
function mockDb(opts: {
  portal?: { customer_id: string; guild_id: string } | null;
  sessionRow?: { id: string; active: boolean } | null;
  updateError?: { message: string } | null;
}) {
  const updates: Record<string, unknown>[] = [];
  const eqCalls: Array<[string, unknown]> = [];

  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'gt']) chain[m] = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return chain;
    });
    chain.single = vi.fn(async () => ({
      data: table === 'portal_sessions' ? (opts.portal ?? null) : null,
      error: null,
    }));
    chain.maybeSingle = vi.fn(async () => ({
      data: table === 'license_sessions' ? (opts.sessionRow ?? null) : null,
      error: null,
    }));
    chain.update = vi.fn((row: Record<string, unknown>) => {
      updates.push(row);
      return {
        eq: vi.fn(async () => ({ error: opts.updateError ?? null })),
      };
    });
    return chain;
  });

  vi.mocked(createAdminSupabase).mockReturnValue({ from } as never);
  return { updates, eqCalls };
}

const req = (token?: string) =>
  new NextRequest('http://x/api/portal/licenses/sessions/' + SESSION_ID, {
    method: 'DELETE',
    ...(token ? { headers: { 'x-portal-token': token } } : {}),
  });

const params = (id = SESSION_ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
    vi.resetAllMocks();
  vi.mocked(rateLimits.portalData).mockResolvedValue({ limited: false } as never);
});

describe('authentication', () => {
  it('refuses a request with no portal token', async () => {
    mockDb({ portal: { customer_id: CUSTOMER, guild_id: GUILD } });
    const res = await DELETE(req(), params());
    expect(res.status).toBe(401);
  });

  it('refuses an expired or revoked session', async () => {
    mockDb({ portal: null });
    const res = await DELETE(req('tok'), params());
    expect(res.status).toBe(401);
  });

  it('refuses when rate limited', async () => {
    mockDb({ portal: { customer_id: CUSTOMER, guild_id: GUILD } });
    vi.mocked(rateLimits.portalData).mockResolvedValue({ limited: true } as never);
    const res = await DELETE(req('tok'), params());
    expect(res.status).toBe(429);
  });
});

describe('ownership', () => {
  it('scopes the lookup to the caller"s customer AND guild', async () => {
    const { eqCalls } = mockDb({
      portal: { customer_id: CUSTOMER, guild_id: GUILD },
      sessionRow: { id: SESSION_ID, active: true },
    });

    await DELETE(req('tok'), params());

    // Both parent filters must be applied — either one alone leaves a hole.
    expect(eqCalls).toContainEqual(['license_keys.customer_id', CUSTOMER]);
    expect(eqCalls).toContainEqual(['license_keys.guild_id', GUILD]);
  });

  it('404s another customer"s session without revealing it exists', async () => {
    // The ownership filters matched nothing.
    const { updates } = mockDb({
      portal: { customer_id: CUSTOMER, guild_id: GUILD },
      sessionRow: null,
    });

    const res = await DELETE(req('tok'), params());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Session not found' });
    // Nothing was written on the refused path.
    expect(updates).toHaveLength(0);
  });

  it('rejects a malformed session id before any lookup', async () => {
    mockDb({ portal: { customer_id: CUSTOMER, guild_id: GUILD } });
    const res = await DELETE(req('tok'), params('not-a-uuid'));
    expect(res.status).toBe(400);
  });
});

describe('deactivation', () => {
  it('soft-deactivates the device rather than deleting the row', async () => {
    const { updates } = mockDb({
      portal: { customer_id: CUSTOMER, guild_id: GUILD },
      sessionRow: { id: SESSION_ID, active: true },
    });

    const res = await DELETE(req('tok'), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deduped: false });
    // The row is evidence of where the licence has been used; a sign-out
    // must not destroy it.
    expect(updates).toEqual([{ active: false }]);
  });

  it('is idempotent for an already-inactive device', async () => {
    const { updates } = mockDb({
      portal: { customer_id: CUSTOMER, guild_id: GUILD },
      sessionRow: { id: SESSION_ID, active: false },
    });

    const res = await DELETE(req('tok'), params());

    // A retry after a dropped response must not read as a failure for
    // something that is already true.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deduped: true });
    expect(updates).toHaveLength(0);
  });

  it('surfaces a write failure instead of reporting success', async () => {
    mockDb({
      portal: { customer_id: CUSTOMER, guild_id: GUILD },
      sessionRow: { id: SESSION_ID, active: true },
      updateError: { message: 'deadlock detected' },
    });

    const res = await DELETE(req('tok'), params());

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
