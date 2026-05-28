/**
 * Tests for API request validation middleware.
 *
 * Validates that Zod-based body and query validation returns proper 400
 * responses with structured issue details, and passes through valid data.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateBody, validateQuery } from '@/lib/api/validate';
import { NextResponse } from 'next/server';

const TestSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
});

describe('validateBody', () => {
  it('returns parsed data for valid JSON body', async () => {
    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', age: 30 }),
    });

    const result = await validateBody(request, TestSchema);
    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('returns 400 for invalid JSON', async () => {
    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{',
    });

    const result = await validateBody(request, TestSchema);
    expect(result).toBeInstanceOf(NextResponse);
    const res = result as NextResponse;
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON body');
  });

  it('returns 400 with issues for schema validation failure', async () => {
    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', age: -5 }),
    });

    const result = await validateBody(request, TestSchema);
    expect(result).toBeInstanceOf(NextResponse);
    const res = result as NextResponse;
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Validation failed');
    expect(body.issues).toBeInstanceOf(Array);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0]).toHaveProperty('path');
    expect(body.issues[0]).toHaveProperty('message');
  });

  it('returns 400 when required fields are missing', async () => {
    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const result = await validateBody(request, TestSchema);
    expect(result).toBeInstanceOf(NextResponse);
    const res = result as NextResponse;
    const body = await res.json();
    expect(body.error).toBe('Validation failed');
    expect(body.issues.length).toBe(2); // name and age both missing
  });
});

describe('validateQuery', () => {
  const QuerySchema = z.object({
    page: z.string().regex(/^\d+$/),
    search: z.string().optional(),
  });

  it('returns parsed params for valid query string', () => {
    const result = validateQuery('http://localhost/api/test?page=1&search=hello', QuerySchema);
    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual({ page: '1', search: 'hello' });
  });

  it('accepts URL object as input', () => {
    const url = new URL('http://localhost/api/test?page=5');
    const result = validateQuery(url, QuerySchema);
    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual({ page: '5' });
  });

  it('returns 400 with issues for invalid query params', () => {
    const result = validateQuery('http://localhost/api/test?page=abc', QuerySchema);
    expect(result).toBeInstanceOf(NextResponse);
  });

  it('returns structured issue details on failure', async () => {
    const result = validateQuery('http://localhost/api/test?page=abc', QuerySchema);
    expect(result).toBeInstanceOf(NextResponse);
    const res = result as NextResponse;
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid query parameters');
    expect(body.issues).toBeInstanceOf(Array);
  });
});
