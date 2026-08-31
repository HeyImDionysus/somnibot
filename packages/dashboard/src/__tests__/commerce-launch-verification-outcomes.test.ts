import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSavedProductLicensingSdkBundle } from '@/lib/store/licensing-sdk-bundle';
import { savedProductToLicensingDraft, savedProductToPolicyIdentityInput } from '@/lib/store/licensing-handoff';
import { createVerifiedSdkIntegrationReceipt } from '@/lib/store/sdk-integration-provenance';
import { signedSdkVerification, SDK_TEST_SIGNING_SECRET } from '../__fixtures__/sdk-verification';
import { POST } from '@/app/api/store/launch-runs/[id]/verify/route';
import { createMockSupabase, registerTable, buildRequest } from './helpers';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: async () => null }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: async () => ({ ok: true, ctx: { guildId: 'guild-1', discordId: 'owner-1' } }) }));
const admin = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: admin.create }));
vi.mock('@/lib/paypal-policy', () => ({ loadPayPalPolicy: async () => ({ environment: 'sandbox' }) }));

const ID = '00000000-0000-4000-8000-000000000201';
const PRODUCT = '00000000-0000-4000-8000-000000000202';
const ORDER = '00000000-0000-4000-8000-000000000203';
const PAYMENT = '00000000-0000-4000-8000-000000000204';
const START = '2026-08-23T12:00:00.000Z';
const PURCHASE = '2026-08-23T12:01:00.000Z';
const REVISION = '2026-08-23T12:02:00.000Z';
const policy = { product_id: PRODUCT, updated_at: START, license_mode: 'portal_only', key_prefix: 'SMNI', max_devices: 3,
  heartbeat_interval_seconds: 300, sdk_cache_ttl_ms: 60000, offline_grace_period_seconds: 86400, feature_flags: [],
  require_discord_guild_membership: false, rotation_policy: 'rotate-and-invalidate', self_service_device_removal: true };

