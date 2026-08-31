import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { SDK_TEST_SIGNING_SECRET, signedSdkVerification } from '@/__fixtures__/sdk-verification';
import { completedProjectLicensingMetadataSchema, hasPendingCompletedProjectPolicy, readCompletedProjectPolicy } from '@/lib/store/licensing-handoff';
import { readVerifiedSdkIntegrationReceiptMetadata } from '@/lib/store/sdk-integration-provenance';
import { buildLicensePolicySaveRequest, prepareStoreProductSave } from '@/lib/store/store-product-policy';

const ID = '11111111-1111-4111-8111-111111111111';
const GUILD = '333333333333333333';
const desiredPolicy = { keyPrefix: 'EDIT', maxDevices: 7, heartbeatIntervalMs: 120000, sdkCacheTtlMs: 30000, offlineGracePeriodSeconds: 3600, featureFlags: ['exports'], requireDiscordGuildMembership: false, rotationPolicy: 'disabled' as const, selfServiceDeviceRemoval: false };
const editedMetadata = completedProjectLicensingMetadataSchema.parse({
  privateIntegrationContext: 'Keep existing native activation, extend export entitlement checks',
  plansAndFeatures: 'Export tools', installationIdentity: 'Stable device installation',
  capabilities: [{ key: 'exports', name: 'Exports', behavioralMeaning: 'Export files', controlledFunctionality: 'Native export command', grantingPlans: [], unavailableBehavior: 'Export is disabled without entitlement', dependencyKeys: [] }],
  policyPending: true, desiredPolicy,
});
let product: Record<string, unknown> = {};
let policy: Record<string, unknown> = {};
let failPolicySave = false;
const rowSchema = z.object({ active: z.boolean(), metadata: z.record(z.unknown()) }).passthrough();
function databaseDouble() {
  return { from(table: string) {
    let patch: Record<string, unknown> | null = null;
    let ignoreDuplicates = false;
    const filters: Record<string, unknown> = {};
    const result = () => {
      if (table === 'products') {
        if (filters.id !== ID || filters.guild_id !== GUILD) return { data: null, error: null };
        if (patch) product = { ...product, ...patch };
        return { data: { ...product, product_license_config: policy }, error: null };
      }
      if (table === 'product_license_config') {
        if (patch && !ignoreDuplicates && failPolicySave) return { data: null, error: { message: 'Injected policy persistence failure' } };
        if (patch && !ignoreDuplicates) policy = { ...policy, ...patch };
        return { data: policy, error: null };
      }
      return { data: null, error: null };
    };
    const chain = {
      select() { return chain; },
      eq(key: string, value: unknown) { filters[key] = value; return chain; },
      update(value: Record<string, unknown>) { patch = value; return chain; },
      upsert(value: Record<string, unknown>, options?: { ignoreDuplicates?: boolean }) { patch = value; ignoreDuplicates = options?.ignoreDuplicates === true; return chain; },
      maybeSingle: async () => result(), single: async () => result(),
      then<TResult1 = ReturnType<typeof result>, TResult2 = never>(onfulfilled?: ((value: ReturnType<typeof result>) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> {
        return Promise.resolve(result()).then(onfulfilled, onrejected);
      },
    };
    return chain;
  } };
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => databaseDouble() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: async () => ({ ok: true, ctx: { guildId: GUILD, discordId: 'owner' } }) }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: async () => null }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: async () => {} }));
vi.mock('@/lib/admin-changes', () => ({ recordAdminChange: async () => {}, recordCrudChange: async () => {}, readRowBefore: async (_db: unknown, table: string) => table === 'products' ? product : policy, undoByRestoring: () => ({ kind: 'db' }), describeSettingChange: () => 'policy settings changed' }));
vi.mock('@/lib/api/commerce-income-wall', async (original) => ({ ...await original<Record<string, unknown>>(), loadProductTemporaryRoleIds: async () => [], assertProductRolesNotIncomeEarning: async () => ({ ok: true }) }));
vi.mock('@/lib/api/live-discord-facts', () => ({ validateAssignableDiscordTargets: async () => ({ ok: true }) }));

