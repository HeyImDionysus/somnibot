/**
 * Signed download nonces are delivery tokens, not request-attempt tokens.
 *
 * A retryable dependency fault or an unusable file target must not consume the
 * nonce before the customer receives a redirect. Once delivery succeeds, the
 * same nonce must still be rejected on replay.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: vi.fn((callback: () => void | Promise<void>) => {
      void callback();
    }),
  };
});
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    portalDownload: vi.fn().mockResolvedValue({ limited: false, retryAfterMs: 0 }),
  },
}));
vi.mock('@/lib/api/signed-url', () => ({
  verifySignedDownloadUrl: vi.fn(() => ({
    customerId: 'cust-1',
    guildId: 'guild-1',
    entitlementId: 'ent-1',
    nonce: 'nonce-1',
  })),
}));
vi.mock('@/lib/api/download-nonce', () => ({
  consumeDownloadNonce: vi.fn(),
}));

import { after, NextRequest } from 'next/server';
import { GET as downloadGet } from '@/app/api/downloads/[productId]/[fileId]/route';
import { consumeDownloadNonce } from '@/lib/api/download-nonce';
import { rateLimits } from '@/lib/api/rate-limit';
import { verifySignedDownloadUrl } from '@/lib/api/signed-url';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createMockSupabase, registerTable } from './helpers';

const PRODUCT_ID = '00000000-0000-4000-a000-000000000001';
const FILE_ID = '00000000-0000-4000-a000-0000000000f1';
const params = { params: Promise.resolve({ productId: PRODUCT_ID, fileId: FILE_ID }) };
const DB_DOWN = { message: 'temporary database outage', code: '08006' };

function request() {
  const query = new URLSearchParams({
    sig: 'signature',
    exp: String(Math.floor(Date.now() / 1000) + 300),
    cid: 'cust-1',
    gid: 'guild-1',
    eid: 'ent-1',
    nonce: 'nonce-1',
  });
  return new NextRequest(
    `http://localhost/api/downloads/${PRODUCT_ID}/${FILE_ID}?${query.toString()}`,
  );
}

function mockDownload(overrides: {
  entitlementError?: typeof DB_DOWN | null;
  file?: Record<string, unknown> | null;
  storageError?: typeof DB_DOWN | null;
  deliveryError?: typeof DB_DOWN | null;
} = {}) {
  const mock = createMockSupabase();
  const entitlements = registerTable(mock, 'entitlements');
  entitlements.in.mockResolvedValue({
    data: overrides.entitlementError
      ? null
      : [{ id: 'ent-1', status: 'active', grace_period_ends_at: null }],
    error: overrides.entitlementError ?? null,
  });

  const files = registerTable(mock, 'product_files');
  files.maybeSingle.mockResolvedValue({
    data: overrides.file === undefined
      ? { id: FILE_ID, file_path: 'products/file.zip', download_count: 0 }
      : overrides.file,
    error: null,
  });
  const products = registerTable(mock, 'products');
  products.maybeSingle.mockResolvedValue({
    data: { delivery_type: 'license_key' },
    error: null,
  });
  const deliveries = registerTable(mock, 'commerce_download_deliveries');
  deliveries.insert.mockResolvedValue({ error: overrides.deliveryError ?? null });

  mock.rpc.mockResolvedValue({ error: null });
  Object.assign(mock, {
    storage: {
      from: vi.fn().mockReturnValue({
        createSignedUrl: vi.fn().mockResolvedValue({
          data: overrides.storageError
            ? null
            : { signedUrl: 'https://storage.example/download' },
          error: overrides.storageError ?? null,
        }),
      }),
    },
  });
  return mock;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(after).mockImplementation((task) => {
    if (typeof task === 'function') void task();
    else void task;
  });
  vi.mocked(rateLimits.portalDownload).mockResolvedValue({
    limited: false,
    remaining: 19,
    retryAfterMs: 0,
  });
  vi.mocked(verifySignedDownloadUrl).mockReturnValue({
    customerId: 'cust-1',
    guildId: 'guild-1',
    entitlementId: 'ent-1',
    nonce: 'nonce-1',
  });
  let consumed = false;
  vi.mocked(consumeDownloadNonce).mockImplementation(async () => {
    if (consumed) return 'replay';
    consumed = true;
    return 'consumed';
  });
});

describe('GET /api/downloads — nonce delivery boundary', () => {
  it('allows one retry after a 503, then rejects replay after successful delivery', async () => {
    vi.mocked(createAdminSupabase)
      .mockReturnValueOnce(mockDownload({ entitlementError: DB_DOWN }) as never)
      .mockReturnValue(mockDownload() as never);

    const failedAttempt = await downloadGet(request() as never, params);
    expect(failedAttempt.status).toBe(503);
    expect(consumeDownloadNonce).not.toHaveBeenCalled();

    const delivered = await downloadGet(request() as never, params);
    expect(delivered.status).toBe(307);
    expect(delivered.headers.get('location')).toBe('https://storage.example/download');

    const replay = await downloadGet(request() as never, params);
    expect(replay.status).toBe(410);
    expect(consumeDownloadNonce).toHaveBeenCalledTimes(2);
  });

  it('does not consume a nonce for an invalid external target', async () => {
    vi.mocked(createAdminSupabase)
      .mockReturnValueOnce(mockDownload({
        file: { id: FILE_ID, external_url: 'http://unsafe.example/file.zip', download_count: 0 },
      }) as never)
      .mockReturnValue(mockDownload({
        file: { id: FILE_ID, external_url: 'https://safe.example/file.zip', download_count: 0 },
      }) as never);

    expect((await downloadGet(request() as never, params)).status).toBe(400);
    expect(consumeDownloadNonce).not.toHaveBeenCalled();
    expect((await downloadGet(request() as never, params)).status).toBe(307);
    expect((await downloadGet(request() as never, params)).status).toBe(410);
  });

  it('reports a temporary storage signing fault as retryable without consuming the nonce', async () => {
    vi.mocked(createAdminSupabase)
      .mockReturnValueOnce(mockDownload({ storageError: DB_DOWN }) as never)
      .mockReturnValue(mockDownload() as never);

    const unavailable = await downloadGet(request() as never, params);
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).retryable).toBe(true);
    expect(consumeDownloadNonce).not.toHaveBeenCalled();

    expect((await downloadGet(request() as never, params)).status).toBe(307);
  });

  it('fails retryably instead of treating an unavailable nonce store as a replay', async () => {
    vi.mocked(createAdminSupabase).mockReturnValue(mockDownload() as never);
    vi.mocked(consumeDownloadNonce)
      .mockResolvedValueOnce('unavailable')
      .mockResolvedValueOnce('consumed')
      .mockResolvedValueOnce('replay');

    const unavailable = await downloadGet(request() as never, params);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      retryable: true,
    });

    expect((await downloadGet(request() as never, params)).status).toBe(307);
    expect((await downloadGet(request() as never, params)).status).toBe(410);
  });

  it('does not advertise a retry when a dispatched nonce write remains uncertain', async () => {
    vi.mocked(createAdminSupabase).mockReturnValue(mockDownload() as never);
    vi.mocked(consumeDownloadNonce)
      .mockResolvedValueOnce('uncertain')
      .mockResolvedValueOnce('replay');

    const uncertain = await downloadGet(request() as never, params);
    expect(uncertain.status).toBe(409);
    expect(await uncertain.json()).toMatchObject({
      retryable: false,
    });
    expect(after).not.toHaveBeenCalled();

    const replay = await downloadGet(request() as never, params);
    expect(replay.status).toBe(410);
    expect(after).not.toHaveBeenCalled();
  });

  it('does not redirect when durable delivery evidence cannot be recorded', async () => {
    vi.mocked(createAdminSupabase).mockReturnValue(
      mockDownload({ deliveryError: DB_DOWN }) as never,
    );

    const response = await downloadGet(request() as never, params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ retryable: false });
    expect(after).not.toHaveBeenCalled();
  });

  it('returns the redirect after nonce consumption even when analytics never settles', async () => {
    let signalAnalyticsStarted!: () => void;
    const analyticsStarted = new Promise<void>((resolve) => {
      signalAnalyticsStarted = resolve;
    });
    const hangingAnalytics = new Promise<{ error: null }>(() => {});
    const mock = mockDownload();
    mock.rpc.mockImplementation(() => {
      signalAnalyticsStarted();
      return hangingAnalytics;
    });
    vi.mocked(createAdminSupabase).mockReturnValue(mock as never);

    const responsePromise = downloadGet(request() as never, params);
    await analyticsStarted;

    const outcome = await Promise.race([
      responsePromise.then((response) => ({ kind: 'response' as const, response })),
      new Promise<{ kind: 'blocked' }>((resolve) => {
        setImmediate(() => resolve({ kind: 'blocked' }));
      }),
    ]);

    expect(outcome.kind).toBe('response');
    if (outcome.kind === 'response') {
      expect(outcome.response.status).toBe(307);
      expect(outcome.response.headers.get('location')).toBe('https://storage.example/download');
    }
    expect(after).toHaveBeenCalledOnce();
  });

  it('legacy links without an entitlement id select the undelivered purchase (round 20)', async () => {
    // A rolling-deployment link (no eid) must use the SAME delivery-aware
    // ranking as link minting: the older UNDELIVERED order claims its
    // evidence before the newest (already delivered) order is re-served.
    vi.mocked(verifySignedDownloadUrl).mockReturnValue({
      customerId: 'cust-1',
      guildId: 'guild-1',
      entitlementId: null,
      nonce: 'nonce-1',
    });
    const mock = mockDownload();
    const entitlements = mock._tables['entitlements'];
    entitlements.in.mockResolvedValue({
      data: [
        {
          id: 'ent-old',
          order_id: 'order-old',
          status: 'active',
          grace_period_ends_at: null,
          created_at: '2026-07-20T10:00:00.000Z',
        },
        {
          id: 'ent-new',
          order_id: 'order-new',
          status: 'active',
          grace_period_ends_at: null,
          created_at: '2026-07-28T10:00:00.000Z',
        },
      ],
      error: null,
    });
    const deliveries = mock._tables['commerce_download_deliveries'];
    deliveries.in.mockResolvedValue({
      data: [{ order_id: 'order-new' }],
      error: null,
    });
    vi.mocked(createAdminSupabase).mockReturnValue(mock as never);

    const response = await downloadGet(request() as never, params);

    expect(response.status).toBe(307);
    expect(deliveries.insert).toHaveBeenCalledWith(
      expect.objectContaining({ entitlement_id: 'ent-old', order_id: 'order-old' }),
    );
  });

  it('rejects a durable nonce conflict as a replay instead of redirecting (round 11)', async () => {
    // Valkey lost the consumed marker while the signed link was still valid:
    // the replay passes consumeDownloadNonce as fresh, and the durable
    // delivery insert then hits the partial unique nonce index with 23505.
    // That conflict IS the single-use guarantee firing — treating it as
    // benign dedupe re-served the file exactly when the volatile store
    // forgot.
    const mock = mockDownload({
      deliveryError: {
        message: 'duplicate key value violates unique constraint '
          + '"idx_commerce_download_deliveries_nonce"',
        code: '23505',
      } as never,
    });
    vi.mocked(createAdminSupabase).mockReturnValue(mock as never);

    const response = await downloadGet(request() as never, params);

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: 'Download link has already been used',
    });
    // No delivery happened, so analytics must not have been scheduled.
    expect(after).not.toHaveBeenCalled();
  });
});
