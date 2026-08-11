import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    customerId: 'customer-1',
    guildId: 'guild-1',
    entitlementId: 'entitlement-1',
    nonce: 'nonce-1',
  })),
}));
vi.mock('@/lib/api/download-nonce', () => ({
  consumeDownloadNonce: vi.fn().mockResolvedValue('consumed'),
}));

import { NextRequest } from 'next/server';
import { GET as downloadGet } from '@/app/api/downloads/[productId]/[fileId]/route';
import { consumeDownloadNonce } from '@/lib/api/download-nonce';
import { rateLimits } from '@/lib/api/rate-limit';
import { verifySignedDownloadUrl } from '@/lib/api/signed-url';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { verifyStaticManifest } from '@/lib/store/static-delivery';
import { createMockSupabase, registerTable } from './helpers';

const PRODUCT_ID = '00000000-0000-4000-a000-000000000001';
const FILE_ID = '00000000-0000-4000-a000-0000000000f1';
const SECRET = 'static-delivery-route-test-secret-000000000000';
const params = { params: Promise.resolve({ productId: PRODUCT_ID, fileId: FILE_ID }) };

function request() {
  const query = new URLSearchParams({
    sig: 'signature',
    exp: String(Math.floor(Date.now() / 1000) + 300),
    cid: 'customer-1',
    gid: 'guild-1',
    eid: 'entitlement-1',
    nonce: 'nonce-1',
  });
  return new NextRequest(
    `http://localhost/api/downloads/${PRODUCT_ID}/${FILE_ID}?${query.toString()}`,
  );
}

function staticDownloadMock(file: Record<string, unknown>) {
  const mock = createMockSupabase();
  const entitlements = registerTable(mock, 'entitlements');
  entitlements.in.mockResolvedValue({
    data: [{
      id: 'entitlement-1',
      order_id: 'order-1',
      status: 'active',
      grace_period_ends_at: null,
      created_at: '2026-08-10T12:00:00.000Z',
    }],
    error: null,
  });
  const files = registerTable(mock, 'product_files');
  files.maybeSingle.mockResolvedValue({ data: file, error: null });
  const products = registerTable(mock, 'products');
  products.maybeSingle.mockResolvedValue({ data: { delivery_type: 'file' }, error: null });
  const deliveries = registerTable(mock, 'commerce_download_deliveries');
  deliveries.insert.mockResolvedValue({ error: null });
  const storageFile = new Blob(
    ['<!doctype html><html><body><main>Licensed handbook</main></body></html>'],
    { type: 'text/html' },
  );
  const storageApi = {
    download: vi.fn().mockResolvedValue({ data: storageFile, error: null }),
    createSignedUrl: vi.fn(),
  };
  Object.assign(mock, {
    storage: { from: vi.fn(() => storageApi) },
  });
  mock.rpc.mockResolvedValue({ error: null });
  return { mock, storageApi };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.STATIC_DELIVERY_HMAC_SECRET = SECRET;
  vi.mocked(rateLimits.portalDownload).mockResolvedValue({
    limited: false,
    remaining: 19,
    retryAfterMs: 0,
  });
  vi.mocked(verifySignedDownloadUrl).mockReturnValue({
    customerId: 'customer-1',
    guildId: 'guild-1',
    entitlementId: 'entitlement-1',
    nonce: 'nonce-1',
  });
  vi.mocked(consumeDownloadNonce).mockResolvedValue('consumed');
});

afterEach(() => {
  delete process.env.STATIC_DELIVERY_HMAC_SECRET;
});

describe('GET /api/downloads — static buyer derivative', () => {
  it('returns a watermarked derivative only after recording single-use delivery evidence', async () => {
    const { mock, storageApi } = staticDownloadMock({
      id: FILE_ID,
      file_name: 'handbook.html',
      mime_type: 'text/html',
      storage_path: 'guild/product/handbook.html',
      storage_bucket: 'product-files',
      download_count: 0,
      name: 'handbook.html',
    });
    vi.mocked(createAdminSupabase).mockReturnValue(mock as never);

    const response = await downloadGet(request(), params);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-disposition')).toContain('handbook.html');
    expect(await response.text()).toContain('SomniBot licensed copy');
    expect(storageApi.createSignedUrl).not.toHaveBeenCalled();
    expect(consumeDownloadNonce).toHaveBeenCalledOnce();
    expect(mock._tables.commerce_download_deliveries.insert).toHaveBeenCalledOnce();

    const manifest = response.headers.get('x-somnibot-watermark-manifest');
    const signature = response.headers.get('x-somnibot-watermark-signature');
    expect(manifest).not.toBeNull();
    expect(signature).not.toBeNull();
    expect(verifyStaticManifest(manifest ?? '', signature ?? '', SECRET)).toMatchObject({
      productId: PRODUCT_ID,
      entitlementRef: 'entitlement-1',
      mimeType: 'text/html',
    });
  });

  it('fails closed for a static external URL without consuming the link', async () => {
    const { mock, storageApi } = staticDownloadMock({
      id: FILE_ID,
      file_name: 'handbook.html',
      mime_type: 'text/html',
      external_url: 'https://files.example.test/handbook.html',
    });
    vi.mocked(createAdminSupabase).mockReturnValue(mock as never);

    const response = await downloadGet(request(), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ retryable: false });
    expect(consumeDownloadNonce).not.toHaveBeenCalled();
    expect(storageApi.download).not.toHaveBeenCalled();
  });

  it('fails closed when no verified derivative transformer supports the master format', async () => {
    const { mock, storageApi } = staticDownloadMock({
      id: FILE_ID,
      file_name: 'archive.zip',
      mime_type: 'application/zip',
      storage_path: 'guild/product/archive.zip',
      storage_bucket: 'product-files',
    });
    vi.mocked(createAdminSupabase).mockReturnValue(mock as never);

    const response = await downloadGet(request(), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ retryable: false });
    expect(consumeDownloadNonce).not.toHaveBeenCalled();
    expect(storageApi.download).not.toHaveBeenCalled();
  });
});
