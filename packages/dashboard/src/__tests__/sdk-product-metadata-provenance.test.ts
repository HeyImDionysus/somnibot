import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SDK_TEST_SIGNING_SECRET, signedSdkVerification } from '@/__fixtures__/sdk-verification';
import { buildSdkContractIdentity } from '@/lib/store/sdk-contract-identity';
import { verifyLaunchSdkIntegration } from '@/lib/store/sdk-launch-integration';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const GUILD_ID = '333333333333333333';
const identity = buildSdkContractIdentity({ storeProductId: PRODUCT_ID, deploymentOrigin: 'https://dashboard.example', contractHash: 'b'.repeat(64), productPolicyRevision: `sha256:${'a'.repeat(64)}` });
let metadata: Record<string, unknown> = {};
function savedProduct() {
  return { id: PRODUCT_ID, guild_id: GUILD_ID, name: 'Project', description: null, type: 'free', delivery_type: 'license_key', price_cents: 0, active: false, granted_role_ids: [], granted_channel_ids: [], metadata, updated_at: '2026-08-23T12:00:00.000Z', plans: [], product_files: [], product_license_config: [] };
}
function databaseDouble() {
  return {
    from(table: string) {
      let patch: Record<string, unknown> | null = null;
      const filters: Record<string, unknown> = {};
      const resolve = async () => {
        if (table !== 'products' || filters.id !== PRODUCT_ID || filters.guild_id !== GUILD_ID) return { data: null, error: null };
        if (patch?.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)) metadata = Object.fromEntries(Object.entries(patch.metadata));
        return { data: savedProduct(), error: null };
      };
      const chain = {
        select() { return chain; },
        eq(key: string, value: unknown) { filters[key] = value; return chain; },
        update(value: Record<string, unknown>) { patch = value; return chain; },
        maybeSingle: resolve,
        single: resolve,
      };
      return chain;
    },
  };
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => databaseDouble() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: async () => ({ ok: true, ctx: { guildId: GUILD_ID, discordId: 'owner' } }) }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: async () => null }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: async () => {} }));
vi.mock('@/lib/admin-changes', () => ({ recordAdminChange: async () => {}, recordCrudChange: async () => {}, readRowBefore: async () => null, undoByRestoring: () => ({ kind: 'db' }) }));
vi.mock('@/lib/store/licensing-handoff', async (original) => ({
  ...await original<Record<string, unknown>>(),
  savedLicensingProductSchema: { parse: (value: unknown) => value },
  savedProductToLicensingDraft: async () => ({ projectName: 'Project', projectContext: 'Existing app', plansAndFeatures: '', installationIdentity: 'device' }),
  savedProductToPolicyIdentityInput: () => ({ storeProductId: PRODUCT_ID }),
}));
vi.mock('@/lib/store/licensing-sdk-bundle', () => ({ buildSavedProductLicensingSdkBundle: async () => ({ contractIdentity: { value: 'b'.repeat(64) }, files: { 'somnibot-sdk.json': { content: { productPolicyRevision: `sha256:${'a'.repeat(64)}` } } } }) }));