async function fixture(type: 'free' | 'one_time' | 'subscription' = 'free', deliveryType = 'license_key') {
  const mock = createMockSupabase();
  admin.create.mockReturnValue(mock);
  const product = { id: PRODUCT, name: 'Launch product', description: null, active: false, type, delivery_type: deliveryType,
    price_cents: type === 'free' ? 0 : 100, updated_at: START, product_license_config: deliveryType === 'license_key' ? policy : null,
    plans: [], product_files: deliveryType === 'file' ? [{ id: ID, created_at: START }] : [],
    metadata: deliveryType === 'file' ? { completed_project_licensing: { outputFormats: 'ZIP' } } : {}, granted_role_ids: [], granted_channel_ids: [] };
  const draft = await savedProductToLicensingDraft(product, 'https://dashboard.example/api');
  const bundle = await buildSavedProductLicensingSdkBundle({ projectName: draft.projectName, projectContext: draft.projectContext,
    apiBase: 'https://dashboard.example/api', plansAndFeatures: draft.plansAndFeatures, installationIdentity: draft.installationIdentity,
    policy: savedProductToPolicyIdentityInput(product), capabilities: [] });
  const attestation = await signedSdkVerification({ contractHash: bundle.contractIdentity.value,
    productPolicyRevision: bundle.files['somnibot-sdk.json'].content.productPolicyRevision,
    sdkSchemaVersion: 1, sdkProtocolVersion: 2, storeProductId: PRODUCT, deploymentOrigin: 'https://dashboard.example' });
  const receipt = createVerifiedSdkIntegrationReceipt(attestation);
  const saved = { ...product, metadata: { ...product.metadata, somnibot_sdk_integration_receipt: receipt, somnibot_sdk_integration_attestation: attestation } };
  const run = { id: ID, product_id: PRODUCT, operation_id: ID, is_tutorial: false, version: 1, verification_started_at: START };
  const rows: Record<string, unknown> = {
    commerce_product_launch_runs: run, products: saved, product_license_config: { ...policy }, product_files: product.product_files,
    commerce_free_claims: type === 'free' ? [{ request_id: ID, order_id: ORDER, product_id: PRODUCT, created_at: PURCHASE }] : [],
    commerce_checkout_intents: type === 'free' ? [] : [{ token: ID, order_id: ORDER, product_id: PRODUCT, created_at: PURCHASE }],
    orders: [{ id: ORDER, product_id: PRODUCT, status: type === 'free' ? 'completed' : 'refunded',
      paypal_order_id: type === 'one_time' ? 'PP-ORDER' : null, paypal_subscription_id: type === 'subscription' ? 'SUB-1' : null,
      created_at: PURCHASE, updated_at: PURCHASE }],
    payments: type === 'free' ? [] : [{ id: PAYMENT, order_id: ORDER, status: 'refunded', paypal_payment_id: 'PAY-1', paypal_event_id: 'EV-1' }],
    entitlements: [{ id: ID, order_id: ORDER, product_id: PRODUCT, status: type === 'free' ? 'active' : 'cancelled' }],
    license_keys: deliveryType === 'license_key' ? [{ id: ID, order_id: ORDER, status: 'pending_activation' }] : [],
    commerce_download_deliveries: deliveryType === 'file' ? [{ id: ID, order_id: ORDER, product_id: PRODUCT, file_id: ID, delivered_at: PURCHASE }] : [],
    commerce_fulfillment_outward_intents: [{ id: ID, order_id: ORDER, intent_kind: 'receipt_dm', state: 'sent', sent_at: PURCHASE, outward_generation_id: ID }],
    commerce_role_delivery_intents: [],
    payment_refunds: type === 'free' ? [] : [{ id: ID, order_id: ORDER, payment_id: PAYMENT, paypal_refund_id: 'REF-1' }],
    portal_cancellation_operations: type === 'subscription' ? [{ id: ID, order_id: ORDER, status: 'completed' }] : [],
    webhook_events: type === 'free' ? [] : [
      { event_id: 'EV-1', event_type: type === 'subscription' ? 'PAYMENT.SALE.COMPLETED' : 'PAYMENT.CAPTURE.COMPLETED', result: 'success',
        payload: { resource: { id: 'PAY-1', billing_agreement_id: 'SUB-1', supplementary_data: { related_ids: { order_id: 'PP-ORDER' } } } } },
      { event_id: 'EV-2', event_type: type === 'subscription' ? 'PAYMENT.SALE.REFUNDED' : 'PAYMENT.CAPTURE.REFUNDED', result: 'success', payload: { resource: { id: 'REF-1' } } },
    ],
  };
  for (const table of Object.keys(rows)) {
    const query = registerTable(mock, table);
    query.maybeSingle.mockImplementation(async () => ({ data: rows[table], error: null }));
    query.limit.mockImplementation(async () => ({ data: rows[table], error: null }));
  }
  mock.rpc.mockImplementation(async (_name: string, args: Readonly<Record<string, unknown>>) => ({
    data: { ...run, state: args.p_ready ? 'ready' : 'sandbox_verifying', launch_receipt: args.p_receipt }, error: null,
  }));
  return { mock, rows, saved, receipt };
}

async function verify() {
  const response = await POST(buildRequest(`/api/store/launch-runs/${ID}/verify`, { method: 'POST' }), { params: Promise.resolve({ id: ID }) });
  return { response, body: await response.json() };
}

