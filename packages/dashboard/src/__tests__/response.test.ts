/**
 * Tests for standardized API response helpers.
 *
 * Verifies consistent response shapes across success, error, and server
 * error cases — the contract every API route relies on.
 */
import { describe, it, expect } from 'vitest';
import { apiSuccess, apiError, apiServerError } from '@/lib/api/response';

describe('apiSuccess', () => {
  it('returns a 200 JSON response with success: true and data', async () => {
    const res = apiSuccess({ id: 1, name: 'test' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ success: true, data: { id: 1, name: 'test' } });
  });

  it('merges extra fields into the response', async () => {
    const res = apiSuccess([], { total: 42, page: 2 });
    const body = await res.json();
    expect(body).toEqual({ success: true, data: [], total: 42, page: 2 });
  });

  it('handles null data', async () => {
    const res = apiSuccess(null);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: null });
  });
});

describe('apiError', () => {
  it('returns 400 by default with error message', async () => {
    const res = apiError('Invalid input');
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'Invalid input' });
  });

  it('accepts a custom status code', async () => {
    const res = apiError('Not found', 404);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'Not found' });
  });

  it('returns 403 for forbidden errors', async () => {
    const res = apiError('Forbidden', 403);
    expect(res.status).toBe(403);
  });
});

describe('apiServerError', () => {
  it('extracts message from Error instances', async () => {
    const res = apiServerError(new Error('DB connection failed'));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'DB connection failed' });
  });

  it('returns generic message for non-Error values', async () => {
    const res = apiServerError('string error');
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'Internal server error' });
  });

  it('returns generic message for null/undefined', async () => {
    const res = apiServerError(null);
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
  });
});