function request(body?: unknown) {
  return new NextRequest('https://dashboard.example/api/store/products', { method: body === undefined ? 'GET' : 'PUT', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
}
const params = { params: Promise.resolve({ productId: PRODUCT_ID }) };
async function issueReceipt() {
  const { PUT } = await import('@/app/api/license/config/[productId]/integration-receipt/route');
  const response = await PUT(request({ verification: await signedSdkVerification(identity) }), params);
  expect(response.status).toBe(200);
}
beforeEach(() => {
  metadata = { note: 'original' };
  vi.stubEnv('DASHBOARD_URL', identity.deploymentOrigin);
  vi.stubEnv('SDK_VERIFICATION_SIGNING_SECRET', SDK_TEST_SIGNING_SECRET);
});

describe('generic product metadata to SDK readback and launch trust', () => {
  it.each([
    ['receipt commit', 'somnibot_sdk_integration_receipt', 'targetProjectCommit', 'modified'],
    ['receipt verification id', 'somnibot_sdk_integration_receipt', 'verificationId', 'invented'],
    ['receipt timestamp', 'somnibot_sdk_integration_receipt', 'integratedAt', '2026-08-24T12:00:00.000Z'],
    ['signed project commit', 'somnibot_sdk_integration_attestation', 'targetProjectCommit', 'modified'],
    ['signature', 'somnibot_sdk_integration_attestation', 'signature', 'a'.repeat(43)],
  ])('rejects persisted tampering of %s at readback and launch', async (_name, key, field, value) => {
    // Given: a genuine receipt whose stored evidence was replaced by another metadata writer.
    await issueReceipt();
    const original = metadata[key];
    if (!original || typeof original !== 'object' || Array.isArray(original)) throw new TypeError('Expected issued provenance');
    metadata[key] = { ...original, [field]: value };
    // When: the owner reads integration state from storage.
    const { GET } = await import('@/app/api/license/config/[productId]/integration-receipt/route');
    const response = await GET(request(), params);
    // Then: modified labels and modified signed evidence fail closed at both trust surfaces.
    expect(await response.json()).toMatchObject({ data: { driftState: 'implementation_unverified' } });
    expect(await verifyLaunchSdkIntegration(savedProduct(), identity.deploymentOrigin)).toBe(false);
  });

  it.each(['', 'short', 'rotated-signing-secret-with-at-least-32-bytes'])('fails closed when the verification key is unavailable or rotated: %s', async (secret) => {
    // Given: issued evidence with a missing, invalid, or rotated verifier key.
    await issueReceipt();
    vi.stubEnv('SDK_VERIFICATION_SIGNING_SECRET', secret);
    // When: integration state is read with the current deployment configuration.
    const { GET } = await import('@/app/api/license/config/[productId]/integration-receipt/route');
    const response = await GET(request(), params);
    // Then: key availability never promotes stored labels to authentic evidence.
    expect(await response.json()).toMatchObject({ data: { driftState: 'implementation_unverified' } });
    expect(await verifyLaunchSdkIntegration(savedProduct(), identity.deploymentOrigin)).toBe(false);
  });

  it('rejects an authentic receipt on a different deployment origin', async () => {
    // Given: a genuine receipt bound to this deployment.
    await issueReceipt();
    // When: a launch on another origin checks that receipt.
    const current = await verifyLaunchSdkIntegration(savedProduct(), 'https://other.example');
    // Then: valid signatures do not bypass contract identity drift.
    expect(current).toBe(false);
  });

  it('rejects owner forgery at the generic product route and remains unverified on readback and launch', async () => {
    // Given: copied current contract identity with owner-authored verification labels.
    const forged = { ...identity, receiptSchemaVersion: 2, issuedBy: 'somnibot-server', verificationId: 'forged', targetProjectVersion: '1', targetProjectCommit: 'fake', verificationEnvironment: { kind: 'ci', description: 'invented' }, capabilitiesExercised: [], remainingUnverifiedRequirements: [], integrityResult: 'passed', authenticityResult: 'passed', conformanceResult: 'passed', integratedAt: '2026-08-23T12:00:00.000Z' };
    // When: an owner uses the ordinary product update endpoint.
    const { PUT } = await import('@/app/api/store/products/route');
    const response = await PUT(request({ id: PRODUCT_ID, metadata: { somnibot_sdk_integration_receipt: forged } }));
    // Then: the writer rejects it and both downstream trust surfaces remain unverified.
    expect(response.status).toBe(400);
    const { GET } = await import('@/app/api/license/config/[productId]/integration-receipt/route');
    expect(await (await GET(request(), params)).json()).toMatchObject({ data: { driftState: 'implementation_unverified' } });
    expect(await verifyLaunchSdkIntegration(savedProduct(), identity.deploymentOrigin)).toBe(false);
  });

  it('preserves genuinely issued proof through an ordinary metadata edit and authoritative readback', async () => {
    // Given: a receipt issued by the real endpoint from a signed conformance package.
    await issueReceipt();
    const issued = { ...metadata };
    // When: the owner changes unrelated metadata through the generic product route.
    const { PUT } = await import('@/app/api/store/products/route');
    const response = await PUT(request({ id: PRODUCT_ID, metadata: { note: 'updated' } }));
    // Then: the signed receipt survives and is current at readback and launch.
    expect(response.status).toBe(200);
    expect(metadata).toMatchObject({ ...issued, note: 'updated' });
    const { GET } = await import('@/app/api/license/config/[productId]/integration-receipt/route');
    expect(await (await GET(request(), params)).json()).toMatchObject({ data: { driftState: 'current' } });
    expect(await verifyLaunchSdkIntegration(savedProduct(), identity.deploymentOrigin)).toBe(true);
  });
});