describe('launch verifier observable readiness', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('DASHBOARD_URL', 'https://dashboard.example'); vi.stubEnv('SDK_VERIFICATION_SIGNING_SECRET', SDK_TEST_SIGNING_SECRET); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each(['free', 'one_time', 'subscription'] as const)('returns ready for a delivered current %s journey', async (type) => {
    await fixture(type);
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation).toEqual({ state: 'ready', missing: [] });
    expect(body.data.state).toBe('ready');
  });

  it.each(['pending', 'sending', 'failed', 'uncertain', 'absent'])('blocks free readiness when delivery is %s', async (state) => {
    const { rows } = await fixture();
    rows.commerce_fulfillment_outward_intents = state === 'absent' ? [] : [{ id: ID, order_id: ORDER, intent_kind: 'receipt_dm', state, sent_at: null }];
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation.state).toBe('blocked');
    expect(body.data.state).toBe('sandbox_verifying');
    expect(body.evaluation.missing).toContain('fulfillment');
  });

  it.each(['products', 'product_license_config'])('does not launder a pre-revision journey after editing %s', async (table) => {
    const { rows, saved } = await fixture();
    rows[table] = table === 'products' ? { ...saved, price_cents: 10, updated_at: REVISION } : { ...policy, max_devices: 5, updated_at: REVISION };
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation.state).toBe('blocked');
    expect(body.evidence.order_ids).toEqual([]);
    expect(body.evaluation.missing).toContain('entitlement');
  });

  it('rejects a journey older than the product revision within the same millisecond', async () => {
    const { rows, saved } = await fixture();
    rows.products = { ...saved, updated_at: '2026-08-23T12:01:00.000900Z' };
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation.state).toBe('blocked');
    expect(body.evidence.order_ids).toEqual([]);
    expect(body.evidence.proof_after).toBe('2026-08-23T12:01:00.000900Z');
  });

  it('accepts genuinely post-revision proof in the same millisecond without rounding it away', async () => {
    const { rows, saved } = await fixture();
    const after = '2026-08-23T12:01:00.000900Z';
    rows.products = { ...saved, updated_at: '2026-08-23T12:01:00.000100Z' };
    rows.commerce_free_claims = [{ request_id: ID, order_id: ORDER, product_id: PRODUCT, created_at: after }];
    rows.orders = [{ id: ORDER, product_id: PRODUCT, status: 'completed', paypal_order_id: null, paypal_subscription_id: null, created_at: after }];
    rows.commerce_fulfillment_outward_intents = [{ id: ID, order_id: ORDER, intent_kind: 'receipt_dm', state: 'sent', sent_at: after, outward_generation_id: ID }];
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation).toEqual({ state: 'ready', missing: [] });
    expect(body.evidence.proof_after).toBe('2026-08-23T12:01:00.000100Z');
  });

  it.each(['contractHash', 'productPolicyRevision', 'storeProductId', 'deploymentOrigin', 'integrityResult', 'authenticityResult', 'conformanceResult', 'issuedBy', 'remainingUnverifiedRequirements'])('blocks dynamic integration with mismatched %s', async (field) => {
    const { saved, receipt } = await fixture();
    const altered: Record<string, unknown> = { contractHash: 'c'.repeat(64), productPolicyRevision: `sha256:${'d'.repeat(64)}`,
      storeProductId: ORDER, deploymentOrigin: 'https://other.example', integrityResult: 'unverified', authenticityResult: 'unverified',
      conformanceResult: 'failed', issuedBy: 'legacy-unverified', remainingUnverifiedRequirements: ['revocation'] };
    saved.metadata.somnibot_sdk_integration_receipt = { ...receipt, [field]: altered[field] };
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation.state).toBe('blocked');
    expect(body.evaluation.missing).toContain('integration');
  });

  it('preserves static download readiness without binding unrelated license policy revisions', async () => {
    const { rows, saved } = await fixture();
    rows.products = { ...saved, delivery_type: 'file', metadata: {}, product_files: [{ id: ID, created_at: START }] };
    rows.product_files = [{ id: ID, created_at: START }];
    rows.product_license_config = { ...policy, updated_at: REVISION };
    rows.license_keys = [];
    rows.commerce_fulfillment_outward_intents = [];
    rows.commerce_download_deliveries = [{ id: ID, order_id: ORDER, file_id: ID, product_id: PRODUCT, delivered_at: PURCHASE }];
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation).toEqual({ state: 'ready', missing: [] });
    expect(body.evidence.policy_revision).toBeNull();
  });

  it.each(['free', 'one_time', 'subscription'] as const)('proves delivered %s access without requiring download files', async (type) => {
    const { rows, saved } = await fixture(type);
    rows.products = { ...saved, delivery_type: 'access_pass', metadata: {}, granted_role_ids: ['role-1'], granted_channel_ids: ['channel-1'] };
    rows.license_keys = [];
    rows.commerce_role_delivery_intents = [{ id: ID, order_id: ORDER, product_id: PRODUCT, entitlement_id: ID,
      permanent_role_ids: ['role-1'], completed_role_ids: ['role-1'], delivery_confirmed_at: PURCHASE,
      completed_channel_ids: ['channel-1'], channel_delivery_confirmed_at: PURCHASE,
      state: type === 'free' ? 'open' : 'settled', outward_generation_id: ID }];
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation).toEqual({ state: 'ready', missing: [] });
  });

  it.each(['channel-only', 'mixed'] as const)('blocks %s access when channels have no delivery acknowledgment', async (kind) => {
    // Given current role/receipt evidence but no acknowledgment of the configured channel.
    const { rows, saved } = await fixture();
    const roles = kind === 'mixed' ? ['role-1'] : [];
    rows.products = { ...saved, delivery_type: 'access_pass', metadata: {}, granted_role_ids: roles, granted_channel_ids: ['channel-1'] };
    rows.commerce_role_delivery_intents = [{ id: ID, order_id: ORDER, product_id: PRODUCT, entitlement_id: ID,
      permanent_role_ids: roles, completed_role_ids: roles, delivery_confirmed_at: PURCHASE,
      state: 'open', outward_generation_id: ID }];
    // When the launch proof is evaluated.
    const { response, body } = await verify();
    // Then role and receipt evidence cannot stand in for channel delivery.
    expect(response.status).toBe(200);
    expect(body.evaluation.missing).toContain('fulfillment');
    expect(body.data.state).toBe('sandbox_verifying');
  });

  it.each(['complete', 'partial', 'stale', 'receipt-before-channel', 'wrong-generation'] as const)('evaluates channel-only access with %s acknowledgment', async (state) => {
    // Given an exact channel vector acknowledged on one delivery generation.
    const { rows, saved } = await fixture();
    rows.products = { ...saved, delivery_type: 'access_pass', metadata: {}, granted_role_ids: [], granted_channel_ids: ['channel-1', 'channel-2'] };
    rows.commerce_role_delivery_intents = [{ id: ID, order_id: ORDER, product_id: PRODUCT, entitlement_id: ID,
      permanent_role_ids: [], completed_role_ids: [], delivery_confirmed_at: PURCHASE,
      completed_channel_ids: state === 'partial' ? ['channel-1'] : ['channel-1', 'channel-2'],
      channel_delivery_confirmed_at: state === 'stale' ? '2026-08-22T12:00:00.000Z' : state === 'receipt-before-channel' ? REVISION : PURCHASE,
      state: 'open', outward_generation_id: state === 'wrong-generation' ? PAYMENT : ID }];
    // When the launch proof is evaluated.
    const { response, body } = await verify();
    // Then only a complete, fresh acknowledgment followed by the matching receipt proves delivery.
    expect(response.status).toBe(200);
    expect(body.evaluation.missing.includes('fulfillment')).toBe(state !== 'complete');
    expect(body.data.state).toBe(state === 'complete' ? 'ready' : 'sandbox_verifying');
  });

  it.each(['queued', 'failed', 'partial', 'wrong-entitlement', 'wrong-generation', 'receipt-uncertain'])('blocks access fulfillment when delivery is %s', async (state) => {
    const { rows, saved } = await fixture();
    rows.products = { ...saved, delivery_type: 'access_pass', metadata: {}, granted_role_ids: ['role-1'] };
    rows.product_files = [{ id: ID, created_at: START }];
    rows.license_keys = [];
    rows.commerce_role_delivery_intents = state === 'queued' ? [] : [{ id: ID, order_id: ORDER, product_id: PRODUCT,
      entitlement_id: state === 'wrong-entitlement' ? PAYMENT : ID, permanent_role_ids: ['role-1'],
      completed_role_ids: state === 'partial' ? [] : ['role-1'], delivery_confirmed_at: state === 'failed' ? null : PURCHASE,
      state: state === 'failed' ? 'operator_required' : 'open', outward_generation_id: state === 'wrong-generation' ? PAYMENT : ID }];
    if (state === 'receipt-uncertain') rows.commerce_fulfillment_outward_intents = [{ id: ID, order_id: ORDER, intent_kind: 'receipt_dm', state: 'uncertain', sent_at: null }];
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation.state).toBe('blocked');
    expect(body.evaluation.missing).toContain('fulfillment');
  });

  it('accepts a current server-verified static SDK receipt with a current file download', async () => {
    await fixture('free', 'file');
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation).toEqual({ state: 'ready', missing: [] });
  });

  it('blocks a declared completed-project static integration with no server verification receipt', async () => {
    const { rows, saved } = await fixture('free', 'file');
    rows.products = { ...saved, metadata: { completed_project_licensing: { outputFormats: 'ZIP' } } };
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation.state).toBe('blocked');
    expect(body.evaluation.missing).toContain('integration');
  });

  it.each(['removed-file', 'stale-download', 'new-file', 'stale-sdk'])('blocks static readiness for %s evidence', async (state) => {
    const { rows, saved } = await fixture();
    rows.products = { ...saved, delivery_type: 'file', metadata: state === 'stale-sdk' ? { ...saved.metadata, completed_project_licensing: { outputFormats: 'ZIP' } } : {}, product_files: [{ id: ID }] };
    rows.product_files = [{ id: ID, created_at: state === 'new-file' ? REVISION : START }];
    rows.commerce_download_deliveries = [{ id: ID, order_id: ORDER, product_id: PRODUCT,
      file_id: state === 'removed-file' ? null : ID, delivered_at: state === 'stale-download' ? '2026-08-22T12:00:00.000Z' : PURCHASE }];
    rows.license_keys = [];
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation.state).toBe('blocked');
    expect(body.evaluation.missing).toContain(state === 'stale-sdk' ? 'integration' : 'fulfillment');
  });

  it('rejects mismatched subscription identity in the actual webhook response', async () => {
    const { rows } = await fixture('subscription');
    rows.webhook_events = [{ event_id: 'EV-1', event_type: 'PAYMENT.SALE.COMPLETED', result: 'success',
      payload: { resource: { id: 'PAY-1', billing_agreement_id: 'SUB-OTHER' } } }];
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation.state).toBe('blocked');
    expect(body.evaluation.missing).toContain('webhook');
  });

  it('reports missing dynamic policy as blocked rather than treating an old receipt as integration proof', async () => {
    const { rows } = await fixture();
    rows.product_license_config = null;
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.evaluation.state).toBe('blocked');
    expect(body.evaluation.missing).toEqual(expect.arrayContaining(['policy', 'integration']));
  });

  it('returns conflict when the atomic snapshot check loses', async () => {
    const { mock } = await fixture();
    mock.rpc.mockResolvedValue({ data: null, error: null });
    const { response } = await verify();
    expect(response.status).toBe(409);
  });

  it('does not return success when atomic verification audit fails', async () => {
    const { mock } = await fixture();
    mock.rpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'audit write rejected' } });
    const { response } = await verify();
    expect(response.status).toBe(500);
  });
});
