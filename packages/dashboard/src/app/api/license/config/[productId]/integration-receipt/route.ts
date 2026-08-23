import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  readCompletedProjectLicensingMetadata,
  savedLicensingProductSchema,
  savedProductToLicensingDraft,
  savedProductToPolicyIdentityInput,
} from '@/lib/store/licensing-handoff';
import { buildSavedProductLicensingSdkBundle } from '@/lib/store/licensing-sdk-bundle';
import {
  buildSdkContractIdentity,
  classifySdkIntegrationDrift,
  createSdkIntegrationReceipt,
  mergeSdkIntegrationReceiptMetadata,
  readSdkIntegrationReceiptMetadata,
  resolveSdkDeploymentOrigin,
  type SdkContractIdentity,
  type SdkIntegrationReceipt,
} from '@/lib/store/sdk-contract-identity';
import {
  buildSdkEvidenceDigest,
  sdkVerificationAttestationSchema,
  verifySdkVerificationAttestation,
} from '@/lib/store/licensing-sdk-verification';

const requestSchema = z.object({ verification: sdkVerificationAttestationSchema }).strict();

type OwnedProduct = {
  readonly id: string;
  readonly metadata: Record<string, unknown>;
  readonly updatedAt: string;
  readonly savedProduct: unknown;
};

function productNotFound() {
  return NextResponse.json({ success: false, error: 'Product not found' }, { status: 404 });
}

function asMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

async function loadOwnedProduct(
  supabase: ReturnType<typeof createAdminSupabase>,
  productId: string,
  guildId: string,
): Promise<{
  readonly product: OwnedProduct | null;
  readonly error: { readonly message: string } | null;
}> {
  const { data, error } = await supabase
    .from('products')
    .select('*, plans(*), product_license_config(*), product_files(*)')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) return { product: null, error };
  if (!data) return { product: null, error: null };
  return {
    product: {
      id: data.id,
      metadata: asMetadata(data.metadata),
      updatedAt: data.updated_at,
      savedProduct: data,
    },
    error: null,
  };
}

function identityResponse(identity: SdkContractIdentity, receipt: SdkIntegrationReceipt | null) {
  return {
    identity,
    receipt,
    driftState: classifySdkIntegrationDrift(identity, receipt),
  };
}

