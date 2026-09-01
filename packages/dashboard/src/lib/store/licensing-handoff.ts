import { z } from 'zod';
import {
  licensingPromptEnvelopeSchema,
  normalizeFeatureFlags,
  type LicensingPromptDraft,
  type LicensingPromptEnvelope,
} from './licensing-prompt';
import {
  licensingCapabilitiesSchema,
  normalizeLicensingCapabilities,
  type LicensingCapability,
} from './licensing-capabilities';
import {
  buildSdkProductPolicyRevision,
  type SdkProductPolicyIdentityInput,
} from './sdk-contract-identity';
import {
  DYNAMIC_DEFAULT_RAILS,
  licensingRailsSchema,
  STATIC_DEFAULT_RAILS,
  type LicensingRails,
} from './licensing-rails';

export {
  licensingCapabilitySchema,
  licensingCapabilitiesSchema,
  normalizeLicensingCapabilities,
  type LicensingCapability,
} from './licensing-capabilities';

export const LICENSING_STORE_HANDOFF_KEY = 'somnibot.completed-project-licensing.v1';

function normalizeEnvelopeCapabilities(
  envelope: LicensingPromptEnvelope,
  capabilities?: readonly LicensingCapability[],
): LicensingCapability[] {
  const featureFlags = envelope.mode === 'dynamic'
    ? normalizeFeatureFlags(envelope.dynamicPolicy.featureFlags)
    : [];
  return normalizeLicensingCapabilities(featureFlags, capabilities);
}

const rawLicensingStoreHandoffSchema = z.object({
  schemaVersion: z.literal(1),
  guildId: z.string().min(1),
  envelope: licensingPromptEnvelopeSchema,
  capabilities: licensingCapabilitiesSchema.optional(),
  subscriptionPlanId: z.string().uuid().optional(),
  creationRequestId: z.string().uuid().optional(),
  recovery: z.object({
    kind: z.enum(['license', 'setup']),
    productId: z.string().min(1),
  }).optional(),
});

const licensingStoreHandoffSchema = rawLicensingStoreHandoffSchema.transform((handoff) => ({
  ...handoff,
  capabilities: normalizeEnvelopeCapabilities(handoff.envelope, handoff.capabilities),
}));

export type LicensingStoreHandoffV1 = z.infer<typeof licensingStoreHandoffSchema>;

const savedLicensePolicySchema = z.object({
  license_mode: z.string().min(1),
  key_prefix: z.string().min(1),
  max_devices: z.number().int().min(1).max(100),
  heartbeat_interval_seconds: z.number().int().min(0).max(86_400),
  sdk_cache_ttl_ms: z.number().int().min(1_000),
  offline_grace_period_seconds: z.number().int().min(0).max(604_800),
  feature_flags: z.array(z.string()).default([]),
  tier: z.string().optional().nullable(),
  device_policy: z.string().optional().nullable(),
  watermark_config: z.record(z.unknown()).optional().nullable(),
  require_discord_guild_membership: z.boolean(),
  rotation_policy: z.string().min(1),
  self_service_device_removal: z.boolean(),
});

const savedPlanSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  interval_unit: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']),
  interval_count: z.number().int().min(1),
  price_cents: z.number().int().min(0),
  currency: z.string().min(1),
  trial_days: z.number().int().min(0),
  active: z.boolean(),
}).passthrough();

const savedProductFileSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().optional().nullable(),
  file_name: z.string().optional().nullable(),
  mime_type: z.string().optional().nullable(),
  content_type: z.string().optional().nullable(),
}).passthrough();

const completedProjectPolicySchema = z.object({
  keyPrefix: z.string().regex(/^[A-Z]{2,8}$/),
  maxDevices: z.number().int().min(1).max(100),
  heartbeatIntervalMs: z.number().int().min(60_000).max(86_400_000)
    .refine((value) => value % 1000 === 0, 'heartbeatIntervalMs must be a whole number of seconds'),
  sdkCacheTtlMs: z.number().int().min(1_000).max(3_600_000),
  offlineGracePeriodSeconds: z.number().int().min(0).max(604_800),
  featureFlags: z.array(z.string().min(1).max(64)).max(100),
  requireDiscordGuildMembership: z.boolean(),
  rotationPolicy: z.enum(['rotate-and-invalidate', 'disabled']),
  selfServiceDeviceRemoval: z.boolean(),
});

