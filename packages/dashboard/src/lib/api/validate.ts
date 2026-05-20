/**
 * API Request Validation Middleware
 *
 * V17 Behavioral Audit — Item 8
 *
 * Provides Zod-based validation for API route handlers.
 * Usage:
 *   const body = await validateBody(request, myZodSchema);
 *   if (body instanceof NextResponse) return body; // validation error
 */

import { NextResponse } from 'next/server';
import { type ZodSchema, type ZodError } from 'zod';

/**
 * Parse and validate the JSON body of a request against a Zod schema.
 * Returns the validated data, or a NextResponse with a 400 error.
 */
export async function validateBody<T>(
  request: Request,
  schema: ZodSchema<T>,
): Promise<T | NextResponse> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const result = schema.safeParse(rawBody);
  if (!result.success) {
    const zodError = result.error as ZodError;
    const issues = zodError.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));

    return NextResponse.json(
      {
        error: 'Validation failed',
        issues,
      },
      { status: 400 },
    );
  }

  return result.data;
}

/**
 * Validate query parameters against a Zod schema.
 */
export function validateQuery<T>(
  url: URL | string,
  schema: ZodSchema<T>,
): T | NextResponse {
  const searchParams = typeof url === 'string' ? new URL(url).searchParams : url.searchParams;
  const params: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    params[key] = value;
  });

  const result = schema.safeParse(params);
  if (!result.success) {
    const zodError = result.error as ZodError;
    const issues = zodError.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));

    return NextResponse.json(
      {
        error: 'Invalid query parameters',
        issues,
      },
      { status: 400 },
    );
  }

  return result.data;
}
