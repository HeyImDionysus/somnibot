import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  buildSdkEvidenceDigest,
  sdkVerificationPayloadSchema,
  signSdkVerificationPayload,
} from '@/lib/store/licensing-sdk-verification';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_ID = '22222222-2222-4222-8222-222222222222';
const GUILD_ID = '333333333333333333';
const UPDATED_AT = '2026-08-23T12:00:00.000Z';
let metadata: Record<string, unknown> = {};
let updatePayload: Record<string, unknown> | null = null;
let updateFilters: Record<string, unknown> = {};
let sdkBuildError: Error | null = null;

function supabaseDouble() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let updating = false;
      const chain = {
        select() { return chain; },
        eq(column: string, value: unknown) {
          filters[column] = value;
          if (updating) updateFilters[column] = value;
          return chain;
        },
        update(payload: Record<string, unknown>) {
          updating = true;
          updatePayload = payload;
          return chain;
        },
        maybeSingle() {
          if (table !== 'products') return Promise.resolve({ data: null, error: null });
          if (updating) return Promise.resolve({ data: { id: PRODUCT_ID }, error: null });
          const owned = filters.id === PRODUCT_ID && filters.guild_id === GUILD_ID;
          return Promise.resolve({
            data: owned ? {
              id: PRODUCT_ID,
              name: 'Desktop Pro',
              description: null,
              type: 'one_time',
              delivery_type: 'license_key',
              granted_role_ids: [],
              granted_channel_ids: [],
              plans: [],
              product_files: [],
              product_license_config: [],
              metadata,
              updated_at: UPDATED_AT,
            } : null,
            error: null,
          });
        },
      };
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => supabaseDouble() }));
vi.mock('@/lib/api/require-owner', () => ({
  requireGuildOwner: async () => ({ ok: true, ctx: { guildId: GUILD_ID, discordId: 'owner' } }),
}));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: async () => null }));
vi.mock('@/lib/store/licensing-handoff', () => ({
  savedLicensingProductSchema: { parse: (value: unknown) => value },
  savedProductToLicensingDraft: async () => ({
    projectName: 'Desktop Pro', projectContext: 'Existing app', plansAndFeatures: '', installationIdentity: 'device',
  }),
  savedProductToPolicyIdentityInput: () => ({ storeProductId: PRODUCT_ID }),
  readCompletedProjectLicensingMetadata: () => ({ capabilities: [] }),
}));
vi.mock('@/lib/store/licensing-sdk-bundle', () => ({
  buildSavedProductLicensingSdkBundle: async () => {
    if (sdkBuildError) throw sdkBuildError;
    return {
      contractIdentity: { value: 'b'.repeat(64) },
      files: { 'somnibot-sdk.json': { content: { productPolicyRevision: `sha256:${'a'.repeat(64)}` } } },
    };
  },
}));

