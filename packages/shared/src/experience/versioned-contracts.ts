import { z } from 'zod';

export const InternalContractHeaderSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid().nullable(),
  producer: z.enum(['bot', 'dashboard', 'launcher', 'portal', 'sdk', 'system']),
}).strict();

export type InternalContractHeader = z.infer<typeof InternalContractHeaderSchema>;

export function parseInternalContractHeader(value: unknown): InternalContractHeader | null {
  const result = InternalContractHeaderSchema.safeParse(value);
  return result.success ? result.data : null;
}
