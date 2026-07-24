/**
 * Observability-gap [commerce-portal]: portal login/download actions and their
 * refusals previously wrote NO audit_logs row.
 *
 * These tests assert every portal state change and denied attempt now writes an
 * append-only commerce audit row via the service-role client (writeCommerceAudit).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    portalAuth: vi.fn(async () => ({ limited: false, retryAfterMs: 0 })),
    portalData: vi.fn(async () => ({ limited: false, retryAfterMs: 0 })),
  },
}));
vi.mock('@/lib/api/signed-url', () => ({
  generateSignedDownloadUrl: vi.fn(() => 'https://signed.example/dl'),
}));

import { POST as authPost } from '@/app/api/portal/auth/route';
import { POST as downloadLinkPost } from '@/app/api/portal/download-link/route';
import { createAdminSupabase } from '@/lib/supabase/admin';

const PRODUCT_UUID = '22222222-2222-2222-2222-222222222222';
const FILE_UUID = '33333333-3333-3333-3333-333333333333';

let auditRows: Record<string, unknown>[] = [];

interface AdminOpts {
  customer?: { id: string; guild_id: string; discord_id: string } | null;
  session?: { customer_id: string; guild_id: string } | null;
  entitlements?: Array<{ id: string; status: string; grace_period_ends_at: string | null }>;
  file?: { id: string } | null;
}

function makeAdmin(opts: AdminOpts = {}) {
  return {
    from: (table: string) => {
      if (table === 'audit_logs') {
        return { insert: (row: Record<string, unknown>) => { auditRows.push(row); return { error: null }; } };
      }
      if (table === 'customers') {
        const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: opts.customer ?? null, error: null }) };
        return chain;
      }
      if (table === 'portal_sessions') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          gt: () => chain,
          order: () => chain,
          in: () => chain,
          update: () => chain,
          limit: async () => ({ data: [], error: null }),
          single: async () => ({ data: opts.session ?? null, error: null }),
          insert: () => ({ error: null }),
        };
        return chain;
      }
      if (table === 'entitlements') {
        const chain: any = { select: () => chain, eq: () => chain, in: async () => ({ data: opts.entitlements ?? [], error: null }) };
        return chain;
      }
      if (table === 'product_files') {
        const chain: any = { select: () => chain, eq: () => chain, single: async () => ({ data: opts.file ?? null, error: null }) };
        return chain;
      }
      const chain: any = { select: () => chain, eq: () => chain, single: async () => ({ data: null }), maybeSingle: async () => ({ data: null }) };
      return chain;
    },
  };
}

function authRequest(body: Record<string, unknown>) {
  return new NextRequest('https://dash.example/api/portal/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://dash.example', 'x-forwarded-for': '1.2.3.4' },
    body: JSON.stringify(body),
  });
}

function downloadRequest(body: Record<string, unknown>, token = 'portal-tok') {
  return new NextRequest('https://dash.example/api/portal/download-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-portal-token': token, 'x-forwarded-for': '1.2.3.4' },
    body: JSON.stringify(body),
  });
}

function mockDiscord(ok: boolean) {
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    if (!ok) return { ok: false, json: async () => ({}) } as any;
    if (u.includes('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'tok', token_type: 'Bearer' }) } as any;
    if (u.includes('/users/@me')) return { ok: true, json: async () => ({ id: 'discord-1', username: 'buyer' }) } as any;
    return { ok: false, json: async () => ({}) } as any;
  }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  auditRows = [];
  process.env.DISCORD_APPLICATION_ID = 'app-id';
  process.env.DISCORD_CLIENT_SECRET = 'secret';
});

describe('POST /api/portal/auth — login audit', () => {
  it('writes portal.login_succeeded when a session is issued', async () => {
    (createAdminSupabase as any).mockReturnValue(
      makeAdmin({ customer: { id: 'cust-1', guild_id: 'guild-1', discord_id: 'discord-1' } }),
    );
    mockDiscord(true);

    const res = await authPost(authRequest({ action: 'login', code: 'oauth', guild_id: 'guild-1' }));
    expect(res.status).toBe(200);

    const row = auditRows.find((r) => r.action === 'portal.login_succeeded');
    expect(row).toMatchObject({
      guild_id: 'guild-1',
      actor_type: 'user',
      actor_id: 'discord-1',
      category: 'commerce',
      target_type: 'portal_session',
      target_id: 'cust-1',
      success: true,
    });
  });

  it('writes a failed portal.login_denied row when Discord auth fails', async () => {
    (createAdminSupabase as any).mockReturnValue(makeAdmin());
    mockDiscord(false);

    const res = await authPost(authRequest({ action: 'login', code: 'oauth', guild_id: 'guild-9' }));
    expect(res.status).toBe(401);

    const row = auditRows.find((r) => r.action === 'portal.login_denied');
    expect(row).toMatchObject({
      guild_id: 'guild-9',
      action: 'portal.login_denied',
      success: false,
    });
    expect((row?.details as Record<string, unknown>).reason).toBe('discord_auth_failed');
  });

  it('writes a failed portal.login_denied row when identity is not a customer', async () => {
    (createAdminSupabase as any).mockReturnValue(makeAdmin({ customer: null }));
    mockDiscord(true);

    const res = await authPost(authRequest({ action: 'login', code: 'oauth', guild_id: 'guild-1' }));
    expect(res.status).toBe(404);

    const row = auditRows.find((r) => r.action === 'portal.login_denied');
    expect(row).toMatchObject({ guild_id: 'guild-1', actor_id: 'discord-1', success: false });
    expect((row?.details as Record<string, unknown>).reason).toBe('no_account');
  });
});

describe('POST /api/portal/download-link — download audit', () => {
  it('writes portal.download_link_issued on a successful mint', async () => {
    (createAdminSupabase as any).mockReturnValue(
      makeAdmin({
        session: { customer_id: 'cust-1', guild_id: 'guild-1' },
        entitlements: [{ id: 'ent-1', status: 'active', grace_period_ends_at: null }],
        file: { id: FILE_UUID },
      }),
    );

    const res = await downloadLinkPost(downloadRequest({ productId: PRODUCT_UUID, fileId: FILE_UUID }));
    expect(res.status).toBe(200);

    const row = auditRows.find((r) => r.action === 'portal.download_link_issued');
    expect(row).toMatchObject({
      guild_id: 'guild-1',
      actor_type: 'user',
      actor_id: 'cust-1',
      category: 'commerce',
      target_type: 'product_file',
      target_id: FILE_UUID,
    });
  });

  it('writes a failed portal.download_denied row when there is no live entitlement', async () => {
    (createAdminSupabase as any).mockReturnValue(
      makeAdmin({ session: { customer_id: 'cust-1', guild_id: 'guild-1' }, entitlements: [] }),
    );

    const res = await downloadLinkPost(downloadRequest({ productId: PRODUCT_UUID, fileId: FILE_UUID }));
    expect(res.status).toBe(403);

    const row = auditRows.find((r) => r.action === 'portal.download_denied');
    expect(row).toMatchObject({
      guild_id: 'guild-1',
      target_type: 'product',
      target_id: PRODUCT_UUID,
      success: false,
    });
    expect((row?.details as Record<string, unknown>).reason).toBe('no_entitlement');
  });
});