function request(body?: unknown) {
  return new NextRequest(`https://dashboard.example/api/license/config/${PRODUCT_ID}/integration-receipt`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function receipt() {
  return {
    contractHash: 'b'.repeat(64),
    sdkSchemaVersion: 1,
    sdkProtocolVersion: 2,
    productPolicyRevision: `sha256:${'a'.repeat(64)}`,
    storeProductId: PRODUCT_ID,
    deploymentOrigin: 'https://dashboard.example',
    receiptSchemaVersion: 2,
    targetProjectVersion: '2.4.0',
    targetProjectCommit: 'abc1234',
    verificationEnvironment: { kind: 'ci', description: 'Release verification job' },
    capabilitiesExercised: ['exports'],
    remainingUnverifiedRequirements: [],
    integrityResult: 'passed',
    authenticityResult: 'passed',
    conformanceResult: 'passed',
    integratedAt: '2026-08-23T12:00:00.000Z',
  };
}

async function verification() {
  const criterionIds = [
    'compile_build', 'behavioral_preservation', 'activation_ux',
    'structural_capability_enforcement', 'bounded_offline_behavior', 'revocation',
    'deactivation', 'retry_rate_limit_handling', 'secret_leakage',
  ] as const;
  const criteria = criterionIds.map((criterionId) => ({
    criterionId,
    verdict: 'pass' as const,
    evidenceDigests: [`sha256:${'d'.repeat(64)}`],
  }));
  const payload = sdkVerificationPayloadSchema.parse({
    schemaVersion: 1,
    verificationId: 'verification-123',
    issuer: 'somnibot-conformance-runner',
    issuedAt: '2026-08-23T12:00:00.000Z',
    identity: {
      contractHash: 'b'.repeat(64),
      sdkSchemaVersion: 1,
      sdkProtocolVersion: 2,
      productPolicyRevision: `sha256:${'a'.repeat(64)}`,
      storeProductId: PRODUCT_ID,
      deploymentOrigin: 'https://dashboard.example',
    },
    targetProjectVersion: '2.4.0',
    targetProjectCommit: 'abc1234',
    verificationEnvironment: { kind: 'ci', description: 'Release verification job' },
    capabilitiesExercised: ['exports'],
    remainingUnverifiedRequirements: [],
    evidenceDigest: await buildSdkEvidenceDigest(criteria),
    criteria,
  });
  return {
    ...payload,
    signature: await signSdkVerificationPayload(
      payload,
      'test-signing-secret-with-at-least-32-bytes',
    ),
  };
}

beforeEach(() => {
  metadata = { completed_project_licensing: { policyPending: false }, preserve: 'yes' };
  process.env.DASHBOARD_URL = 'https://dashboard.example';
  updatePayload = null;
  updateFilters = {};
  sdkBuildError = null;
  process.env.SDK_VERIFICATION_SIGNING_SECRET = 'test-signing-secret-with-at-least-32-bytes';
});

describe('SDK integration receipt owner API', () => {
  it('rejects previously persisted forged server labels on authoritative readback', async () => {
    // Given: a historical generic metadata write persisted schema-valid forged labels.
    metadata.somnibot_sdk_integration_receipt = { ...receipt(), issuedBy: 'somnibot-server', verificationId: 'forged' };
    // When: the owner reads the authoritative SDK integration state.
    const { GET } = await import('../app/api/license/config/[productId]/integration-receipt/route');
    const response = await GET(request(), { params: Promise.resolve({ productId: PRODUCT_ID }) });
    // Then: labels without cryptographic evidence cannot produce current state.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { driftState: 'implementation_unverified' } });
  });
  it('does not reveal a product owned by another guild', async () => {
    const { GET } = await import('../app/api/license/config/[productId]/integration-receipt/route');
    const response = await GET(request(), { params: Promise.resolve({ productId: FOREIGN_ID }) });
    expect(response.status).toBe(404);
    expect(updatePayload).toBeNull();
  });

  it('validates signed conformance evidence and server-issues the receipt while preserving metadata', async () => {
    const { PUT } = await import('../app/api/license/config/[productId]/integration-receipt/route');
    const response = await PUT(request({ verification: await verification() }), {
      params: Promise.resolve({ productId: PRODUCT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, data: { driftState: 'current' } });
    expect(updatePayload).toMatchObject({
      metadata: {
        completed_project_licensing: { policyPending: false },
        preserve: 'yes',
        somnibot_sdk_integration_receipt: {
          targetProjectCommit: 'abc1234',
          verificationId: 'verification-123',
          issuedBy: 'somnibot-server',
        },
      },
    });
    expect(updateFilters).toMatchObject({ id: PRODUCT_ID, guild_id: GUILD_ID, updated_at: UPDATED_AT });
  });

  it('rejects owner-authored receipts and unsigned verification claims before touching metadata', async () => {
    const { PUT } = await import('../app/api/license/config/[productId]/integration-receipt/route');
    const response = await PUT(request({ receipt: receipt() }), {
      params: Promise.resolve({ productId: PRODUCT_ID }),
    });
    expect(response.status).toBe(400);
    expect(updatePayload).toBeNull();
  });

  it('rejects a tampered conformance package before issuing any receipt', async () => {
    const signed = await verification();
    const { PUT } = await import('../app/api/license/config/[productId]/integration-receipt/route');
    const response = await PUT(request({
      verification: { ...signed, targetProjectCommit: 'tampered-after-signing' },
    }), { params: Promise.resolve({ productId: PRODUCT_ID }) });

    expect(response.status).toBe(400);
    expect(updatePayload).toBeNull();
  });

  it('reports malformed saved licensing policy separately from missing deployment configuration', async () => {
    sdkBuildError = new Error('malformed saved policy fixture');
    const { GET } = await import('../app/api/license/config/[productId]/integration-receipt/route');
    const response = await GET(request(), { params: Promise.resolve({ productId: PRODUCT_ID }) });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toEqual({ success: false, error: 'Saved licensing policy could not produce an SDK contract' });
  });
});