export const completedProjectLicensingMetadataSchema = z.object({
  privateIntegrationContext: z.string().max(20_000).default(''),
  projectContext: z.string().max(20_000).default(''),
  plansAndFeatures: z.string().max(20_000).default(''),
  outputFormats: z.string().max(5_000).default(''),
  installationIdentity: z.string().max(1_000).default(''),
  capabilities: licensingCapabilitiesSchema.default([]),
  rails: licensingRailsSchema.optional(),
  policyPending: z.boolean().default(false),
  desiredPolicy: completedProjectPolicySchema.optional(),
}).passthrough();

const completedProjectMetadataSchema = completedProjectLicensingMetadataSchema.optional();

export const savedLicensingProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  type: z.enum(['one_time', 'subscription', 'free']),
  delivery_type: z.enum(['file', 'link', 'access_pass', 'license_key', 'mixed']),
  granted_role_ids: z.array(z.string()).optional().default([]),
  granted_channel_ids: z.array(z.string()).optional().default([]),
  product_license_config: z.union([
    savedLicensePolicySchema,
    z.array(savedLicensePolicySchema),
  ]).nullable().optional().default([]),
  plans: z.array(savedPlanSchema).optional().default([]),
  product_files: z.array(savedProductFileSchema).optional().default([]),
  metadata: z.object({
    completed_project_licensing: completedProjectMetadataSchema,
  }).passthrough().optional().default({}),
});

export type LicensingStorePrefill = {
  readonly name: string;
  readonly customerDescription: string;
  readonly privateIntegrationContext: string;
  readonly deliveryType: 'file' | 'license_key';
  readonly billingType: 'one_time' | 'subscription' | 'free' | null;
  readonly billingChoiceRequired: boolean;
  readonly active: false;
  readonly planNotes: string;
  readonly maxDevices: number;
  readonly heartbeatIntervalMs: number;
  readonly offlineGracePeriodSeconds: number;
  readonly featureFlags: string[];
  readonly capabilities: LicensingCapability[];
};

export function serializeLicensingStoreHandoff(
  envelope: LicensingPromptEnvelope,
  guildId: string,
  recovery?: LicensingStoreHandoffV1['recovery'],
  creationRequestId?: string,
  capabilities?: readonly LicensingCapability[],
  subscriptionPlanId?: string,
): string {
  return JSON.stringify(licensingStoreHandoffSchema.parse({
    schemaVersion: 1,
    guildId,
    envelope,
    recovery,
    creationRequestId,
    capabilities: normalizeEnvelopeCapabilities(envelope, capabilities),
    subscriptionPlanId,
  }));
}

