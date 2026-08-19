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
  envelope: licensingPromptEnvelopeSchema,
});

export type LicensingStoreHandoffV1 = z.infer<typeof licensingStoreHandoffSchema>;

const savedLicensePolicySchema = z.object({
  max_devices: z.number().int().min(1),
  heartbeat_interval_seconds: z.number().int().min(30),
  offline_grace_period_seconds: z.number().int().min(0),
  feature_flags: z.array(z.string()).default([]),
});

export const savedLicensingProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  type: z.enum(['one_time', 'subscription', 'free']),
  delivery_type: z.enum(['file', 'link', 'access_pass', 'license_key', 'mixed']),
  product_license_config: z.array(savedLicensePolicySchema).optional().default([]),
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

export function serializeLicensingStoreHandoff(envelope: LicensingPromptEnvelope): string {
  return JSON.stringify(licensingStoreHandoffSchema.parse({ schemaVersion: 1, envelope }));
}

export function parseLicensingStoreHandoff(value: string): LicensingStoreHandoffV1 | null {
  try {
    const parsed = licensingStoreHandoffSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function promptEnvelopeToStorePrefill(envelope: LicensingPromptEnvelope): LicensingStorePrefill {
  const billingType = envelope.billing.model === 'multiple'
    ? 'subscription'
    : envelope.billing.model === 'undecided'
      ? null
      : envelope.billing.model;
  const dynamicPolicy = envelope.mode === 'dynamic' ? envelope.dynamicPolicy : null;
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
  const policy = product.product_license_config[0];
  return {
    mode: dynamic ? 'dynamic' : 'static',
    projectName: product.name,
    projectContext: product.description ?? 'Review the completed project and preserve its existing behavior and architecture.',
    productId: product.id,
    apiBase,
    billingModel: product.type,
    plansAndFeatures: '',
    featureFlags: normalizeFeatureFlags(policy?.feature_flags ?? []).join(', '),
    outputFormats: dynamic ? '' : 'Use the saved product files and their existing delivery formats.',
    installationIdentity: 'One stable installation, deployment, tenant, server, or device identity',
    maxInstallations: policy?.max_devices ?? 3,
    heartbeatSeconds: policy?.heartbeat_interval_seconds ?? 300,
    offlineGraceSeconds: policy?.offline_grace_period_seconds ?? 86_400,
  };
}
