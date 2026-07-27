/**
 * POST /api/portal/licenses/[id]/rotate — customer-initiated key rotation.
 *
 * The `license_rotate_key` RPC has existed and worked for a while; nothing
 * reachable called it, so a customer whose key leaked had to contact the
 * seller and wait.
 *
 * The properties worth pinning are about the SECRET, not the happy path:
 *   - the new plaintext key never appears in the HTTP response;
 *   - only its hash is handed to the database;
 *   - it is delivered down the existing audited DM path, not a new one;
 *   - a replayed rotation does not mint a second key;
 *   - a failed delivery is reported precisely, because the old key is already
 *     dead and a blanket "success" would be a lie.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: { portalRotate: vi.fn().mockResolvedValue({ limited: false }) },
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/portal/licenses/[id]/rotate/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';

const KEY_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = 'cust-1';
const GUILD = '222222222222222222';

const LICENCE = {
  id: KEY_ID,
  status: 'active',
  bound_discord_id: '333333333333333333',
  order_id: 'order-1',
  orders: { order_number: 'ORD-001' },
  products: { name: 'VIP Pass' },
};

function mockDb(opts: {
  portal?: { customer_id: string; guild_id: string } | null;
  licence?: Record<string, unknown> | null;
  rpcResult?: Record<string, unknown> | null;
  rpcError?: { message: string } | null;
  queueError?: { message: string } | null;
} = {}) {
  const queued: Record<string, unknown>[] = [];
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];

  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gt']) chain[m] = vi.fn(() => chain);
    chain.single = vi.fn(async () => ({
      data: table === 'portal_sessions'
        ? (opts.portal === undefined ? { customer_id: CUSTOMER, guild_id: GUILD } : opts.portal)
        : null,
      error: null,
    }));
    chain.maybeSingle = vi.fn(async () => ({
      data: table === 'license_keys'
        ? (opts.licence === undefined ? LICENCE : opts.licence)
        : null,
      error: null,
    }));
    chain.insert = vi.fn(async (row: Record<string, unknown>) => {
      if (table === 'bot_action_queue') queued.push(row);
      return { error: opts.queueError ?? null };
    });
    return chain;
  });

  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push([fn, args]);
    return {
      data: opts.rpcResult === undefined ? { status: 'rotated' } : opts.rpcResult,
      error: opts.rpcError ?? null,
    };
  });

  vi.mocked(createAdminSupabase).mockReturnValue({ from, rpc } as never);
  return { queued, rpcCalls };
}

const req = (token?: string) =>
  new NextRequest(`http://x/api/portal/licenses/${KEY_ID}/rotate`, {
    method: 'POST',
    ...(token ? { headers: { 'x-portal-token': token } } : {}),
  });

const params = (id = KEY_ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimits.portalRotate).mockResolvedValue({ limited: false } as never);
});

describe('access control', () => {
  it('refuses without a portal token', async () => {
    mockDb();
    expect((await POST(req(), params())).status).toBe(401);
  });

  it('refuses an expired session', async () => {
    mockDb({ portal: null });
    expect((await POST(req('tok'), params())).status).toBe(401);
  });

  it('refuses once the daily rotation limit is hit', async () => {
    mockDb();
    vi.mocked(rateLimits.portalRotate).mockResolvedValue({ limited: true } as never);
    const res = await POST(req('tok'), params());
    expect(res.status).toBe(429);
  });

  it('404s a licence belonging to someone else', async () => {
    const { rpcCalls } = mockDb({ licence: null });
    const res = await POST(req('tok'), params());
    expect(res.status).toBe(404);
    // Nothing was rotated on the refused path.
    expect(rpcCalls).toHaveLength(0);
  });

  it('refuses to rotate a revoked licence', async () => {
    const { rpcCalls } = mockDb({ licence: { ...LICENCE, status: 'revoked' } });
    const res = await POST(req('tok'), params());
    expect(res.status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('the new secret', () => {
  it('never returns the plaintext key', async () => {
    const { rpcCalls } = mockDb();
    const res = await POST(req('tok'), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    // Only the last four characters, so the customer can tell the keys apart.
    expect(body.newKeySuffix).toMatch(/^[A-Z0-9]{4}$/);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/SMNI-/);
    // And whatever hash went to the database must not be in the response.
    const [, args] = rpcCalls[0]!;
    expect(serialized).not.toContain(args.p_new_key_hash as string);
  });

  it('hands the database a hash, never the key itself', async () => {
    const { rpcCalls } = mockDb();
    await POST(req('tok'), params());

    const [fn, args] = rpcCalls[0]!;
    expect(fn).toBe('license_rotate_key');
    // sha256 hex.
    expect(args.p_new_key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(args.p_new_key_prefix).toBe('SMNI');
    expect(String(args.p_new_key_suffix)).toHaveLength(4);
  });

  it('delivers the new key down the existing receipt-DM path', async () => {
    const { queued } = mockDb();
    await POST(req('tok'), params());

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      guild_id: GUILD,
      action: 'deliver_receipt',
      status: 'pending',
    });
    const payload = queued[0]!.payload as Record<string, unknown>;
    expect(payload.discord_id).toBe(LICENCE.bound_discord_id);
    // This is the ONE place the plaintext legitimately travels.
    expect(String(payload.license_key_plaintext)).toMatch(/^SMNI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('generates a different key each time', async () => {
    const a = mockDb();
    await POST(req('tok'), params());
    const b = mockDb();
    await POST(req('tok'), params());

    const keyA = (a.queued[0]!.payload as Record<string, unknown>).license_key_plaintext;
    const keyB = (b.queued[0]!.payload as Record<string, unknown>).license_key_plaintext;
    expect(keyA).not.toBe(keyB);
  });

  it('avoids characters that are misread when retyped', async () => {
    const { queued } = mockDb();
    await POST(req('tok'), params());
    const key = String((queued[0]!.payload as Record<string, unknown>).license_key_plaintext);
    // Customers retype these from a DM. Every confusable PAIR must have one
    // side removed, or the ambiguity survives: O/0, I/1, L/1, S/5, Z/2, B/8.
    expect(key.slice(5)).not.toMatch(/[O0IL1S5Z2B8U]/);
  });
});

describe('replay and failure', () => {
  it('does not mint a second key when the rotation already happened', async () => {
    const { queued } = mockDb({ rpcResult: { status: 'already_rotated' } });
    const res = await POST(req('tok'), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alreadyRotated).toBe(true);
    // Critically: no second delivery, so the customer is not sent a key that
    // does not work.
    expect(queued).toHaveLength(0);
  });

  it('says the old key is dead even when delivery could not be queued', async () => {
    mockDb({ queueError: { message: 'queue unavailable' } });
    const res = await POST(req('tok'), params());
    const body = await res.json();

    // The rotation DID happen — reporting failure would invite a retry that
    // mints a third key, and reporting plain success would hide that no DM
    // is coming.
    expect(res.status).toBe(200);
    expect(body.delivery).toBe('not_queued');
    expect(body.message).toContain('stopped working');
    expect(body.message).toContain('Contact the seller');
  });

  it('surfaces an RPC failure rather than claiming success', async () => {
    mockDb({ rpcError: { message: 'deadlock detected' } });
    const res = await POST(req('tok'), params());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
