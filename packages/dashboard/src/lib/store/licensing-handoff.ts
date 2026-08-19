import { z } from 'zod';
import {
  licensingPromptEnvelopeSchema,
  normalizeFeatureFlags,
  type LicensingPromptDraft,
  type LicensingPromptEnvelope,
} from './licensing-prompt';

export const LICENSING_STORE_HANDOFF_KEY = 'somnibot.completed-project-licensing.v1';

const licensingStoreHandoffSchema = z.object({
  schemaVersion: z.literal(1),
  guildId: z.string().min(1),
  envelope: licensingPromptEnvelopeSchema,
  creationRequestId: z.string().uuid().optional(),
  recovery: z.object({
    kind: z.enum(['license', 'setup']),
    productId: z.string().min(1),
  }).optional(),
});

export type LicensingStoreHandoffV1 = z.infer<typeof licensingStoreHandoffSchema>;

const savedLicensePolicySchema = z.object({
  max_devices: z.number().int().min(1).max(100),
  heartbeat_interval_seconds: z.number().int().min(0).max(86_400),
  offline_grace_period_seconds: z.number().int().min(0).max(604_800),
  feature_flags: z.array(z.string()).default([]),
});

const savedPlanSchema = z.object({
  name: z.string().min(1),
  interval_unit: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']),
  interval_count: z.number().int().min(1),
  price_cents: z.number().int().min(0),
  currency: z.string().min(1),
  trial_days: z.number().int().min(0),
  active: z.boolean(),
}).passthrough();

const savedProductFileSchema = z.object({
  display_name: z.string().optional().nullable(),
  file_name: z.string().optional().nullable(),
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

const completedProjectMetadataSchema = z.object({
  projectContext: z.string().default(''),
  plansAndFeatures: z.string().default(''),
  outputFormats: z.string().default(''),
  installationIdentity: z.string().default(''),
  policyPending: z.boolean().default(false),
  desiredPolicy: completedProjectPolicySchema.optional(),
}).optional();

export const savedLicensingProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  type: z.enum(['one_time', 'subscription', 'free']),
  delivery_type: z.enum(['file', 'link', 'access_pass', 'license_key', 'mixed']),
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
  readonly description: string;
  readonly deliveryType: 'file' | 'license_key';
  readonly billingType: 'one_time' | 'subscription' | 'free' | null;
  readonly billingChoiceRequired: boolean;
  readonly active: false;
  readonly planNotes: string;
  readonly maxDevices: number;
  readonly heartbeatIntervalMs: number;
  readonly offlineGracePeriodSeconds: number;
  readonly featureFlags: string[];
};

export function serializeLicensingStoreHandoff(
  envelope: LicensingPromptEnvelope,
  guildId: string,
  recovery?: LicensingStoreHandoffV1['recovery'],
  creationRequestId?: string,
): string {
  return JSON.stringify(licensingStoreHandoffSchema.parse({
    schemaVersion: 1,
    guildId,
    envelope,
    recovery,
    creationRequestId,
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

export function promptEnvelopeToStorePrefill(envelope: LicensingPromptEnvelope): LicensingStorePrefill {
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
    description: envelope.project.context,
    deliveryType: envelope.mode === 'dynamic' ? 'license_key' : 'file',
    billingType,
    billingChoiceRequired: billingType === null,
    active: false,
    planNotes: envelope.billing.plansAndFeatures,
    maxDevices: dynamicPolicy?.maxInstallations ?? 3,
    heartbeatIntervalMs: (dynamicPolicy?.heartbeatSeconds ?? 300) * 1000,
    offlineGracePeriodSeconds: dynamicPolicy?.offlineGraceSeconds ?? 86_400,
    featureFlags: normalizeFeatureFlags(dynamicPolicy?.featureFlags ?? []),
  };
}

export function savedProductToLicensingDraft(value: unknown, apiBase: string): LicensingPromptDraft {
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
  return {
    mode: dynamic ? 'dynamic' : 'static',
    projectName: product.name,
    projectContext: savedContext?.projectContext
      || product.description
      || 'Review the completed project and preserve its existing behavior and architecture.',
    productId: product.id,
    apiBase,
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
