import { z } from 'zod';

const operationIdSchema = z.string().uuid();
const DISCORD_REASON_LIMIT = 512;

export function paypalOperationHeaders(operationId: string): Readonly<Record<string, string>> {
  const parsedId = operationIdSchema.parse(operationId);
  return { 'PayPal-Request-Id': parsedId };
}

export function internalOperationHeaders(operationId: string): Readonly<Record<string, string>> {
  return { 'X-SomniBot-Operation-Id': operationIdSchema.parse(operationId) };
}

export function operationAuditFields(operationId: string): Readonly<{
  operation_id: string;
  correlation_id: string;
}> {
  const parsedId = operationIdSchema.parse(operationId);
  return { operation_id: parsedId, correlation_id: parsedId };
}

export function discordOperationReason(reason: string, operationId: string): string {
  const parsedId = operationIdSchema.parse(operationId);
  const suffix = ` [operation:${parsedId}]`;
  const available = DISCORD_REASON_LIMIT - suffix.length;
  return `${reason.trim().slice(0, available)}${suffix}`;
}

export function withOperationIdentity<T extends Readonly<Record<string, unknown>>>(
  payload: T,
  operationId: string,
): T & { readonly operation_id: string } {
  return { ...payload, operation_id: operationIdSchema.parse(operationId) };
}
