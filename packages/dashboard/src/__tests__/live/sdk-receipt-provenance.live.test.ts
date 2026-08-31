import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { armDashboardLiveEnv, buildNextHeadersMock, createOwnerSession, localSupabaseReachable } from './_session-harness';
import { SDK_TEST_SIGNING_SECRET, signedSdkVerification } from '@/__fixtures__/sdk-verification';
import { buildSdkContractIdentity } from '@/lib/store/sdk-contract-identity';
import { verifyLaunchSdkIntegration } from '@/lib/store/sdk-launch-integration';
import { SDK_ATTESTATION_METADATA_KEY, SDK_RECEIPT_METADATA_KEY } from '@/lib/store/sdk-integration-receipt';

const supabaseUrl = armDashboardLiveEnv();
const holder: ReturnType<typeof buildNextHeadersMock> = vi.hoisted(() => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
  headers: async () => ({ get: () => null, has: () => false }),
}));
vi.mock('next/headers', () => ({ cookies: () => holder.cookies(), headers: () => holder.headers() }));

describe('CI database: SDK receipt provenance through owner product API', () => {
  const guildId = `sdk-provenance-${randomUUID()}`;
  const ownerId = `sdk-owner-${randomUUID()}`;
  const productId = randomUUID();
  const admin = createClient(supabaseUrl, z.string().min(1).parse(process.env.SUPABASE_SECRET_KEY), { auth: { autoRefreshToken: false, persistSession: false } });
  const params = { params: Promise.resolve({ productId }) };
  const request = (body?: unknown) => new NextRequest('https://dashboard.example/api/store/products', {
    method: body === undefined ? 'GET' : 'PUT',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  beforeAll(async () => {
    expect(await localSupabaseReachable(supabaseUrl)).toBe(true);
    vi.stubEnv('DASHBOARD_URL', 'https://dashboard.example');
    vi.stubEnv('SDK_VERIFICATION_SIGNING_SECRET', SDK_TEST_SIGNING_SECRET);
    const guild = await admin.from('guild').insert({ id: guildId, name: 'SDK provenance fixture', owner_discord_id: ownerId });
    expect(guild.error).toBeNull();
    const session = await createOwnerSession(ownerId);
    const headers = buildNextHeadersMock(session, guildId);
    holder.cookies = headers.cookies;
    holder.headers = headers.headers;
    const product = await admin.from('products').insert({ id: productId, guild_id: guildId, name: 'Existing SDK project', type: 'free', delivery_type: 'file', price_cents: 0, active: false, metadata: { note: 'original' } });
    expect(product.error).toBeNull();
  });
  afterAll(async () => {
    await admin.from('products').delete().eq('guild_id', guildId);
    await admin.from('audit_logs').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
    vi.unstubAllEnvs();
  });
  async function readProduct() {
    const result = await admin.from('products').select('*, plans(*), product_files(*), product_license_config(*)').eq('id', productId).eq('guild_id', guildId).single();
    expect(result.error).toBeNull();
    return z.object({ metadata: z.record(z.unknown()) }).passthrough().parse(result.data);
  }

  it('rejects generic forgery, preserves issued proof, and rejects persisted tampering after real database round trips', async () => {
    // Given: an owner session and an inactive product read from the real database.
    const receiptApi = await import('@/app/api/license/config/[productId]/integration-receipt/route');
    const productApi = await import('@/app/api/store/products/route');
    const initialResponse = await receiptApi.GET(request(), params);
    expect(initialResponse.status).toBe(200);
    const initial = z.object({ data: z.object({ identity: z.object({ storeProductId: z.string(), deploymentOrigin: z.string(), contractHash: z.string(), productPolicyRevision: z.string() }) }) }).parse(await initialResponse.json());
    const identity = buildSdkContractIdentity(initial.data.identity);
    const verification = await signedSdkVerification(identity);
    // When: the owner issues authentic evidence, then edits unrelated product metadata.
    expect((await receiptApi.PUT(request({ verification }), params)).status).toBe(200);
    const issued = await readProduct();
    expect((await productApi.PUT(request({ id: productId, metadata: { note: 'updated' } }))).status).toBe(200);
    // Then: persisted proof survives normal edits, while owner injection and storage tampering fail closed.
    const preserved = await readProduct();
    expect(preserved.metadata[SDK_RECEIPT_METADATA_KEY]).toEqual(issued.metadata[SDK_RECEIPT_METADATA_KEY]);
    expect(preserved.metadata[SDK_ATTESTATION_METADATA_KEY]).toEqual(verification);
    expect(await verifyLaunchSdkIntegration(preserved, identity.deploymentOrigin)).toBe(true);
    expect(await (await receiptApi.GET(request(), params)).json()).toMatchObject({ data: { driftState: 'current' } });
    expect((await productApi.PUT(request({ id: productId, metadata: { [SDK_RECEIPT_METADATA_KEY]: issued.metadata[SDK_RECEIPT_METADATA_KEY] } }))).status).toBe(400);
    const storedReceipt = z.record(z.unknown()).parse(issued.metadata[SDK_RECEIPT_METADATA_KEY]);
    const tampered = await admin.from('products').update({ metadata: { ...preserved.metadata, [SDK_RECEIPT_METADATA_KEY]: { ...storedReceipt, targetProjectCommit: 'forged-through-storage' } } }).eq('id', productId).eq('guild_id', guildId);
    expect(tampered.error).toBeNull();
    expect(await (await receiptApi.GET(request(), params)).json()).toMatchObject({ data: { driftState: 'implementation_unverified' } });
    expect(await verifyLaunchSdkIntegration(await readProduct(), identity.deploymentOrigin)).toBe(false);
    const historical = await admin.from('products').update({ metadata: { [SDK_RECEIPT_METADATA_KEY]: storedReceipt } }).eq('id', productId).eq('guild_id', guildId);
    expect(historical.error).toBeNull();
    expect(await (await receiptApi.GET(request(), params)).json()).toMatchObject({ data: { driftState: 'implementation_unverified' } });
  });
});
