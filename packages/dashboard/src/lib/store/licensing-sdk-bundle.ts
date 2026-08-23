import { licensingCapabilitiesSchema, type LicensingCapability } from './licensing-capabilities';
import { buildLicenseApiOpenApi } from './licensing-sdk-openapi';
import {
  licensingSdkBundleSchema,
  LicensingSdkBundleError,
  type LicensingSdkBundle,
} from './licensing-sdk-bundle-format';
import {
  DYNAMIC_DEFAULT_RAILS,
  licensingRailsSchema,
  STATIC_DEFAULT_RAILS,
  type LicensingRails,
} from './licensing-rails';
import {
  buildAcceptanceScenarios,
  buildAgentMarkdown,
  buildConformanceMarkdown,
  buildSdkConfig,
} from './licensing-sdk-protocol';
import { SERVER_LICENSE_STATUSES } from './licensing-sdk-instructions';
import {
  buildSdkProductPolicyRevision,
  type SdkProductPolicyIdentityInput,
} from './sdk-contract-identity';
import { STATIC_DELIVERY_CONTRACT } from './licensing-sdk-static-delivery';

export {
  DYNAMIC_DEFAULT_RAILS,
  licensingRailsSchema,
  STATIC_DEFAULT_RAILS,
  type LicensingRails,
} from './licensing-rails';
export {
  extractLicensingSdkBundle,
  licensingSdkBundleSchema,
  LicensingSdkBundleError,
  renderLicensingSdkBundle,
  type LicensingSdkBundle,
} from './licensing-sdk-bundle-format';

export type LicensingBundleInput = {
  readonly mode: 'dynamic' | 'static';
  readonly project: {
    readonly name: string;
    readonly context: string;
    readonly productId: string | null;
    readonly apiBase: string;
    readonly productPolicyRevision?: string | null;
  };
  readonly billing: {
    readonly model: 'one_time' | 'subscription' | 'multiple' | 'free' | 'undecided';
    readonly plansAndFeatures: string;
    readonly plans?: SdkProductPolicyIdentityInput['plans'];
  };
  readonly rails: LicensingRails;
  readonly capabilities: readonly LicensingCapability[];
  readonly dynamicPolicy: {
    readonly installationIdentity: string;
    readonly licenseMode?: string;
    readonly keyPrefix?: string;
    readonly maxInstallations: number;
    readonly heartbeatSeconds: number;
    readonly sdkCacheTtlMs?: number;
    readonly offlineGraceSeconds: number;
    readonly featureFlags: readonly string[];
    readonly tier?: string | null;
    readonly requireDiscordGuildMembership?: boolean;
    readonly devicePolicy?: string | null;
    readonly rotationPolicy?: string;
    readonly selfServiceDeviceRemoval?: boolean;
    readonly watermarkConfig?: Readonly<Record<string, unknown>> | null;
  } | null;
  readonly staticPolicy: {
    readonly outputFormats: string;
    readonly deliveryDescriptors?: SdkProductPolicyIdentityInput['staticPolicy'] extends infer StaticPolicy
      ? StaticPolicy extends { readonly deliveryDescriptors: infer Descriptors } ? Descriptors : never
      : never;
  } | null;
  readonly discordGrants?: SdkProductPolicyIdentityInput['discordGrants'];
};

export type SavedProductLicensingBundleInput = {
  readonly projectName: string;
  readonly projectContext: string;
  readonly apiBase: string;
  readonly plansAndFeatures: string;
  readonly installationIdentity: string;
  readonly policy: SdkProductPolicyIdentityInput;
  readonly capabilities: readonly LicensingCapability[];
};

function encodedString(value: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new LicensingSdkBundleError('Could not encode bundle string.');
  return encoded;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return encodedString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${encodedString(key)}:${canonicalJson(Reflect.get(value, key))}`).join(',')}}`;
  }
  throw new LicensingSdkBundleError('Bundle hash input contains a non-JSON value.');
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function policyHashInput(input: LicensingBundleInput) {
  return {
    productId: input.project.productId,
    billing: input.billing,
    rails: input.rails,
    dynamicPolicy: input.dynamicPolicy,
    staticPolicy: input.staticPolicy,
    capabilities: input.capabilities,
  };
}

function deploymentOrigin(apiBase: string): string {
  try {
    return new URL(apiBase).origin;
  } catch {
    return apiBase;
  }
}

