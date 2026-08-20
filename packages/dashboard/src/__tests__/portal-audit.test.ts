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
vi.mock('@/lib/discord-runtime-config', () => ({
  getDiscordOAuthRuntimeConfig: vi.fn(async () => ({
    applicationId: 'app-id',
    clientSecret: 'secret',
    sources: { applicationId: 'env', clientSecret: 'env' },
  })),
}));

import { POST as authPost } from '@/app/api/portal/auth/route';
import { POST as downloadLinkPost } from '@/app/api/portal/download-link/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { loginDependencyFailure } from '@/lib/api/portal-login-dependency';

const PRODUCT_UUID = '22222222-2222-2222-2222-222222222222';
const FILE_UUID = '33333333-3333-3333-3333-333333333333';

let auditRows: Record<string, unknown>[] = [];

interface AdminOpts {
  customer?: { id: string; guild_id: string; discord_id: string } | null;
  customerError?: { message: string } | null;
  portalConfigError?: { message: string } | null;
  sessionInsertError?: { message: string } | null;
  session?: { customer_id: string; guild_id: string } | null;
  entitlements?: Array<{ id: string; status: string; grace_period_ends_at: string | null }>;
  file?: { id: string } | null;
}

function makeAdmin(opts: AdminOpts = {}) {
  return {
    rpc: async (name: string) => name === 'issue_portal_session_atomic'
      ? {
          data: opts.sessionInsertError ? null : '44444444-4444-4444-8444-444444444444',
          error: opts.sessionInsertError ?? null,
        }
      : { data: null, error: { message: `unexpected RPC ${name}` } },
    from: (table: string) => {
      if (table === 'audit_logs') {
        const persist = (rows: Record<string, unknown> | readonly Record<string, unknown>[]) => {
          auditRows.push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        };
        return { insert: persist, upsert: persist };
      }
      if (table === 'customers') {
        const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: opts.customer ?? null, error: opts.customerError ?? null }) };
        return chain;
      }
      if (table === 'guild_config') {
        const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null, error: opts.portalConfigError ?? null }) };
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
          insert: () => ({ error: opts.sessionInsertError ?? null }),
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
  vi.resetAllMocks();
  auditRows = [];
  process.env.DISCORD_APPLICATION_ID = 'app-id';
  process.env.DISCORD_CLIENT_SECRET = 'secret';
});

describe('POST /api/portal/auth — login audit', () => {
  it('keeps a stable correlation while recording separate dashboard exchange failures', async () => {
    const admin = makeAdmin();
    await loginDependencyFailure(admin as unknown as ReturnType<typeof createAdminSupabase>, {
      guildId: 'guild-1',
      code: 'dashboard-session:user-1:guild-1',
      cause: 'session_dependency',
      occurrenceId: 'exchange-1',
    });
    await loginDependencyFailure(admin as unknown as ReturnType<typeof createAdminSupabase>, {
      guildId: 'guild-1',
      code: 'dashboard-session:user-1:guild-1',
      cause: 'session_dependency',
      occurrenceId: 'exchange-2',
    });

    expect(auditRows.map((row) => row.occurrence_key)).toEqual([
      'portal.login_failed:session_dependency:exchange-1',
      'portal.login_failed:session_dependency:exchange-2',
    ]);
    expect(new Set(auditRows.map((row) => row.correlation_id)).size).toBe(1);
  });

  it('writes one sanitized portal.login_failed row on login dependency failure', async () => {
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(makeAdmin());
    global.fetch = vi.fn(async () => {
      throw new TypeError('provider socket exposed oauth-secret-value');
    });

    const res = await authPost(authRequest({
      action: 'login',
      code: 'oauth-secret-value',
      guild_id: 'guild-1',
    }));

    expect(res.status).toBe(503);
    expect(auditRows.filter((row) => row.action === 'portal.login_failed')).toHaveLength(1);
    const row = auditRows.find((entry) => entry.action === 'portal.login_failed');
    expect(row).toMatchObject({
      guild_id: 'guild-1',
      actor_id: 'unknown',
      success: false,
      occurrence_key: expect.stringMatching(/^portal\.login_failed:/),
      details: { cause: 'provider_unavailable' },
    });
    expect(JSON.stringify(row)).not.toMatch(/oauth-secret-value|provider socket/i);
  });

  it('audits an account dependency failure without minting a session', async () => {
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(makeAdmin({
      customerError: { message: 'customer query leaked-account@example.test' },
    }));
    mockDiscord(true);

    const accountResponse = await authPost(authRequest({ action: 'login', code: 'oauth', guild_id: 'guild-1' }));
    expect(accountResponse.status).toBe(503);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'portal.login_failed',
      details: { cause: 'account_dependency' },
      success: false,
    });
    expect(JSON.stringify(auditRows[0])).not.toContain('leaked-account@example.test');
  });

  it('audits a session dependency failure without returning a token', async () => {
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(makeAdmin({
      customer: { id: 'cust-1', guild_id: 'guild-1', discord_id: 'discord-1' },
      sessionInsertError: { message: 'session insert leaked-token-value' },
    }));
    mockDiscord(true);
    const sessionResponse = await authPost(authRequest({ action: 'login', code: 'oauth', guild_id: 'guild-1' }));
    expect(sessionResponse.status).toBe(503);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'portal.login_failed',
      details: { cause: 'session_dependency' },
      success: false,
    });
    expect(JSON.stringify(auditRows[0])).not.toContain('leaked-token-value');
  });

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
      target_id: '44444444-4444-4444-8444-444444444444',
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
    expect(auditRows.filter((entry) => entry.action === 'portal.login_failed')).toHaveLength(0);
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
