/**
 * store-products-route.live.test — drive the REAL /api/store/products handlers
 * through the REAL auth guard against LOCAL Supabase (real-session harness,
 * zero prod edits). Un-gates the commerce-portal dashboard lane for the
 * PayPal-free path: a FREE product (price 0) creates a real products row with
 * no PayPal side effects (paid products stay honestly gated behind the PayPal
 * sandbox lane).
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

describe.skipIf(!reachable)('LIVE: /api/store/products (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-store-${suffix}`;
  const ownerDiscordId = `e2e-owner-store-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;
  let productId: string;

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Store Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('products').delete().eq('guild_id', guildId);
    await admin.from('audit_logs').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function jsonReq(method: string, body?: unknown): import('next/server').NextRequest {
    return new Request(`http://localhost/api/store/products`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.14.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('POST creates a FREE product row (no PayPal path)', async () => {
    const { POST } = await import('../../app/api/store/products/route');
    const res = await POST(jsonReq('POST', {
      name: 'E2E Supporter Badge',
      description: 'A free supporter perk',
      type: 'free',
      delivery_type: 'access_pass',
      price_cents: 0,
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; type: string; price_cents: number; guild_id: string } };
    expect(body.success).toBe(true);
    expect(body.data.type).toBe('free');
    expect(body.data.price_cents).toBe(0);
    expect(body.data.guild_id).toBe(guildId);
    productId = body.data.id;

    const { data } = await admin
      .from('products')
      .select('name, type, price_cents, active')
      .eq('id', productId)
      .maybeSingle();
    expect(data).toMatchObject({ name: 'E2E Supporter Badge', type: 'free', price_cents: 0, active: true });
  });

  it('GET lists the created product for the guild', async () => {
    const { GET } = await import('../../app/api/store/products/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ id: string; name: string }> };
    expect(body.data.some((p) => p.id === productId && p.name === 'E2E Supporter Badge')).toBe(true);
  });

  it('denies a POST for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { POST } = await import('../../app/api/store/products/route');
    const res = await POST(jsonReq('POST', { name: 'nope', type: 'free', delivery_type: 'access_pass', price_cents: 0 }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
    const { count } = await admin.from('products').select('id', { count: 'exact', head: true }).eq('guild_id', guildId);
    expect(count ?? 0).toBe(1);
  });
});