export async function buildLicensingSdkBundle(input: LicensingBundleInput): Promise<LicensingSdkBundle> {
  const capabilities = licensingCapabilitiesSchema.parse(input.capabilities);
  const savedRevision = input.project.productPolicyRevision ?? null;
  const productPolicyRevision = savedRevision ?? `sha256:${await sha256(policyHashInput(input))}`;
  const scenarios = buildAcceptanceScenarios(input.rails);
  const sdkConfig = buildSdkConfig({
    project: {
      name: input.project.name,
      integrationContext: input.project.context,
      productId: input.project.productId,
      apiBase: input.project.apiBase,
      deploymentOrigin: deploymentOrigin(input.project.apiBase),
      legacyMode: input.mode,
    },
    productPolicyRevision,
    policyRevisionAuthority: savedRevision === null ? 'generated_draft' : 'saved_store',
    rails: input.rails,
    capabilities,
    legacyFeatureFlags: input.dynamicPolicy?.featureFlags ?? [],
    staticDelivery: input.mode === 'static' ? STATIC_DELIVERY_CONTRACT : null,
    licensingPolicy: {
      billingModel: input.billing.model,
      plansAndFeatures: input.billing.plansAndFeatures,
      plans: input.billing.plans?.map((plan) => ({ ...plan })) ?? [],
      dynamic: input.dynamicPolicy === null ? null : {
        ...input.dynamicPolicy,
        licenseMode: input.dynamicPolicy.licenseMode ?? 'portal_only',
        keyPrefix: input.dynamicPolicy.keyPrefix ?? 'SMNI',
        sdkCacheTtlMs: input.dynamicPolicy.sdkCacheTtlMs ?? 60_000,
        tier: input.dynamicPolicy.tier ?? null,
        requireDiscordGuildMembership: input.dynamicPolicy.requireDiscordGuildMembership ?? false,
        devicePolicy: input.dynamicPolicy.devicePolicy ?? 'evict_oldest',
        rotationPolicy: input.dynamicPolicy.rotationPolicy ?? 'rotate-and-invalidate',
        selfServiceDeviceRemoval: input.dynamicPolicy.selfServiceDeviceRemoval ?? true,
        watermarkConfig: input.dynamicPolicy.watermarkConfig ?? null,
        featureFlags: [...input.dynamicPolicy.featureFlags],
      },
      static: input.staticPolicy === null ? null : {
        outputFormats: input.staticPolicy.outputFormats,
        deliveryDescriptors: input.staticPolicy.deliveryDescriptors?.map((descriptor) => ({ ...descriptor })) ?? [],
      },
      discordGrants: input.discordGrants === undefined
        ? { roleIds: [], channelIds: [] }
        : { roleIds: [...input.discordGrants.roleIds], channelIds: [...input.discordGrants.channelIds] },
    },
    acceptanceScenarios: scenarios,
  });
  const unsignedBundle = {
    bundleVersion: 1,
    protocolVersion: 2,
    trustHierarchy: [
      { rank: 1, authority: 'somnibot_protocol' },
      { rank: 2, authority: 'saved_store_policy' },
      { rank: 3, authority: 'owner_configuration' },
      { rank: 4, authority: 'repository_facts' },
    ],
    externalDependencies: [],
    files: {
      'somnibot-sdk.json': { mediaType: 'application/json', content: sdkConfig },
      'AGENT.md': { mediaType: 'text/markdown', content: buildAgentMarkdown() },
      'license-api.openapi.json': {
        mediaType: 'application/vnd.oai.openapi+json',
        content: buildLicenseApiOpenApi(input.project.apiBase, SERVER_LICENSE_STATUSES, input.mode),
      },
      'CONFORMANCE.md': { mediaType: 'text/markdown', content: buildConformanceMarkdown(scenarios) },
    },
  };
  const value = await sha256(unsignedBundle);
  return licensingSdkBundleSchema.parse({
    ...unsignedBundle,
    contractIdentity: { algorithm: 'sha256', canonicalization: 'sorted-json-utf8-v1', value },
  });
}

export async function buildSavedProductLicensingSdkBundle(
  input: SavedProductLicensingBundleInput,
): Promise<LicensingSdkBundle> {
  const productPolicyRevision = await buildSdkProductPolicyRevision(input.policy);
  const dynamic = input.policy.dynamicPolicy;
  const staticPolicy = input.policy.staticPolicy;
  return buildLicensingSdkBundle({
    mode: dynamic === null ? 'static' : 'dynamic',
    project: {
      name: input.projectName,
      context: input.projectContext,
      productId: input.policy.storeProductId,
      apiBase: input.apiBase,
      productPolicyRevision,
    },
    billing: {
      model: input.policy.billingModel,
      plansAndFeatures: input.plansAndFeatures,
      plans: input.policy.plans,
    },
    rails: input.policy.rails,
    capabilities: input.capabilities,
    dynamicPolicy: dynamic === null ? null : {
      installationIdentity: input.installationIdentity,
      licenseMode: dynamic.licenseMode,
      keyPrefix: dynamic.keyPrefix,
      maxInstallations: dynamic.maxDevices,
      heartbeatSeconds: dynamic.heartbeatIntervalSeconds,
      sdkCacheTtlMs: dynamic.sdkCacheTtlMs,
      offlineGraceSeconds: dynamic.offlineGracePeriodSeconds,
      featureFlags: [...dynamic.featureFlags],
      tier: dynamic.tier,
      requireDiscordGuildMembership: dynamic.requireDiscordGuildMembership,
      devicePolicy: dynamic.devicePolicy,
      rotationPolicy: dynamic.rotationPolicy,
      selfServiceDeviceRemoval: dynamic.selfServiceDeviceRemoval,
      watermarkConfig: dynamic.watermarkConfig,
    },
    staticPolicy: staticPolicy === null ? null : {
      outputFormats: staticPolicy.outputFormats,
      deliveryDescriptors: staticPolicy.deliveryDescriptors,
    },
    discordGrants: input.policy.discordGrants,
  });
}

export async function verifyLicensingSdkBundleIdentity(bundle: LicensingSdkBundle): Promise<boolean> {
  const { contractIdentity, ...unsignedBundle } = bundle;
  return contractIdentity.value === await sha256(unsignedBundle);
}
