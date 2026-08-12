import { z } from 'zod';

export const COMMERCE_PLAN_RECOVERY_KEY = 'commerce_plan_recovery';

export const commercePlanRecoverySchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  product_active: z.boolean(),
  name: z.string().min(1).max(100),
  paypal_plan_id: z.string().min(1).max(64),
  interval_unit: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']),
  interval_count: z.number().int().min(1).max(12),
  price_cents: z.number().int().min(0).max(999999),
  currency: z.string().length(3),
  trial_days: z.number().int().min(0).max(365),
  active: z.boolean(),
}).strict();

export type CommercePlanRecovery = z.infer<typeof commercePlanRecoverySchema>;

const metadataSchema = z.record(z.unknown());

export function metadataWithPlanRecovery(
  metadata: unknown,
  recovery: CommercePlanRecovery,
): Record<string, unknown> {
  const parsed = metadataSchema.safeParse(metadata);
  return {
    ...(parsed.success ? parsed.data : {}),
    [COMMERCE_PLAN_RECOVERY_KEY]: recovery,
  };
}

export function readPlanRecovery(metadata: unknown): CommercePlanRecovery | null {
  const parsed = metadataSchema.safeParse(metadata);
  if (!parsed.success) return null;
  const recovery = commercePlanRecoverySchema.safeParse(parsed.data[COMMERCE_PLAN_RECOVERY_KEY]);
  return recovery.success ? recovery.data : null;
}

export function metadataWithoutPlanRecovery(metadata: unknown): Record<string, unknown> {
  const parsed = metadataSchema.safeParse(metadata);
  if (!parsed.success) return {};
  return Object.fromEntries(
    Object.entries(parsed.data).filter(([key]) => key !== COMMERCE_PLAN_RECOVERY_KEY),
  );
}
