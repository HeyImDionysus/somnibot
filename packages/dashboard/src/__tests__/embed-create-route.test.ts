import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/admin-changes', () => ({ recordCrudChange: vi.fn().mockResolvedValue(undefined) }));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/embeds/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/embeds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    ctx: { guildId: 'guild-123', discordId: 'owner-123' },
  });
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
});

describe('POST /api/embeds', () => {
  it('persists the Embed Builder default color and null-normalized blank optional fields', async () => {
    const countChain = {
      select: vi.fn(),
      eq: vi.fn().mockResolvedValue({ count: 0 }),
    };
    countChain.select.mockReturnValue(countChain);

    const savedEmbed = { id: '3cb89e77-f0b1-4477-b0a0-2b2db30c3bf5', name: 'Community Roles' };
    const insertChain = {
      insert: vi.fn(),
      select: vi.fn(),
      single: vi.fn().mockResolvedValue({ data: savedEmbed, error: null }),
    };
    insertChain.insert.mockReturnValue(insertChain);
    insertChain.select.mockReturnValue(insertChain);
    mockFrom.mockReturnValueOnce(countChain).mockReturnValueOnce(insertChain);

    const response = await POST(createRequest({
      name: 'Community Roles',
      title: 'Choose Your Community Roles',
      description: 'Select the roles that match your interests. You can change your choices later.',
      color: 0x5865f2,
      fields: [],
      image_url: null,
      thumbnail_url: null,
      footer_text: null,
      footer_icon_url: null,
      author_name: null,
      author_url: null,
      author_icon_url: null,
      include_timestamp: false,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: savedEmbed });
    expect(insertChain.insert).toHaveBeenCalledWith(expect.objectContaining({
      guild_id: 'guild-123',
      name: 'Community Roles',
      color: 0x5865f2,
      image_url: null,
      thumbnail_url: null,
      footer_text: null,
      footer_icon_url: null,
      author_name: null,
      author_url: null,
      author_icon_url: null,
    }));
  });
});
