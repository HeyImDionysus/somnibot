import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AchievementsManager } from '../features/achievements/achievements-manager.js';

type ReplyPayload = {
  readonly embeds?: readonly { readonly data?: { readonly description?: string } }[];
};

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input);
}

describe('achievement dependency degradation', () => {
  it('gives a branded unavailable response and raises an owner alert when prestige config is unreadable', async () => {
    // Given: the achievement dependency cannot read guild configuration.
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = requestUrl(input);
      if (url.includes('/guild_config?')) {
        return Response.json({ code: '08006', message: 'database offline' }, { status: 503 });
      }
      return Response.json([], { status: 201 });
    });
    const supabase = createClient('http://supabase.test', 'test-key', {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: fetchMock },
    });
    const reply = vi.fn<(payload: ReplyPayload) => Promise<void>>(async () => undefined);
    const command = {
      id: 'interaction-1',
      guildId: 'guild-1',
      guild: { name: 'Night Owls' },
      user: { id: 'user-1' },
      reply,
    };
    const manager = new AchievementsManager(supabase);

    // When: the member tries to prestige during the outage.
    await Reflect.apply(manager.prestige, manager, [command]);

    // Then: no mutation is attempted, the member sees the guild-branded fallback,
    // and the owner receives an observable degradation alert.
    const requestedUrls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
    expect(requestedUrls.some((url) => url.includes('/rpc/economy_prestige_apply'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/alerts'))).toBe(true);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
    const response = reply.mock.calls[0]?.[0];
    expect(response?.embeds?.[0]?.data?.description).toContain("Night Owls's achievements are temporarily unavailable");
  });
});
