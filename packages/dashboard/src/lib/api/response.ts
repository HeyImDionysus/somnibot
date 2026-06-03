/**
 * Standardized API response helpers.
 *
 * All API routes should use these to ensure consistent response shapes:
 * - Success: { success: true, data: T, ...extras }
 * - Error:   { success: false, error: string }
 *
 * This makes client-side error handling predictable across all pages.
 */
import { NextResponse } from 'next/server';

/** Return a success response with optional extra fields. */
export function apiSuccess<T>(data: T, extras?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ success: true, data, ...extras });
}

/** Return an error response with consistent shape. */
export function apiError(message: string, status: number = 400): NextResponse {
  return NextResponse.json({ success: false, error: message }, { status });
}

/**
 * Return a 500 error for a Supabase/Postgrest query failure.
 *
 * V11 Re-Audit N-1: Supabase errors expose internal schema details (table
 * names, constraint names, RPC signatures) in their `message` field.  We log
 * the real message server-side for debugging but return a generic string to
 * the client so internal details never leak over the wire.
 *
 * @param error - A Supabase PostgrestError (or any object with `.message`)
 * @param context - Short identifier for the route / operation (e.g. "GET /api/alerts")
 */
export function dbError(
  error: { message: string },
  context: string,
): NextResponse {
  console.error(`[${context}] DB error:`, error.message);
  return apiError('An internal error occurred', 500);
}

/**
 * Return a 500 error, safely extracting the message.
 *
 * V11 Re-Audit N-1: Like dbError, log the real message server-side but
 * return a generic string to the client.
 */
export function apiServerError(err: unknown, context?: string): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${context ?? 'api'}] Server error:`, message);
  return apiError('An internal error occurred', 500);
}
