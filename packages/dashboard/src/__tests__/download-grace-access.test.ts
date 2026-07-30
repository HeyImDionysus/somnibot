/**
 * W2 codex — entitlement-gated download surfaces honor the lapsed-grace rule.
 *
 * The portal download-link route (mints a signed URL) and the protected
 * file-download route both gate on the customer's entitlement. A `grace_period`
 * row whose deadline has lapsed but which reconciliation (every ~6h) has not
 * yet expired must be rejected here, exactly as license/validate + heartbeat
 * already reject it — otherwise the portal keeps serving downloads to a
 * customer whose license the SDK rejects.
 *
 * A customer may hold MORE THAN ONE candidate entitlement for the same product
 * (a re-buy, or overlapping subscription + manual grant). Both routes fetch the
 * whole candidate set and grant access if ANY row is live, so one lapsed grace
 * row cannot mask another that is still active / in an unexpired window.
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
  verifySignedDownloadUrl: vi.fn(() => ({ customerId: 'cust-1', guildId: 'guild-1', nonce: undefined })),
}));
vi.mock('@/lib/api/download-nonce', () => ({
  consumeDownloadNonce: vi.fn().mockResolvedValue('consumed'),
}));

import { NextRequest } from 'next/server';
import { POST as downloadLinkPost } from '@/app/api/portal/download-link/route';
import { GET as fileDownloadGet } from '@/app/api/downloads/[productId]/[fileId]/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createMockSupabase, registerTable, buildRequest } from './helpers';

const PRODUCT_ID = '00000000-0000-4000-a000-000000000001';
const FILE_ID = '00000000-0000-4000-a000-0000000000f1';

const NOW = new Date('2026-07-09T12:00:00.000Z');
const ONE_DAY = 24 * 60 * 60 * 1000;
const FUTURE_DEADLINE = new Date(NOW.getTime() + ONE_DAY).toISOString();
const PAST_DEADLINE = new Date(NOW.getTime() - ONE_DAY).toISOString();

/**
 * Wire the shared mocks. `rows` is the candidate entitlement set the route's
 * `.in('status', ['active','grace_period'])` query resolves to — the route no
 * longer terminates on `.maybeSingle()`, it awaits the filter builder for the
 * full array, so the terminal `.in()` is what resolves here.
 */
