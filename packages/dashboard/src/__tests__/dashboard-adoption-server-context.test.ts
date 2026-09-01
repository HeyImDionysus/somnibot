import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSupabase, registerTable } from './helpers/mock-supabase';
import { SDK_TEST_SIGNING_SECRET, signedSdkVerification } from '@/__fixtures__/sdk-verification';
import { buildSdkContractIdentity } from '@/lib/store/sdk-contract-identity';
import { createVerifiedSdkIntegrationReceipt } from '@/lib/store/sdk-integration-provenance';

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: mocks.admin }));
vi.mock('@/lib/store/licensing-handoff', async (original) => ({
  ...await original<Record<string, unknown>>(),
  savedLicensingProductSchema: { parse: (value: unknown) => value },
  savedProductToLicensingDraft: async () => ({ projectName: 'Project', projectContext: 'App', plansAndFeatures: '', installationIdentity: 'device' }),
  savedProductToPolicyIdentityInput: () => ({ storeProductId: '11111111-1111-4111-8111-111111111111' }),
}));
vi.mock('@/lib/store/licensing-sdk-bundle', () => ({ buildSavedProductLicensingSdkBundle: async () => ({ contractIdentity: { value: 'b'.repeat(64) }, files: { 'somnibot-sdk.json': { content: { productPolicyRevision: `sha256:${'a'.repeat(64)}` } } } }) }));
import { readAdoptionServerContext } from '@/lib/dashboard/adoption-server-context';

const identity = buildSdkContractIdentity({ storeProductId: '11111111-1111-4111-8111-111111111111', deploymentOrigin: 'https://dashboard.example', contractHash: 'b'.repeat(64), productPolicyRevision: `sha256:${'a'.repeat(64)}` });
const revision = '2026-08-31T15:00:00Z';
let metadata: Record<string, unknown>;

beforeEach(async () => {
  vi.stubEnv('DASHBOARD_URL', identity.deploymentOrigin);
  vi.stubEnv('SDK_VERIFICATION_SIGNING_SECRET', SDK_TEST_SIGNING_SECRET);
  const attestation = await signedSdkVerification(identity);
  metadata = { somnibot_sdk_integration_receipt: createVerifiedSdkIntegrationReceipt(attestation), somnibot_sdk_integration_attestation: attestation };
  const db = createMockSupabase();
  registerTable(db, 'dashboard_user_roles').then.mockImplementation((resolve) => resolve({ data: [], error: null }));
  registerTable(db, 'dashboard_adoption_config_epochs').then.mockImplementation((resolve) => resolve({ data: [{ track_id: 'store', revision: 2 }, { track_id: 'licensing', revision: 3 }], error: null }));
  registerTable(db, 'commerce_product_launch_runs').maybeSingle.mockResolvedValue({ data: { product_id: identity.storeProductId }, error: null });
  registerTable(db, 'products').maybeSingle.mockImplementation(async () => ({ data: { id: identity.storeProductId, updated_at: revision, delivery_type: 'license_key', type: 'free', metadata }, error: null }));
  registerTable(db, 'product_license_config').maybeSingle.mockResolvedValue({ data: { updated_at: revision }, error: null });
  for (const table of ['product_files', 'plans']) registerTable(db, table).then.mockImplementation((resolve) => resolve({ data: [], error: null }));
  mocks.admin.mockReturnValue(db);
});
afterEach(() => vi.unstubAllEnvs());

describe('server-derived adoption SDK context', () => {
  it('verifies an unchanged authentic free-product receipt using the real signature verifier', async () => {
    expect(await readAdoptionServerContext('guild-1')).toMatchObject({ productId: identity.storeProductId, productRevision: revision, policyRevision: revision, integrationVerified: true, storeRevision: 2, licensingRevision: 3 });
  });
  it('rejects a genuinely signed receipt after origin drift', async () => {
    vi.stubEnv('DASHBOARD_URL', 'https://changed.example');
    expect(await readAdoptionServerContext('guild-1')).toMatchObject({ integrationVerified: false });
  });
  it('rejects old signatures after signing-key rotation', async () => {
    vi.stubEnv('SDK_VERIFICATION_SIGNING_SECRET', 'a-new-signing-key-with-at-least-32-characters');
    expect(await readAdoptionServerContext('guild-1')).toMatchObject({ integrationVerified: false });
  });
  it('does not trust plaintext SDK receipt metadata without its signed attestation', async () => {
    delete metadata.somnibot_sdk_integration_attestation;
    expect(await readAdoptionServerContext('guild-1')).toMatchObject({ integrationVerified: false });
  });
  it('isolates malformed saved commerce metadata from unrelated track checks', async () => {
    registerTable(mocks.admin(), 'products').maybeSingle.mockResolvedValue({ data: { id: 'malformed' }, error: null });
    expect(await readAdoptionServerContext('guild-1')).toEqual({ staff: [], commerceContextUnavailable: true });
  });
  it('does not invent a commercial pass when its database read fails', async () => {
    registerTable(mocks.admin(), 'commerce_product_launch_runs').maybeSingle.mockResolvedValue({ data: null, error: { message: 'Unavailable' } });
    expect(await readAdoptionServerContext('guild-1')).toEqual({ staff: [], commerceContextUnavailable: true });
  });
});
