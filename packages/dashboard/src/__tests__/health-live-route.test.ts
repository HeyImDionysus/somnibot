import { describe, expect, it } from 'vitest';
import { GET } from '@/app/api/health/live/route';

describe('GET /api/health/live', () => {
  it('reports only dashboard process liveness', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('alive');
    expect(typeof body.timestamp).toBe('string');
    expect(body.services).toBeUndefined();
  });
});