export function parseLicensingStoreHandoff(value: string): LicensingStoreHandoffV1 | null {
  try {
    const parsed = licensingStoreHandoffSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function hasPendingCompletedProjectPolicy(metadata: unknown): boolean {
  const parsed = z.object({
    completed_project_licensing: completedProjectMetadataSchema,
  }).passthrough().safeParse(metadata);
  return parsed.success && parsed.data.completed_project_licensing?.policyPending === true;
}

export function declaresPendingCompletedProjectPolicy(metadata: unknown): boolean {
  return z.object({
    completed_project_licensing: z.object({
      policyPending: z.literal(true),
    }).passthrough(),
  }).passthrough().safeParse(metadata).success;
}

export function readPendingCompletedProjectPolicy(
  metadata: unknown,
): z.infer<typeof completedProjectPolicySchema> | null {
  const parsed = z.object({
    completed_project_licensing: completedProjectMetadataSchema,
  }).passthrough().safeParse(metadata);
  if (!parsed.success || parsed.data.completed_project_licensing?.policyPending !== true) return null;
  return parsed.data.completed_project_licensing.desiredPolicy ?? null;
}

export function readCompletedProjectPolicy(
  metadata: unknown,
): z.infer<typeof completedProjectPolicySchema> | null {
  const parsed = z.object({
    completed_project_licensing: completedProjectMetadataSchema,
  }).passthrough().safeParse(metadata);
  return parsed.success
    ? parsed.data.completed_project_licensing?.desiredPolicy ?? null
    : null;
}

export function readCompletedProjectLicensingMetadata(
  metadata: unknown,
): z.infer<typeof completedProjectLicensingMetadataSchema> | null {
  const parsed = z.object({
    completed_project_licensing: completedProjectMetadataSchema,
  }).passthrough().safeParse(metadata);
  return parsed.success
    ? parsed.data.completed_project_licensing ?? null
    : null;
}

export type AuthoritativeLicensingPlan = {
  readonly id: string;
  readonly key?: string;
  readonly name: string;
};

export function resolveCapabilityPlanGrants(
  capabilities: readonly LicensingCapability[],
  plans: readonly AuthoritativeLicensingPlan[],
): LicensingCapability[] {
  const parsedCapabilities = licensingCapabilitiesSchema.parse(capabilities);
  const parsedPlans = z.array(z.object({
    id: z.string().uuid(),
    key: z.string().min(1).optional(),
    name: z.string().min(1),
  })).parse(plans);
  const planIds = new Set(parsedPlans.map((plan) => plan.id));

  return licensingCapabilitiesSchema.parse(parsedCapabilities.map((capability) => ({
    ...capability,
    grantingPlans: capability.grantingPlans.map((grant) => {
      if (grant.planId) {
        if (!planIds.has(grant.planId)) {
          throw new Error(`Capability ${capability.key} references a plan that is not saved on this product.`);
        }
        return grant;
      }
      const candidates = parsedPlans.filter((plan) => (
        plan.key === grant.key || plan.name.toLocaleLowerCase() === grant.name.toLocaleLowerCase()
      ));
      const resolved = candidates.length === 1
        ? candidates[0]
        : parsedPlans.length === 1
          ? parsedPlans[0]
          : undefined;
      if (!resolved) {
        throw new Error(`Capability ${capability.key} has an unresolved granting plan ${grant.key}.`);
      }
      return { ...grant, planId: resolved.id };
    }),
  })));
}

export function promptEnvelopeToStorePrefill(
  envelope: LicensingPromptEnvelope,
  capabilities?: readonly LicensingCapability[],
): LicensingStorePrefill {
  const billingType = envelope.billing.model === 'multiple'
    ? 'subscription'
    : envelope.billing.model === 'undecided'
      ? null
      : envelope.billing.model;
  const dynamicPolicy = envelope.mode === 'dynamic' ? envelope.dynamicPolicy : null;
  if (dynamicPolicy && dynamicPolicy.heartbeatSeconds < 60) {
    throw new Error('Store handoffs require a heartbeat of at least 60 seconds.');
  }
  return {
    name: envelope.project.name,
    customerDescription: '',
    privateIntegrationContext: envelope.project.context,
    deliveryType: envelope.mode === 'dynamic' ? 'license_key' : 'file',
    billingType,
    billingChoiceRequired: billingType === null,
    active: false,
    planNotes: envelope.billing.plansAndFeatures,
    maxDevices: dynamicPolicy?.maxInstallations ?? 3,
    heartbeatIntervalMs: (dynamicPolicy?.heartbeatSeconds ?? 300) * 1000,
    offlineGracePeriodSeconds: dynamicPolicy?.offlineGraceSeconds ?? 86_400,
    featureFlags: normalizeFeatureFlags(dynamicPolicy?.featureFlags ?? []),
    capabilities: normalizeEnvelopeCapabilities(envelope, capabilities),
  };
}

function railsForSavedProduct(
  product: z.infer<typeof savedLicensingProductSchema>,
): LicensingRails {
  const saved = product.metadata.completed_project_licensing?.rails;
  if (saved) return saved;
  const hasDiscordGrants = product.granted_role_ids.length > 0
    || product.granted_channel_ids.length > 0;
  if (product.delivery_type === 'license_key') {
    return {
      ...DYNAMIC_DEFAULT_RAILS,
      downloadableFiles: product.product_files.length > 0,
      discordRoles: hasDiscordGrants,
    };
  }
  return {
    ...STATIC_DEFAULT_RAILS,
    hostedAccess: product.delivery_type === 'link' || product.delivery_type === 'access_pass',
    discordRoles: hasDiscordGrants,
  };
}

export function savedProductToPolicyIdentityInput(
  value: unknown,
): SdkProductPolicyIdentityInput {
  const product = savedLicensingProductSchema.parse(value);
  const policy = Array.isArray(product.product_license_config)
    ? product.product_license_config[0] ?? null
    : product.product_license_config ?? null;
  const completedProject = product.metadata.completed_project_licensing;
  const capabilities = completedProject?.capabilities ?? [];
  for (const capability of capabilities) {
    if (capability.grantingPlans.some((grant) => !grant.planId)) {
      throw new Error(`Capability ${capability.key} has a granting plan without an authoritative saved plan id.`);
    }
  }
  return {
    storeProductId: product.id,
    billingModel: product.type,
    plans: product.plans.map((plan) => ({
      key: plan.id,
      name: plan.name,
      active: plan.active,
      intervalUnit: plan.interval_unit,
      intervalCount: plan.interval_count,
    })),
    rails: railsForSavedProduct(product),
    dynamicPolicy: policy ? {
      licenseMode: policy.license_mode,
      keyPrefix: policy.key_prefix,
      maxDevices: policy.max_devices,
      heartbeatIntervalSeconds: policy.heartbeat_interval_seconds,
      sdkCacheTtlMs: policy.sdk_cache_ttl_ms,
      offlineGracePeriodSeconds: policy.offline_grace_period_seconds,
      featureFlags: policy.feature_flags,
      tier: policy.tier ?? null,
      requireDiscordGuildMembership: policy.require_discord_guild_membership,
      devicePolicy: policy.device_policy ?? null,
      rotationPolicy: policy.rotation_policy,
      selfServiceDeviceRemoval: policy.self_service_device_removal,
      watermarkConfig: policy.watermark_config ?? null,
    } : null,
    staticPolicy: policy ? null : {
      outputFormats: completedProject?.outputFormats ?? '',
      deliveryDescriptors: product.product_files.map((file) => ({
        key: file.id,
        displayName: file.display_name?.trim() || file.file_name?.trim() || file.id,
        mediaType: file.mime_type ?? file.content_type ?? null,
      })),
    },
    capabilities: capabilities.map((capability) => ({
      key: capability.key,
      behavioralMeaning: capability.behavioralMeaning,
      controlledFunctionality: capability.controlledFunctionality,
      grantingPlans: capability.grantingPlans.map((grant) => {
        if (!grant.planId) {
          throw new Error(`Capability ${capability.key} has an unresolved granting plan.`);
        }
        return grant.planId;
      }),
      unavailableBehavior: capability.unavailableBehavior,
      dependencyKeys: capability.dependencyKeys,
    })),
    discordGrants: {
      roleIds: product.granted_role_ids,
      channelIds: product.granted_channel_ids,
    },
  };
}

export async function savedProductToLicensingDraft(
  value: unknown,
  apiBase: string,
): Promise<LicensingPromptDraft> {
  const product = savedLicensingProductSchema.parse(value);
  const dynamic = product.delivery_type === 'license_key';
  const policy = Array.isArray(product.product_license_config)
    ? product.product_license_config[0]
    : product.product_license_config;
  if (dynamic && !policy) {
    throw new Error('Dynamic products require an authoritative saved license policy.');
  }
  const savedContext = product.metadata.completed_project_licensing;
  const savedPlans = product.plans
    .filter((plan) => plan.active)
    .map((plan) => `${plan.name}: ${(plan.price_cents / 100).toFixed(2)} ${plan.currency} every ${plan.interval_count} ${plan.interval_unit.toLowerCase()}(s), ${plan.trial_days} trial day(s)`)
    .join('; ');
  const savedFiles = product.product_files
    .map((file) => file.display_name?.trim() || file.file_name?.trim() || '')
    .filter(Boolean)
    .join(', ');
  const rails = railsForSavedProduct(product);
  const productPolicyRevision = await buildSdkProductPolicyRevision(
    savedProductToPolicyIdentityInput(product),
  );
  return {
    mode: dynamic ? 'dynamic' : 'static',
    projectName: product.name,
    projectContext: savedContext?.privateIntegrationContext
      || savedContext?.projectContext
      || 'Review the completed project and preserve its existing behavior and architecture.',
    productId: product.id,
    apiBase,
    productPolicyRevision,
    rails,
    billingModel: product.type,
    plansAndFeatures: savedPlans || savedContext?.plansAndFeatures || '',
    featureFlags: normalizeFeatureFlags(policy?.feature_flags ?? []).join(', '),
    outputFormats: dynamic
      ? ''
      : savedFiles || savedContext?.outputFormats || 'No saved product files are attached; attach and verify the delivery files before shipping.',
    installationIdentity: savedContext?.installationIdentity
      || 'One stable installation, deployment, tenant, server, or device identity',
    maxInstallations: policy?.max_devices ?? 3,
    heartbeatSeconds: policy?.heartbeat_interval_seconds ?? 300,
    offlineGraceSeconds: policy?.offline_grace_period_seconds ?? 86_400,
  };
}