function setupMocks(rows: Array<Record<string, unknown>>) {
  const mock = createMockSupabase();

  const sessions = registerTable(mock, 'portal_sessions');
  // Both terminals: the download-link route still uses `.single()`, the
  // file-download route uses `.maybeSingle()` so that a missing row is
  // data-null rather than an error (an error there now means a real fault).
  const portalSession = { data: { customer_id: 'cust-1', guild_id: 'guild-1' }, error: null };
  sessions.single.mockResolvedValue(portalSession);
  sessions.maybeSingle.mockResolvedValue(portalSession);

  const entitlements = registerTable(mock, 'entitlements');
  entitlements.in.mockResolvedValue({ data: rows, error: null });

  const files = registerTable(mock, 'product_files');
  const productFile = { data: { id: FILE_ID, file_path: 'p/f.zip' }, error: null };
  files.single.mockResolvedValue(productFile);
  files.maybeSingle.mockResolvedValue(productFile);

  // The file-download route increments a counter via RPC and mints a storage
  // signed URL — the flat helper's mock has neither, so stub them here.
  (mock as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc = vi
    .fn()
    .mockResolvedValue({ error: null });
  (mock as unknown as { storage: unknown }).storage = {
    from: vi.fn().mockReturnValue({
      createSignedUrl: vi
        .fn()
        .mockResolvedValue({ data: { signedUrl: 'https://storage.example/signed' }, error: null }),
    }),
  };

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

function fileReq() {
  // The file-download route reads req.nextUrl.searchParams, so build a real
  // NextRequest (the plain Request from buildRequest has no .nextUrl).
  const sp = new URLSearchParams({
    sig: 's',
    exp: String(Math.floor(NOW.getTime() / 1000) + 300),
    cid: 'cust-1',
    gid: 'guild-1',
  });
  return new NextRequest(`http://localhost/api/downloads/${PRODUCT_ID}/${FILE_ID}?${sp.toString()}`);
}

const fileParams = { params: Promise.resolve({ productId: PRODUCT_ID, fileId: FILE_ID }) };

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
    setupMocks([{ id: 'ent-1', status: 'active', grace_period_ends_at: null }]);
    const res = await downloadLinkPost(linkReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('https://signed.example/download');
  });

  it('mints a signed URL for a grace entitlement still inside its window', async () => {
    setupMocks([{ id: 'ent-1', status: 'grace_period', grace_period_ends_at: FUTURE_DEADLINE }]);
    const res = await downloadLinkPost(linkReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('https://signed.example/download');
  });

  it('rejects a grace entitlement whose deadline lapsed but was not reconciled yet', async () => {
    setupMocks([{ id: 'ent-1', status: 'grace_period', grace_period_ends_at: PAST_DEADLINE }]);
    const res = await downloadLinkPost(linkReq() as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/no active entitlement/i);
  });

  it('grants access when a live row co-exists with a lapsed grace row (multi-entitlement)', async () => {
    // A lapsed grace row is returned FIRST — the old `.limit(1)` code would have
    // rejected on it. The route must scan the full set and honor the live row.
    setupMocks([
      { id: 'ent-lapsed', status: 'grace_period', grace_period_ends_at: PAST_DEADLINE },
      { id: 'ent-live', status: 'active', grace_period_ends_at: null },
    ]);
    const res = await downloadLinkPost(linkReq() as never);
    expect(res.status).toBe(200);
  });

  it('rejects only when EVERY candidate row is lapsed/non-live', async () => {
    setupMocks([
      { id: 'ent-a', status: 'grace_period', grace_period_ends_at: PAST_DEADLINE },
      { id: 'ent-b', status: 'grace_period', grace_period_ends_at: PAST_DEADLINE },
    ]);
    const res = await downloadLinkPost(linkReq() as never);
    expect(res.status).toBe(403);
  });

  it('rejects when the customer holds no candidate entitlements', async () => {
    setupMocks([]);
    const res = await downloadLinkPost(linkReq() as never);
    expect(res.status).toBe(403);
  });

  it('computes the window at request time — the same stale row flips to rejected once the clock passes the deadline', async () => {
    const deadline = new Date(NOW.getTime() + 60_000).toISOString();

    setupMocks([{ id: 'ent-1', status: 'grace_period', grace_period_ends_at: deadline }]);
    const before = await downloadLinkPost(linkReq() as never);
    expect(before.status).toBe(200);

    vi.setSystemTime(new Date(NOW.getTime() + 120_000));
    setupMocks([{ id: 'ent-1', status: 'grace_period', grace_period_ends_at: deadline }]);
    const after = await downloadLinkPost(linkReq() as never);
    expect(after.status).toBe(403);
  });
});

describe('GET /api/downloads/[productId]/[fileId] — grace deadline enforcement', () => {
  it('serves the file for a grace entitlement still inside its window', async () => {
    setupMocks([{ id: 'ent-1', status: 'grace_period', grace_period_ends_at: FUTURE_DEADLINE }]);
    const res = await fileDownloadGet(fileReq() as never, fileParams);
    // storage signed-url path → redirect
    expect(res.status).toBe(307);
  });

  it('rejects a grace entitlement whose deadline lapsed but was not reconciled yet', async () => {
    setupMocks([{ id: 'ent-1', status: 'grace_period', grace_period_ends_at: PAST_DEADLINE }]);
    const res = await fileDownloadGet(fileReq() as never, fileParams);
    expect(res.status).toBe(403);
  });

  it('grants access when a live row co-exists with a lapsed grace row (multi-entitlement)', async () => {
    setupMocks([
      { id: 'ent-lapsed', status: 'grace_period', grace_period_ends_at: PAST_DEADLINE },
      { id: 'ent-live', status: 'active', grace_period_ends_at: null },
    ]);
    const res = await fileDownloadGet(fileReq() as never, fileParams);
    expect(res.status).toBe(307);
  });

  it('rejects when the customer holds no candidate entitlements', async () => {
    setupMocks([]);
    const res = await fileDownloadGet(fileReq() as never, fileParams);
    expect(res.status).toBe(403);
  });
});
