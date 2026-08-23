import { z } from 'zod';
import {
  TenantScopeSchema,
  evaluateTenantAccess,
} from './data-governance.js';

const CacheResourceIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const TenantCacheEnvelopeSchema = z.object({
  scope: TenantScopeSchema,
  resourceId: CacheResourceIdSchema,
  payload: z.unknown(),
}).strict();

export type TenantExecutionResult<T> =
  | { readonly status: 'executed'; readonly value: T }
  | { readonly status: 'denied'; readonly reason: 'guild_mismatch' | 'customer_mismatch' };

export type TenantCacheResult<T> =
  | { readonly status: 'hit'; readonly value: T }
  | { readonly status: 'invalid' }
  | { readonly status: 'denied'; readonly reason: 'guild_mismatch' | 'customer_mismatch' };

export async function executeTenantScoped<T>(
  actorInput: z.input<typeof TenantScopeSchema>,
  resourceInput: Parameters<typeof evaluateTenantAccess>[1],
  execute: () => Promise<T>,
): Promise<TenantExecutionResult<T>> {
  const access = evaluateTenantAccess(actorInput, resourceInput);
  if (!access.allowed) return { status: 'denied', reason: access.reason };
  return { status: 'executed', value: await execute() };
}

export function serializeTenantCacheValue<T>(
  scopeInput: z.input<typeof TenantScopeSchema>,
  resourceIdInput: string,
  payload: T,
): string {
  const scope = TenantScopeSchema.parse(scopeInput);
  const resourceId = CacheResourceIdSchema.parse(resourceIdInput);
  return JSON.stringify({ scope, resourceId, payload });
}

export function parseTenantCacheValue<T>(
  raw: string,
  actorInput: z.input<typeof TenantScopeSchema>,
  payloadSchema: z.ZodType<T>,
): TenantCacheResult<T> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 'invalid' };
    throw error;
  }

  const envelope = TenantCacheEnvelopeSchema.safeParse(decoded);
  if (!envelope.success) return { status: 'invalid' };
  const access = evaluateTenantAccess(actorInput, {
    ...envelope.data.scope,
    resourceType: 'cache-entry',
    resourceId: envelope.data.resourceId,
  });
  if (!access.allowed) return { status: 'denied', reason: access.reason };

  const payload = payloadSchema.safeParse(envelope.data.payload);
  if (!payload.success) return { status: 'invalid' };
  return { status: 'hit', value: payload.data };
}
