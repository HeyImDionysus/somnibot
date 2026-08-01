import { describe, expect, it, vi } from 'vitest';
import { fetchOptionalJsonArray } from '@/lib/optional-json';

describe('branding page optional embed data', () => {
  it('treats malformed optional embed JSON as unavailable', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: vi.fn(async () => {
        throw new SyntaxError('Unexpected token <');
      }),
    } as unknown as Response)) as unknown as typeof fetch;

    await expect(fetchOptionalJsonArray('/api/embeds', fetchImpl)).resolves.toEqual([]);
  });
});