const request = (body: unknown) => new NextRequest('https://dashboard.example/api/store/products', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const params = { params: Promise.resolve({ productId: ID }) };
const policyRequest = () => request({ key_prefix: desiredPolicy.keyPrefix, max_devices: desiredPolicy.maxDevices, heartbeat_interval_ms: desiredPolicy.heartbeatIntervalMs, sdk_cache_ttl_ms: desiredPolicy.sdkCacheTtlMs, offline_grace_period_seconds: desiredPolicy.offlineGracePeriodSeconds, feature_flags: desiredPolicy.featureFlags, require_discord_guild_membership: desiredPolicy.requireDiscordGuildMembership, rotation_policy: desiredPolicy.rotationPolicy, self_service_device_removal: desiredPolicy.selfServiceDeviceRemoval });
const editRequest = (active: boolean | undefined = false) => request({ id: ID, name: 'Updated native app', delivery_type: 'license_key', ...(active === undefined ? {} : { active }), metadata: { completed_project_licensing: editedMetadata } });
beforeEach(() => {
  failPolicySave = false;
  vi.stubEnv('DASHBOARD_URL', 'https://dashboard.example');
  vi.stubEnv('SDK_VERIFICATION_SIGNING_SECRET', SDK_TEST_SIGNING_SECRET);
  policy = { product_id: ID, license_mode: 'portal_only', key_prefix: 'SMNI', max_devices: 3, heartbeat_interval_seconds: 300, sdk_cache_ttl_ms: 60000, offline_grace_period_seconds: 86400, feature_flags: [], require_discord_guild_membership: false, rotation_policy: 'rotate-and-invalidate', self_service_device_removal: true };
  product = { id: ID, guild_id: GUILD, name: 'Existing native app', description: null, type: 'free', delivery_type: 'license_key', price_cents: 0, active: true, metadata: {}, updated_at: '2026-08-23T12:00:00.000Z', granted_role_ids: [], granted_channel_ids: [], plans: [], product_files: [] };
});

describe('existing dynamic product edit and policy recovery', () => {
  it('accepts an explicit inactive pending-policy edit without discarding context, capabilities, desired policy, or issued proof', async () => {
    // Given: an existing product with genuinely issued SDK proof.
    const receiptApi = await import('@/app/api/license/config/[productId]/integration-receipt/route');
    const initial = await receiptApi.GET(request({}), params);
    const identity = z.object({ data: z.object({ identity: z.object({ contractHash: z.string(), sdkSchemaVersion: z.number(), sdkProtocolVersion: z.number(), storeProductId: z.string(), deploymentOrigin: z.string(), productPolicyRevision: z.string() }) }) }).parse(await initial.json()).data.identity;
    expect((await receiptApi.PUT(request({ verification: await signedSdkVerification(identity) }), params)).status).toBe(200);
    const issued = await readVerifiedSdkIntegrationReceiptMetadata(rowSchema.parse(product).metadata);
    expect(issued).not.toBeNull();
    // When: the existing dynamic form submits its full policy edit under an inactive lock.
    const { PUT } = await import('@/app/api/store/products/route');
    const response = await PUT(request(prepareStoreProductSave({
      id: ID, name: 'Updated native app', delivery_type: 'license_key', active: true,
      metadata: { completed_project_licensing: editedMetadata },
    })));
    // Then: the saved row is inactive and pending, with edits and authentic proof retained.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { active: false, metadata: { completed_project_licensing: editedMetadata } } });
    const saved = rowSchema.parse(product);
    expect(hasPendingCompletedProjectPolicy(saved.metadata)).toBe(true);
    expect(await readVerifiedSdkIntegrationReceiptMetadata(saved.metadata)).toEqual(issued);
    expect((await PUT(request({ id: ID, active: true }))).status).toBe(409);
    expect(await (await receiptApi.GET(request({}), params)).json()).toMatchObject({ data: { driftState: 'reintegration_required' } });
  });

  it('keeps a failed policy save inactive and recoverable until exact policy save/readback', async () => {
    // Given: the edited product has entered its pending-policy lock.
    const { PUT } = await import('@/app/api/store/products/route');
    expect((await PUT(editRequest())).status).toBe(200);
    failPolicySave = true;
    // When: the policy write fails after the product edit was persisted.
    const policyApi = await import('@/app/api/license/config/[productId]/route');
    const failure = await policyApi.PUT(policyRequest(), params);
    // Then: pending desired policy is retained and activation remains blocked; a retry clears only the exact policy.
    expect(failure.status).toBe(500);
    expect(rowSchema.parse(product)).toMatchObject({ active: false, metadata: { completed_project_licensing: { policyPending: true, desiredPolicy } } });
    expect((await PUT(request({ id: ID, active: true }))).status).toBe(409);
    failPolicySave = false;
    expect((await policyApi.PUT(request({ max_devices: 2 }), params)).status).toBe(200);
    expect(hasPendingCompletedProjectPolicy(rowSchema.parse(product).metadata)).toBe(true);
    const restoredPolicy = readCompletedProjectPolicy(rowSchema.parse(product).metadata);
    if (!restoredPolicy) throw new TypeError('Expected recoverable desired policy');
    const retry = buildLicensePolicySaveRequest(restoredPolicy);
    expect(retry).toMatchObject({ max_devices: 7, key_prefix: 'EDIT', heartbeat_interval_ms: 120000, feature_flags: ['exports'] });
    expect((await policyApi.PUT(request(retry), params)).status).toBe(200);
    expect(rowSchema.parse(product).active).toBe(false);
    expect(hasPendingCompletedProjectPolicy(rowSchema.parse(product).metadata)).toBe(false);
    expect(await (await policyApi.GET(request({}), params)).json()).toMatchObject({ data: { max_devices: 7, key_prefix: 'EDIT', heartbeat_interval_ms: 120000, feature_flags: ['exports'] } });
  });

  it('rejects a policy edit that asks to keep selling', async () => {
    const { PUT } = await import('@/app/api/store/products/route');
    expect((await PUT(editRequest(true))).status).toBe(400);
    expect(rowSchema.parse(product).active).toBe(true);
  });

  it('rejects an edit without an explicit inactive policy lock', async () => {
    const { PUT } = await import('@/app/api/store/products/route');
    expect((await PUT(request({ id: ID, metadata: { completed_project_licensing: editedMetadata } }))).status).toBe(400);
    expect(rowSchema.parse(product).active).toBe(true);
  });

  it.each([
    { ...editedMetadata, policyPending: false },
    { ...editedMetadata, desiredPolicy: undefined },
  ])('rejects incomplete pending-policy metadata %#', async (completedProject) => {
    const { PUT } = await import('@/app/api/store/products/route');
    expect((await PUT(request({ id: ID, active: false, metadata: { completed_project_licensing: completedProject } }))).status).toBe(400);
    expect(rowSchema.parse(product).active).toBe(true);
  });

  it('keeps the original pending desired policy when another edit tries to overwrite recovery', async () => {
    const { PUT } = await import('@/app/api/store/products/route');
    expect((await PUT(editRequest())).status).toBe(200);
    const response = await PUT(request({ id: ID, active: false, metadata: { completed_project_licensing: { ...editedMetadata, desiredPolicy: { ...desiredPolicy, maxDevices: 2 } } } }));
    expect(response.status).toBe(409);
    expect(rowSchema.parse(product)).toMatchObject({ active: false, metadata: { completed_project_licensing: { desiredPolicy } } });
  });

  it('retains activation and metadata for a static form save', () => {
    const result = prepareStoreProductSave({ delivery_type: 'file', active: true, name: 'Static download', metadata: { note: 'unchanged' } });
    expect(result).toEqual({ delivery_type: 'file', active: true, name: 'Static download', metadata: { note: 'unchanged' } });
  });

  it('does not force metadata-free price/title API edits inactive', async () => {
    const { PUT } = await import('@/app/api/store/products/route');
    expect((await PUT(request({ id: ID, name: 'Renamed only', price_cents: 0 }))).status).toBe(200);
    expect(rowSchema.parse(product)).toMatchObject({ name: 'Renamed only', active: true, metadata: {} });
  });
});
