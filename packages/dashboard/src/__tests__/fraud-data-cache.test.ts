import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFraudJson, invalidateFraudCache } from '@/lib/fraud-data-cache';

function okJson(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn(async () => value),
  } as unknown as Response;
}

describe('fraud page read cache', () => {
  beforeEach(() => invalidateFraudCache());

  it('deduplicates concurrent requests and reuses the short-lived result', async () => {
    let resolveResponse!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchImpl = vi.fn(() => pending) as unknown as typeof fetch;

    const first = fetchFraudJson<{ value: number }>('/api/fraud/rules', { fetchImpl });
    const second = fetchFraudJson<{ value: number }>('/api/fraud/rules', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolveResponse(okJson({ value: 7 }));
    await expect(first).resolves.toEqual({ value: 7 });
    await expect(second).resolves.toEqual({ value: 7 });

    await expect(fetchFraudJson('/api/fraud/rules', { fetchImpl })).resolves.toEqual({ value: 7 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('invalidates by endpoint prefix and forceFresh bypasses a cached value', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okJson({ version: 1 }))
      .mockResolvedValueOnce(okJson({ version: 2 }))
      .mockResolvedValueOnce(okJson({ version: 3 })) as unknown as typeof fetch;

    await expect(fetchFraudJson('/api/fraud/rules', { fetchImpl })).resolves.toEqual({ version: 1 });
    await expect(fetchFraudJson('/api/fraud/rules', { fetchImpl, forceFresh: true })).resolves.toEqual({ version: 2 });

    invalidateFraudCache('/api/fraud/rules');
    await expect(fetchFraudJson('/api/fraud/rules', { fetchImpl })).resolves.toEqual({ version: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not cache failed responses', async () => {
    const failed = {
      ok: false,
      status: 503,
      json: vi.fn(async () => ({ error: 'database unavailable' })),
    } as unknown as Response;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(okJson({ success: true })) as unknown as typeof fetch;

    await expect(fetchFraudJson('/api/fraud/signals?', { fetchImpl })).rejects.toThrow('database unavailable');
    await expect(fetchFraudJson('/api/fraud/signals?', { fetchImpl })).resolves.toEqual({ success: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
