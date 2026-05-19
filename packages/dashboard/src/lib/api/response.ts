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

/** Return a 500 error, safely extracting the message. */
export function apiServerError(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : 'Internal server error';
  return apiError(message, 500);
}
