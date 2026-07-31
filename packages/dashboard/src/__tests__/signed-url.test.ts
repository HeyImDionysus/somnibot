/**
 * V8 Audit §13.P3a — Tests for signed download URL generation & verification.
 *
 * Covers: generateSignedDownloadUrl, verifySignedDownloadUrl
 */
import { describe, it, expect, beforeAll } from 'vitest';

// Set a signing secret before importing the module
beforeAll(() => {
  process.env.DOWNLOAD_SIGNING_SECRET = 'test-secret-for-signed-urls-min32chars!!';
});

describe('Signed Download URLs', () => {
  it('generates a URL with required query params', async () => {
    const { generateSignedDownloadUrl } = await import('@/lib/api/signed-url');
    const url = generateSignedDownloadUrl({
      productId: '00000000-0000-0000-0000-000000000001',
      fileId: '00000000-0000-0000-0000-000000000002',
      customerId: 'cust_123',
      guildId: 'guild_456',
      entitlementId: 'ent_789',
    });

    expect(url).toContain('/api/downloads/');
    expect(url).toContain('sig=');
    expect(url).toContain('exp=');
    expect(url).toContain('nonce=');
    expect(url).toContain('eid=ent_789');
  });

  it('verifies a valid signed URL', async () => {
    const { generateSignedDownloadUrl, verifySignedDownloadUrl } = await import('@/lib/api/signed-url');
    const params = {
      productId: '00000000-0000-0000-0000-000000000001',
      fileId: '00000000-0000-0000-0000-000000000002',
      customerId: 'cust_123',
      guildId: 'guild_456',
      entitlementId: 'ent_789',
    };
    const url = generateSignedDownloadUrl(params, 60);
    const qs = new URLSearchParams(url.split('?')[1]);

    const result = verifySignedDownloadUrl(
      params.productId,
      params.fileId,
      qs.get('sig')!,
      qs.get('exp')!,
      qs.get('cid')!,
      qs.get('gid')!,
      qs.get('eid')!,
      qs.get('nonce') ?? undefined,
    );

    expect(result).not.toBeNull();
    expect(result!.customerId).toBe('cust_123');
    expect(result!.guildId).toBe('guild_456');
    expect(result!.entitlementId).toBe('ent_789');
  });

  it('rejects a tampered signature', async () => {
    const { generateSignedDownloadUrl, verifySignedDownloadUrl } = await import('@/lib/api/signed-url');
    const params = {
      productId: '00000000-0000-0000-0000-000000000001',
      fileId: '00000000-0000-0000-0000-000000000002',
      customerId: 'cust_123',
      guildId: 'guild_456',
      entitlementId: 'ent_789',
    };
    const url = generateSignedDownloadUrl(params, 60);
    const qs = new URLSearchParams(url.split('?')[1]);

    const result = verifySignedDownloadUrl(
      params.productId,
      params.fileId,
      'tampered' + qs.get('sig')!.slice(8),
      qs.get('exp')!,
      qs.get('cid')!,
      qs.get('gid')!,
      qs.get('eid')!,
      qs.get('nonce') ?? undefined,
    );

    expect(result).toBeNull();
  });

  it('rejects a link when the entitlement identity is changed', async () => {
    const { generateSignedDownloadUrl, verifySignedDownloadUrl } = await import('@/lib/api/signed-url');
    const params = {
      productId: '00000000-0000-0000-0000-000000000001',
      fileId: '00000000-0000-0000-0000-000000000002',
      customerId: 'cust_123',
      guildId: 'guild_456',
      entitlementId: 'ent_789',
    };
    const url = generateSignedDownloadUrl(params, 60);
    const qs = new URLSearchParams(url.split('?')[1]);

    expect(verifySignedDownloadUrl(
      params.productId,
      params.fileId,
      qs.get('sig')!,
      qs.get('exp')!,
      qs.get('cid')!,
      qs.get('gid')!,
      'different-entitlement',
      qs.get('nonce')!,
    )).toBeNull();
  });

  it('rejects an expired URL', async () => {
    const { verifySignedDownloadUrl } = await import('@/lib/api/signed-url');
    const result = verifySignedDownloadUrl(
      'prod', 'file', 'sig', '1000000000', 'cust', 'guild', 'ent', 'nonce',
    );
    expect(result).toBeNull();
  });
});
