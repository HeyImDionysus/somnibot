/**
 * W2 codex — entitlement-gated download surfaces honor the lapsed-grace rule.
 *
 * The portal download-link route (mints a signed URL) and the protected
 * file-download route both gate on the customer's entitlement. A `grace_period`
 * row whose deadline has lapsed but which reconciliation (every ~6h) has not
 * yet expired must be rejected here, exactly as license/validate + heartbeat
 * already reject it — otherwise the portal keeps serving downloads to a
 * customer whose license the SDK rejects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    portalData: vi.fn().mockResolvedValue({ limited: false, retryAfterMs: 0 }),
    portalDownload: vi.fn().mockResolvedValue({ limited: false, retryAfterMs: 0 }),
  },
}));
vi.mock('@/lib/api/signed-url', () => ({
  generateSignedDownloadUrl: vi.fn(() => 'https://signed.example/download'),
  verifySignedDownloadUrl: vi.fn(),
}));

import { POST as downloadLinkPost } from '@/app/api/portal/download-link/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createMockSupabase, registerTable, buildRequest } from './helpers';

const PRODUCT_ID = '00000000-0000-4000-a000-000000000001';
const FILE_ID = '00000000-0000-4000-a000-0000000000f1';

const NOW = new Date('2026-07-09T12:00:00.000Z');
const ONE_DAY = 24 * 60 * 60 * 1000;
const FUTURE_DEADLINE = new Date(NOW.getTime() + ONE_DAY).toISOString();
const PAST_DEADLINE = new Date(NOW.getTime() - ONE_DAY).toISOString();

function setupMocks(entitlement: Record<string, unknown> | null) {
  const mock = createMockSupabase();

  const sessions = registerTable(mock, 'portal_sessions');
  sessions.single.mockResolvedValue({
    data: { customer_id: 'cust-1', guild_id: 'guild-1' },
    error: null,
  });

  const entitlements = registerTable(mock, 'entitlements');
  entitlements.maybeSingle.mockResolvedValue({ data: entitlement, error: null });

  const files = registerTable(mock, 'product_files');
  files.single.mockResolvedValue({ data: { id: FILE_ID }, error: null });

  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  return { mock, entitlements };
}

function linkReq() {
  return buildRequest('/api/portal/download-link', {
    method: 'POST',
    headers: { 'x-portal-token': 'tok-123' },
    body: { productId: PRODUCT_ID, fileId: FILE_ID },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/portal/download-link — grace deadline enforcement', () => {
  it('mints a signed URL for an active entitlement', async () => {
    setupMocks({ id: 'ent-1', status: 'active', grace_period_ends_at: null });
    const res = await downloadLinkPost(linkReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('https://signed.example/download');
  });

  it('mints a signed URL for a grace entitlement still inside its window', async () => {
    setupMocks({ id: 'ent-1', status: 'grace_period', grace_period_ends_at: FUTURE_DEADLINE });
    const res = await downloadLinkPost(linkReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('https://signed.example/download');
  });

  it('rejects a grace entitlement whose deadline lapsed but was not reconciled yet', async () => {
    setupMocks({ id: 'ent-1', status: 'grace_period', grace_period_ends_at: PAST_DEADLINE });
    const res = await downloadLinkPost(linkReq() as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/no active entitlement/i);
  });

  it('computes the window at request time — the same stale row flips to rejected once the clock passes the deadline', async () => {
    const deadline = new Date(NOW.getTime() + 60_000).toISOString();

    setupMocks({ id: 'ent-1', status: 'grace_period', grace_period_ends_at: deadline });
    const before = await downloadLinkPost(linkReq() as never);
    expect(before.status).toBe(200);

    vi.setSystemTime(new Date(NOW.getTime() + 120_000));
    setupMocks({ id: 'ent-1', status: 'grace_period', grace_period_ends_at: deadline });
    const after = await downloadLinkPost(linkReq() as never);
    expect(after.status).toBe(403);
  });
});
