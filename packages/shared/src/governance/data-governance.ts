import { z } from 'zod';

export const CREDENTIAL_PROVIDERS = [
  'discord', 'oauth', 'supabase', 'valkey', 'paypal', 'launcher', 'vps',
] as const;

export const CredentialInventoryEntrySchema = z.object({
  credentialId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  provider: z.enum(CREDENTIAL_PROVIDERS),
  presence: z.enum(['missing', 'present', 'revoked']),
  source: z.enum(['environment', 'os-keychain', 'encrypted-cloud-store', 'vps-secret-store']),
  validity: z.enum(['unknown', 'valid', 'invalid', 'expiring']),
  ageDays: z.number().int().nonnegative().nullable(),
  rotationDueAt: z.string().datetime().nullable(),
}).strict();

export const TenantScopeSchema = z.object({
  guildId: z.string().trim().min(1),
  customerId: z.string().trim().min(1).optional(),
}).strict();

export const TenantResourceSchema = TenantScopeSchema.extend({
  resourceType: z.enum([
    'product', 'plan', 'order', 'entitlement', 'role', 'channel', 'moderation-record',
    'economy-record', 'license', 'download', 'configuration', 'cache-entry',
    'undo-record', 'background-job',
  ]),
  resourceId: z.string().trim().min(1),
}).strict();

export type TenantAccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'guild_mismatch' | 'customer_mismatch' };

export function evaluateTenantAccess(
  actorInput: z.input<typeof TenantScopeSchema>,
  resourceInput: z.input<typeof TenantResourceSchema>,
): TenantAccessDecision {
  const actor = TenantScopeSchema.parse(actorInput);
  const resource = TenantResourceSchema.parse(resourceInput);
  if (actor.guildId !== resource.guildId) return { allowed: false, reason: 'guild_mismatch' };
  if (resource.customerId !== undefined && actor.customerId !== resource.customerId) {
    return { allowed: false, reason: 'customer_mismatch' };
  }
  return { allowed: true };
}

const PrivacyDimensionsSchema = z.object({
  deploymentProfile: z.enum([
    'local-single-guild', 'local-multi-guild', 'vps-single-guild',
    'vps-multi-guild', 'higher-load-vps',
  ]).optional(),
  featureDomain: z.enum([
    'administration', 'automation', 'commerce', 'community', 'economy',
    'infrastructure', 'moderation', 'music',
  ]).optional(),
  outcome: z.enum(['completed', 'abandoned', 'failed', 'recovered']).optional(),
}).strict();

export const PrivacyMetricInputSchema = z.object({
  metric: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  count: z.number().int().nonnegative(),
  dimensions: PrivacyDimensionsSchema,
}).strict();

export const PRIVACY_AGGREGATION_MINIMUM = 5;

export type PrivacySafeMetric =
  | { readonly metric: string; readonly suppressed: true }
  | { readonly metric: string; readonly suppressed: false; readonly count: number; readonly dimensions: z.output<typeof PrivacyDimensionsSchema> };

export function toPrivacySafeMetric(input: z.input<typeof PrivacyMetricInputSchema>): PrivacySafeMetric {
  const metric = PrivacyMetricInputSchema.parse(input);
  if (metric.count < PRIVACY_AGGREGATION_MINIMUM) return { metric: metric.metric, suppressed: true };
  return { metric: metric.metric, suppressed: false, count: metric.count, dimensions: metric.dimensions };
}