async function loadContext(productId: string, guildId: string) {
  const supabase = createAdminSupabase();
  const loadedProduct = await loadOwnedProduct(supabase, productId, guildId);
  if (loadedProduct.error) return { kind: 'db_error' as const, error: loadedProduct.error };
  if (!loadedProduct.product) return { kind: 'not_found' as const };
  const product = loadedProduct.product;
  const deploymentOrigin = resolveSdkDeploymentOrigin(process.env);
  if (!deploymentOrigin) return { kind: 'origin_missing' as const };
  let generated;
  try {
    const apiBase = `${deploymentOrigin}/api`;
    const savedProduct = savedLicensingProductSchema.parse(product.savedProduct);
    const draft = await savedProductToLicensingDraft(savedProduct, apiBase);
    const completedProject = readCompletedProjectLicensingMetadata(savedProduct.metadata);
    generated = await buildSavedProductLicensingSdkBundle({
      projectName: draft.projectName,
      projectContext: draft.projectContext,
      apiBase,
      plansAndFeatures: draft.plansAndFeatures,
      installationIdentity: draft.installationIdentity,
      policy: savedProductToPolicyIdentityInput(savedProduct),
      capabilities: completedProject?.capabilities ?? [],
    });
  } catch (error) {
    console.error('[license/integration-receipt] SDK contract generation failed:', error instanceof Error ? error.message : 'unknown error');
    return { kind: 'contract_invalid' as const };
  }
  const sdkConfig = generated.files['somnibot-sdk.json'].content;
  const identity = buildSdkContractIdentity({
    storeProductId: product.id,
    deploymentOrigin,
    productPolicyRevision: sdkConfig.productPolicyRevision,
    contractHash: generated.contractIdentity.value,
  });
  return { kind: 'loaded' as const, supabase, product, identity };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { productId } = await params;
  const context = await loadContext(productId, auth.ctx.guildId);
  if (context.kind === 'not_found') return productNotFound();
  if (context.kind === 'db_error') return dbError(context.error, 'license/integration-receipt');
  if (context.kind === 'origin_missing') {
    return NextResponse.json(
      { success: false, error: 'SDK deployment origin is not configured' },
      { status: 503 },
    );
  }
  if (context.kind === 'contract_invalid') {
    return NextResponse.json(
      { success: false, error: 'Saved licensing policy could not produce an SDK contract' },
      { status: 422 },
    );
  }
  const receipt = readSdkIntegrationReceiptMetadata(context.product.metadata);
  return NextResponse.json({ success: true, data: identityResponse(context.identity, receipt) });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const body = requestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ success: false, error: 'Invalid integration receipt' }, { status: 400 });
  }
  const { productId } = await params;
  const context = await loadContext(productId, auth.ctx.guildId);
  if (context.kind === 'not_found') return productNotFound();
  if (context.kind === 'db_error') return dbError(context.error, 'license/integration-receipt');
  if (context.kind === 'origin_missing') {
    return NextResponse.json(
      { success: false, error: 'SDK deployment origin is not configured' },
      { status: 503 },
    );
  }
  if (context.kind === 'contract_invalid') {
    return NextResponse.json(
      { success: false, error: 'Saved licensing policy could not produce an SDK contract' },
      { status: 422 },
    );
  }
  const signingSecret = process.env.SDK_VERIFICATION_SIGNING_SECRET?.trim();
  if (!signingSecret || signingSecret.length < 32) {
    return NextResponse.json(
      { success: false, error: 'SDK conformance verification is not configured' },
      { status: 503 },
    );
  }
  const verification = body.data.verification;
  const signatureValid = await verifySdkVerificationAttestation(verification, signingSecret);
  if (!signatureValid) {
    return NextResponse.json(
      { success: false, error: 'Conformance verification signature is invalid' },
      { status: 400 },
    );
  }
  if (verification.evidenceDigest !== await buildSdkEvidenceDigest(verification.criteria)) {
    return NextResponse.json(
      { success: false, error: 'Conformance evidence digest is invalid' },
      { status: 400 },
    );
  }
  if (verification.identity.storeProductId !== productId) {
    return NextResponse.json(
      { success: false, error: 'Verification belongs to a different Store product' },
      { status: 400 },
    );
  }
  const identityMatches = verification.identity.contractHash === context.identity.contractHash
    && verification.identity.sdkSchemaVersion === context.identity.sdkSchemaVersion
    && verification.identity.sdkProtocolVersion === context.identity.sdkProtocolVersion
    && verification.identity.productPolicyRevision === context.identity.productPolicyRevision
    && verification.identity.deploymentOrigin === context.identity.deploymentOrigin;
  if (!identityMatches) {
    return NextResponse.json(
      { success: false, error: 'Verification does not match the authoritative SDK contract' },
      { status: 409 },
    );
  }
  const allCriteriaPassed = verification.criteria.every(({ verdict }) => verdict === 'pass');
  const conformanceResult = allCriteriaPassed
    && verification.remainingUnverifiedRequirements.length === 0
    ? 'passed' as const
    : 'unverified' as const;
  const receipt = createSdkIntegrationReceipt(context.identity, verification.issuedAt, {
    verificationId: verification.verificationId,
    issuedBy: 'somnibot-server',
    targetProjectVersion: verification.targetProjectVersion,
    targetProjectCommit: verification.targetProjectCommit,
    verificationEnvironment: verification.verificationEnvironment,
    capabilitiesExercised: verification.capabilitiesExercised,
    remainingUnverifiedRequirements: verification.remainingUnverifiedRequirements,
    integrityResult: 'passed',
    authenticityResult: 'passed',
    conformanceResult,
  });
  const updatedAt = new Date().toISOString();
  const { data: updated, error } = await context.supabase
    .from('products')
    .update({
      metadata: mergeSdkIntegrationReceiptMetadata(context.product.metadata, receipt),
      updated_at: updatedAt,
    })
    .eq('id', productId)
    .eq('guild_id', auth.ctx.guildId)
    .eq('updated_at', context.product.updatedAt)
    .select('id')
    .maybeSingle();
  if (error) return dbError(error, 'license/integration-receipt/update');
  if (!updated) {
    return NextResponse.json(
      { success: false, error: 'Product metadata changed; reload before recording the receipt' },
      { status: 409 },
    );
  }
  return NextResponse.json({
    success: true,
    data: identityResponse(context.identity, receipt),
  });
}
