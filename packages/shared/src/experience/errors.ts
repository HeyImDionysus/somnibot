import { z } from 'zod';

const ErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{2,79}$/);

export const ErrorDependencySchema = z.object({
  key: z.string().trim().min(1).max(100),
  state: z.enum(['ready', 'degraded', 'unavailable', 'stale', 'blocked']),
}).strict();

export const FieldErrorSchema = z.object({
  field: z.string().trim().min(1).max(160),
  code: ErrorCodeSchema,
  message: z.string().trim().min(1).max(500),
}).strict();

export const OperatorErrorEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  code: ErrorCodeSchema,
  safeMessage: z.string().trim().min(1).max(1_000),
  operatorDetail: z.string().trim().min(1).max(2_000).nullable(),
  retryable: z.boolean(),
  operationId: z.string().uuid().nullable(),
  requiredAction: z.string().trim().min(1).max(1_000).nullable(),
  fieldErrors: z.array(FieldErrorSchema),
  dependencies: z.array(ErrorDependencySchema),
}).strict();

export type OperatorErrorEnvelope = z.infer<typeof OperatorErrorEnvelopeSchema>;

export type OperatorErrorInput = Omit<OperatorErrorEnvelope, 'schemaVersion'>;

export function createOperatorError(input: OperatorErrorInput): OperatorErrorEnvelope {
  return OperatorErrorEnvelopeSchema.parse({ schemaVersion: 1, ...input });
}
