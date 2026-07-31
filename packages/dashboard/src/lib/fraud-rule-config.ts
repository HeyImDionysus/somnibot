import { z } from 'zod';

const MAX_THRESHOLD = 1_000_000;
const MAX_WINDOW_MINUTES = 525_600;
const MAX_WINDOW_MS = 31_536_000_000;

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
