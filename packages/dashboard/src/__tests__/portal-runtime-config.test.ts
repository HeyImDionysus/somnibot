import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/discord-runtime-config', () => ({ getDiscordRuntimeConfig: vi.fn() }));

import { GET } from '@/app/api/portal/config/route';
import { getDiscordRuntimeConfig } from '@/lib/discord-runtime-config';

describe('GET /api/portal/config', () => {
  beforeEach(() => {
    vi.mocked(getDiscordRuntimeConfig).mockReset();
  });

  it('returns the authoritative installation Discord application ID', async () => {
    vi.mocked(getDiscordRuntimeConfig).mockResolvedValue({
      applicationId: '123456789012345678',
      botToken: 'token',
      clientSecret: 'secret',
      sources: { applicationId: 'saved', botToken: 'saved', clientSecret: 'saved' },
    });

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
      vi.mocked(getDiscordRuntimeConfig).mockResolvedValue({
        applicationId,
        botToken: 'token',
        clientSecret: 'secret',
        sources: { applicationId: 'env', botToken: 'env', clientSecret: 'env' },
      });

      const response = await GET();

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: 'Customer portal sign-in is not configured.',
      });
    },
  );

  it('fails closed when saved configuration cannot be read', async () => {
    vi.mocked(getDiscordRuntimeConfig).mockRejectedValue(new Error('database unavailable'));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Customer portal sign-in is temporarily unavailable.',
    });
  });
});
