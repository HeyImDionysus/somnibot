import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/portal/config/route';

describe('GET /api/portal/config', () => {
  afterEach(() => {
    delete process.env.DISCORD_APPLICATION_ID;
  });

  it('returns the installation Discord application ID from the live runtime', async () => {
    process.env.DISCORD_APPLICATION_ID = '123456789012345678';

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { discord_application_id: '123456789012345678' },
    });
  });

  it.each(['', 'not-a-discord-id', '1234'])(
    'fails clearly instead of emitting a broken OAuth link for %j',
    async (applicationId) => {
      process.env.DISCORD_APPLICATION_ID = applicationId;

      const response = await GET();

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: 'Customer portal sign-in is not configured.',
      });
    },
  );
});
