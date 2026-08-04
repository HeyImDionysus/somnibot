import { z } from 'zod';

const MAX_THRESHOLD = 1_000_000;
const MAX_WINDOW_MINUTES = 525_600;
const MAX_WINDOW_MS = 31_536_000_000;

export const FRAUD_RULE_TYPES = [
  'velocity_limit',
  'device_limit',
  'failed_payment',
  'ip_mismatch',
  'critical_incident',
] as const;
export type FraudRuleType = (typeof FRAUD_RULE_TYPES)[number];

const thresholdByType: Record<FraudRuleType, { min: number; max: number }> = {
  velocity_limit: { min: 2, max: 100 },
  device_limit: { min: 2, max: 10 },
  failed_payment: { min: 2, max: 50 },
  ip_mismatch: { min: 2, max: 100 },
  critical_incident: { min: 1, max: 50 },
};

export const velocityRuleConfigSchema = z.object({
  threshold: z.number().int().min(1).max(MAX_THRESHOLD),
  window_minutes: z.number().int().min(1).max(MAX_WINDOW_MINUTES).optional(),
  window_ms: z.number().int().min(1).max(MAX_WINDOW_MS).optional(),
}).strict().refine(
  (value) => Number(value.window_minutes !== undefined) + Number(value.window_ms !== undefined) === 1,
  { message: 'Set exactly one of window_minutes or window_ms.' },
);

export function velocityRuleConfigError(value: unknown): string | null {
  const parsed = velocityRuleConfigSchema.safeParse(value);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? 'Invalid velocity rule configuration.';
}

/** Validate the typed config for any live detector exposed by the dashboard. */
export function fraudRuleConfigError(type: string, value: unknown): string | null {
  if (type === 'velocity_limit') return velocityRuleConfigError(value);
  if (!Object.prototype.hasOwnProperty.call(thresholdByType, type)) {
    return 'Unsupported fraud detector type.';
  }
  const parsed = z.object({ threshold: z.number().int() }).strict().safeParse(value);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Invalid fraud rule configuration.';
  const range = thresholdByType[type as FraudRuleType];
  if (parsed.data.threshold < range.min || parsed.data.threshold > range.max) {
    return `Threshold must be between ${range.min} and ${range.max}.`;
  }
  return null;
}

export const fraudRuleConfigSchemas: Record<FraudRuleType, z.ZodTypeAny> = {
  velocity_limit: velocityRuleConfigSchema,
  device_limit: z.object({ threshold: z.number().int().min(2).max(10) }).strict(),
  failed_payment: z.object({ threshold: z.number().int().min(2).max(50) }).strict(),
  ip_mismatch: z.object({ threshold: z.number().int().min(2).max(100) }).strict(),
  critical_incident: z.object({ threshold: z.number().int().min(1).max(50) }).strict(),
};
